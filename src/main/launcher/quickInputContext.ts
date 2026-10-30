/**
 * quickInputContext — 宿主保管的 Quick 粘贴上下文（图片/文件）
 * 职责：按会话保存剪贴板/DOM 粘贴的图片字节与文件真实路径，向渲染层与主题仅发布有界缩略图；
 * 启动插件时按不透明 id 组装 enter.input，文件经只读 LocalFileHandle 授予链签发。
 * 生命周期：Quick 隐藏、插件退场、打开成功、上下文移除时清理；退出随进程消失。
 */
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { lstat, realpath, stat } from 'node:fs/promises'
import { clipboard, nativeImage } from 'electron'
import type { QuickEnterInput, QuickImageContext, QuickInputSelection } from '@shared/types/quick'
import { readNativeFiles } from '@main/clipboard/nativeClipboard'

const MAX_IMAGES = 8
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_TOTAL_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_FILES = 20
const THUMBNAIL_SIZE = 128
const MAX_THUMBNAIL_BYTES = 64 * 1024
const DATA_URL_RE = /^data:image\/(?:png|jpeg|webp|gif);base64,([a-z0-9+/=]+)$/i

interface StoredImage { id: string; dataUrl: string; width: number; height: number; bytes: number; thumbnail: string }
interface StoredFile { id: string; path: string; name: string; size: number; kind: 'file' | 'directory'; thumbnail: string }

/** Each native surface owns its clipboard queue, opaque IDs and byte budget. */
export function createSearchInputSession() {
  const images = new Map<string, StoredImage>()
  const files = new Map<string, StoredFile>()
  let contextEpoch = 0
  let inputRevision = 0
  let pasteQueue: Promise<void> = Promise.resolve()
  let pendingPastes = 0

  function imageThumbnail(image: Electron.NativeImage): string {
    const { width, height } = image.getSize()
    for (let edge = THUMBNAIL_SIZE; edge >= 1; edge = Math.floor(edge / 2)) {
      const scale = Math.min(1, edge / Math.max(width, height))
      const thumbnail = (scale < 1 ? image.resize({
        width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'best'
      }) : image).toDataURL()
      if (thumbnail.length <= MAX_THUMBNAIL_BYTES) return thumbnail
    }
    throw new Error('Quick thumbnail exceeds transfer limit')
  }

  function fileGlyph(kind: 'file' | 'directory'): string {
    // Small inline SVG thumbnail so the context strip stays purely data-URL based.
    const body = kind === 'directory'
      ? '<path d="M4 8h6l2 2h8v10H4z"/>'
      : '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>'
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="%238fa3b8" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
    return `data:image/svg+xml,${svg}`
  }

  const imageBytes = (dataUrl: string): number => {
    const match = DATA_URL_RE.exec(dataUrl)
    if (!match) return -1
    return Math.floor(match[1].length * 3 / 4)
  }

  function addQuickImage(dataUrl: string): QuickImageContext | null {
    if (images.size >= MAX_IMAGES) return null
    const bytes = imageBytes(String(dataUrl ?? ''))
    if (bytes < 0 || bytes > MAX_IMAGE_BYTES) return null
    let total = 0
    for (const existing of images.values()) total += existing.bytes
    if (total + bytes > MAX_TOTAL_IMAGE_BYTES) return null
    const source = nativeImage.createFromDataURL(dataUrl)
    if (source.isEmpty()) return null
    const size = source.getSize()
    const id = randomUUID()
    const stored: StoredImage = { id, dataUrl, width: size.width, height: size.height, bytes, thumbnail: imageThumbnail(source) }
    images.set(id, stored)
    inputRevision++
    return project(stored)
  }

  /** Validate a renderer- or clipboard-supplied absolute path before entering the context. */
  async function admitPath(path: string): Promise<StoredFile | null> {
    if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4_096) return null
    try {
      const link = await lstat(path)
      if (link.isSymbolicLink()) return null
      if (!link.isFile() && !link.isDirectory()) return null
      const canonical = await realpath(path)
      const info = await stat(canonical)
      return {
        id: randomUUID(), path: canonical, name: canonical.split(/[\\/]/).pop() ?? canonical,
        size: info.isDirectory() ? 0 : info.size, kind: info.isDirectory() ? 'directory' : 'file',
        thumbnail: fileGlyph(info.isDirectory() ? 'directory' : 'file')
      }
    } catch { return null }
  }

  /** Each clipboard/DOM file paste supersedes the previous file set (documented paste semantics). */
  async function addQuickFiles(paths: string[], epoch: number): Promise<QuickImageContext[]> {
    const next: StoredFile[] = []
    for (const path of Array.isArray(paths) ? paths.slice(0, MAX_FILES) : []) {
      if (epoch !== contextEpoch) return []
      const stored = await admitPath(path)
      if (stored) next.push(stored)
    }
    if (epoch !== contextEpoch) return []
    for (const stale of [...files.values()]) files.delete(stale.id)
    for (const stored of next) files.set(stored.id, stored)
    inputRevision++
    return next.map(projectFile)
  }

  type ClipboardKind = 'image' | 'files' | 'text'

  /** Electron 44：readImage 移除，经 read() → ClipboardItem(Blob) 重建位图。 */
  async function readClipboardKind(): Promise<{ kind: ClipboardKind; image?: Electron.NativeImage; paths?: string[] }> {
    const items = await clipboard.read()
    for (const item of items) {
      const type = item.types.find(t => t.startsWith('image/'))
      if (!type) continue
      const blob = (await item.getType(type)) as Blob
      const buffer = Buffer.from(await blob.arrayBuffer())
      if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) return { kind: 'text' }
      const image = nativeImage.createFromBuffer(buffer)
      return image.isEmpty() ? { kind: 'text' } : { kind: 'image', image }
    }
    const paths = await readNativeFiles().catch(() => [] as string[])
    if (paths.length) return { kind: 'files', paths }
    return { kind: 'text' }
  }

  /** Paste events can land one tick before the OS clipboard updates; retry while the kind is still plain text. */
  async function readClipboardStable(epoch: number): Promise<Awaited<ReturnType<typeof readClipboardKind>>> {
    let result = await readClipboardKind().catch(() => ({ kind: 'text' }) as Awaited<ReturnType<typeof readClipboardKind>>)
    if (result.kind !== 'text') return result
    for (let attempt = 0; attempt < 3 && result.kind === 'text' && epoch === contextEpoch; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 60))
      if (epoch !== contextEpoch) break
      result = await readClipboardKind().catch(() => ({ kind: 'text' }) as Awaited<ReturnType<typeof readClipboardKind>>)
    }
    return result
  }

  async function readClipboardIntoContext(): Promise<QuickImageContext[]> {
    if (pendingPastes >= MAX_IMAGES) return []
    pendingPastes++
    const epoch = contextEpoch, previous = pasteQueue
    let release!: () => void
    pasteQueue = new Promise(resolve => { release = resolve })
    try {
      // Capture each paste immediately, but commit in request order so images accumulate
      // and a slower file read cannot replace a newer paste. Clear/hide retires the queue.
      const [result] = await Promise.all([readClipboardStable(epoch), previous])
      if (epoch !== contextEpoch) return []
      if (result.kind === 'image' && result.image) {
        const context = addQuickImage(result.image.toDataURL())
        return context ? [context] : []
      }
      if (result.kind === 'files') return await addQuickFiles(result.paths ?? [], epoch)
      return []
    } finally {
      if (epoch === contextEpoch) pendingPastes--
      release()
    }
  }

  function project(entry: StoredImage): QuickImageContext {
    return { id: entry.id, kind: 'image', width: entry.width, height: entry.height, size: entry.bytes, thumbnail: entry.thumbnail }
  }
  function projectFile(entry: StoredFile): QuickImageContext {
    return { id: entry.id, kind: entry.kind, name: entry.name, size: entry.size, thumbnail: entry.thumbnail }
  }

  function listQuickInputContext(): QuickImageContext[] {
    return [...[...images.values()].map(project), ...[...files.values()].map(projectFile)].slice(0, 12)
  }

  function removeQuickInputContext(id?: string): QuickImageContext[] {
    if (id === undefined) clearQuickInputContext()
    else { const removed = images.delete(id) || files.delete(id); if (removed) inputRevision++ }
    return listQuickInputContext()
  }

  function clearQuickInputContext(): void {
    contextEpoch++
    inputRevision++
    pasteQueue = Promise.resolve()
    pendingPastes = 0
    images.clear()
    files.clear()
  }

  /** Resolve opaque session ids into the bounded enter payload. Unknown ids drop silently. */
  async function buildQuickEnterInput(pluginId: string, selection: QuickInputSelection | undefined, assertCurrent?: () => void): Promise<QuickEnterInput | undefined> {
    if (!selection || typeof selection !== 'object') return undefined
    const epoch = inputRevision
    const current = () => {
      if (epoch !== inputRevision) throw new Error('Search input session retired')
      assertCurrent?.()
    }
    current()
    const input: QuickEnterInput = {}
    if (typeof selection.text === 'string' && selection.text.trim()) input.text = selection.text.slice(0, 4_096)
    const ids = (value: unknown): string[] => Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length <= 64).slice(0, MAX_FILES) : []
    const pickedImages = [...new Set(ids(selection.imageIds))].map(id => images.get(id)).filter((entry): entry is StoredImage => Boolean(entry))
    if (pickedImages.length) input.images = pickedImages.map(entry => ({ dataUrl: entry.dataUrl, width: entry.width, height: entry.height }))
    const pickedFiles = [...new Set(ids(selection.fileIds))].map(id => files.get(id)).filter((entry): entry is StoredFile => Boolean(entry))
    if (pickedFiles.length) {
      // Dynamic import keeps localFiles (and its createQuickWindow edge) out of the module cycle.
      const { grantLocalFile } = await import('@main/plugin/localFiles')
      current()
      const granted: NonNullable<QuickEnterInput['files']> = []
      for (const entry of pickedFiles) {
        // Revalidate at launch time; a deleted or replaced path must not reach the plugin.
        const fresh = await admitPath(entry.path)
        current()
        if (!fresh) continue
        try {
          const handle = await grantLocalFile(pluginId, fresh.path, { writable: false }, current)
          current()
          granted.push({ handleId: handle.id, path: fresh.path, name: fresh.name, size: fresh.size, kind: fresh.kind })
        } catch { current() /* grant budget exhausted or path changed; drop this entry */ }
      }
      if (granted.length) input.files = granted
    }
    current()
    return input.images || input.files || input.text ? input : undefined
  }


  return { readClipboard: readClipboardIntoContext, list: listQuickInputContext, remove: removeQuickInputContext, clear: clearQuickInputContext, build: buildQuickEnterInput, get epoch() { return inputRevision } }
}

const quickSession = createSearchInputSession()
export const readClipboardIntoContext = quickSession.readClipboard
export const listQuickInputContext = quickSession.list
export const removeQuickInputContext = quickSession.remove
export const clearQuickInputContext = quickSession.clear
export const buildQuickEnterInput = quickSession.build
export const getQuickInputEpoch = (): number => quickSession.epoch
const issuedInputs = new Map<string, { generation: number; input: QuickEnterInput }>()

/** Remember what a plugin was launched with, for quickInput.readContext() while it owns the Quick window. */
export function rememberQuickEnterInput(pluginId: string, generation: number, input: QuickEnterInput | undefined): void {
  if (input) issuedInputs.set(pluginId, { generation, input })
  else issuedInputs.delete(pluginId)
}

export function readQuickEnterInput(pluginId: string, generation: number): QuickEnterInput | null {
  const entry = issuedInputs.get(pluginId)
  return entry && entry.generation === generation ? entry.input : null
}

export function forgetQuickEnterInput(pluginId: string): void { issuedInputs.delete(pluginId) }
