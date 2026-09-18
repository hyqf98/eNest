/**
 * clipboardHistory — 剪贴板历史轮询与落盘
 * 职责：按需 500ms 轮询文本/图片指纹，变化则入史；图片 blob 落盘；供插件 list/get/回写。
 * 按需启停：仅当存在「已安装/开发态且启用且声明 clipboard.history 权限」的插件时才轮询
 *           （revalidateClipboardPolling；index.ts 在 registry scan 后调用，
 *            插件 install/uninstall/enable/disable 路径亦应调用重算）。
 * 图片降本：剪贴板持续是同一张图时，先做廉价指纹（toBitmap 字节数 + 采样字节）比对，
 *           指纹未变则跳过 toPNG 全量 + sha1。
 */
import { clipboard, nativeImage } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getAppPaths } from '@main/paths/pathsService'
import type { PluginPermission } from '@shared/types/plugin'
import type { ClipboardHistoryEntry } from '@shared/types/plugin'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { logInfo, logWarn } from '@main/logs/logService'

const MAX_ITEMS = 200
const POLL_MS = 500
const TEXT_PREVIEW_MAX = 120

interface StoredEntry extends ClipboardHistoryEntry {
  /** type=image 时的 blob 相对文件名 */
  blobFile?: string
  /** 图片内容指纹，仅内存去重用 */
  hash?: string
}

let timer: NodeJS.Timeout | null = null
let lastTextHash = ''
/** 上一张入史图片的 PNG 全量 sha1（与 StoredEntry.hash 同源，用于史内去重） */
let lastImageHash = ''
/**
 * 上一张入史图片的廉价指纹（bitmap 字节数 + 采样字节）。
 * 轮询降本：指纹未变 → 跳过 toPNG 全量 + sha1；指纹变化 → 走完整入库。
 */
let lastImageFingerprint = ''
let entries: StoredEntry[] = []
let loaded = false
let loadPromise: Promise<void> | null = null
let writeQueue: Promise<void> = Promise.resolve()

const MAX_IMAGE_BYTES = 8 * 1024 * 1024

function historyFile(): string {
  return join(getAppPaths().data, 'clipboard-history.json')
}

function blobsDir(): string {
  return join(getAppPaths().data, 'clipboard-blobs')
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const file = historyFile()
        if (existsSync(file)) {
          const raw = JSON.parse(await readFile(file, 'utf-8'))
          if (Array.isArray(raw)) entries = raw as StoredEntry[]
        }
      } catch {
        entries = []
        logWarn('clipboard', 'history file corrupt, reset')
      } finally {
        loaded = true
      }
    })()
  }
  await loadPromise
}

function persist(): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    try {
      const file = historyFile()
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      await writeFile(tmp, JSON.stringify(entries, null, 2), 'utf-8')
      await rename(tmp, file)
    } catch (err) {
      logWarn('clipboard', `persist history failed: ${(err as Error).message}`)
    }
  })
  return writeQueue
}

function textHash(t: string): string {
  return createHash('sha1').update(t).digest('hex')
}

function imageHash(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex')
}

/** 指纹采样步长：每 64KB 取 1 字节，采样总量有上界（16MB 图约 256 字节） */
const FINGERPRINT_STRIDE = 64 * 1024
const FINGERPRINT_MAX_SAMPLES = 512

/**
 * 廉价图片指纹：bitmap 字节数 + 全程等距采样字节。
 * toBitmap() 是原始 BGRA 位图，编解码开销低于 toPNG，且同一张图字节级稳定；
 * 尺寸不同 → 长度必不同；同长度不同内容 → 采样几乎必命中差异。
 * 注意：PNG 编码层面不同的两份同源位图（压缩参数差异）指纹相同，恰好是我们要的「视为同一张」。
 */
function imageFingerprint(img: Electron.NativeImage): string {
  const bitmap = img.toBitmap()
  const total = bitmap.byteLength
  const samples: number[] = []
  const count = Math.min(FINGERPRINT_MAX_SAMPLES, Math.ceil(total / FINGERPRINT_STRIDE))
  for (let i = 0; i < count; i++) {
    samples.push(bitmap[i * FINGERPRINT_STRIDE])
  }
  return `${total}:${samples.join(',')}`
}

function publicEntry(e: StoredEntry): ClipboardHistoryEntry {
  const { blobFile: _b, hash: _h, ...rest } = e
  return rest
}

async function pushText(text: string): Promise<void> {
  const hash = textHash(text)
  lastTextHash = hash
  lastImageHash = ''
  lastImageFingerprint = ''
  const existing = entries.find((e) => e.type === 'text' && e.text === text)
  if (existing) {
    existing.ts = Date.now()
    // 移到最前
    entries = [existing, ...entries.filter((e) => e.id !== existing.id)]
  } else {
    const entry: StoredEntry = {
      id: randomUUID(),
      type: 'text',
      preview:
        text.length > TEXT_PREVIEW_MAX
          ? `${text.slice(0, TEXT_PREVIEW_MAX)}…`
          : text,
      text,
      ts: Date.now(),
      pinned: false,
      bytes: Buffer.byteLength(text, 'utf-8')
    }
    entries.unshift(entry)
  }
  await trimAndPersist()
}

async function pushImage(image: Electron.NativeImage, fingerprint: string): Promise<void> {
  // 先记指纹：超大图跳过入库后，后续轮询仍可凭指纹避免 toPNG 全量 + sha1
  lastImageFingerprint = fingerprint
  const png = image.toPNG()
  if (png.length > MAX_IMAGE_BYTES) {
    logWarn('clipboard', `skip oversized image ${png.length} bytes`)
    return
  }
  const hash = imageHash(png)
  lastImageHash = hash
  lastTextHash = ''
  const dup = entries.find((e) => e.type === 'image' && e.hash === hash)
  if (dup) {
    dup.ts = Date.now()
    entries = [dup, ...entries.filter((e) => e.id !== dup.id)]
    await trimAndPersist()
    return
  }

  const id = randomUUID()
  const blobName = `${id}.png`
  const dir = blobsDir()
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, blobName), png)
  const { width, height } = image.getSize()
  const entry: StoredEntry = {
    id,
    type: 'image',
    preview: `${width}×${height}`,
    hasImage: true,
    width,
    height,
    ts: Date.now(),
    pinned: false,
    bytes: png.length,
    blobFile: blobName,
    hash
  }
  entries.unshift(entry)
  await trimAndPersist()
}

async function trimAndPersist(): Promise<void> {
  const pinned = entries.filter((e) => e.pinned)
  const rest = entries.filter((e) => !e.pinned)
  const keepRest = Math.max(0, MAX_ITEMS - pinned.length)
  const next = [...pinned, ...rest.slice(0, keepRest)]
  // 清理被挤出的图片 blob
  const keptIds = new Set(next.map((e) => e.id))
  for (const e of entries) {
    if (!keptIds.has(e.id) && e.blobFile) {
      void import('node:fs/promises').then((fs) =>
        fs.rm(join(blobsDir(), e.blobFile!), { force: true }).catch(() => {})
      )
    }
  }
  entries = next
  await persist()
}

async function pollOnce(): Promise<void> {
  await ensureLoaded()
  try {
    const hasImage = clipboard.availableFormats().some((f) => f.includes('image'))
    if (hasImage) {
      const img = clipboard.readImage()
      if (!img.isEmpty()) {
        // 廉价指纹优先：剪贴板持续是同一张图时，避免每轮 toPNG 全量 + sha1
        const fp = imageFingerprint(img)
        if (fp !== lastImageFingerprint || lastTextHash) {
          await pushImage(img, fp)
          logInfo('clipboard', 'history captured image')
        }
        return
      }
    }
    const text = clipboard.readText()
    if (text && textHash(text) !== lastTextHash) {
      await pushText(text)
      logInfo('clipboard', `history captured text (${text.length})`)
    }
  } catch (err) {
    logWarn('clipboard', `poll failed: ${(err as Error).message}`)
  }
}

/**
 * 是否存在消费方插件：installed（rootPath 存在，或 dev 开发态）且未禁用，
 * 且 manifest permissions 声明 clipboard.history。
 */
export function clipboardPollingWanted(): boolean {
  try {
    return pluginRegistry
      .list()
      .some(
        (p) =>
          p.installed !== false &&
          (Boolean(p.rootPath) || p.dev === true) &&
          p.enabled !== false &&
          (p.permissions ?? []).includes('clipboard.history' as PluginPermission)
      )
  } catch {
    // registry 异常时保守起见不轮询（历史数据保留，仅暂停采集）
    return false
  }
}

/**
 * 按需启停轮询：满足消费条件 → 确保 interval 已启动；否则停轮询（历史数据保留）。
 * index.ts 在 registry scan 完成后调用；插件 install/uninstall/enable/disable 后也应重算。
 */
export function revalidateClipboardPolling(): void {
  if (clipboardPollingWanted()) {
    if (!timer) startClipboardHistory()
  } else if (timer) {
    stopClipboardHistory()
    logInfo('clipboard', 'polling stopped (no enabled plugin holds clipboard.history)')
  }
}

export function startClipboardHistory(): void {
  if (timer) return
  void ensureLoaded()
  // 启动（含停后重启）时对齐当前剪贴板，避免把启动前/停轮询期间的内容整段灌入
  try {
    const t = clipboard.readText()
    if (t) lastTextHash = textHash(t)
    const img = clipboard.readImage()
    if (!img.isEmpty()) {
      lastImageHash = imageHash(img.toPNG())
      lastImageFingerprint = imageFingerprint(img)
    }
  } catch {
    // ignore
  }
  timer = setInterval(() => void pollOnce(), POLL_MS)
}

export function stopClipboardHistory(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

export async function listHistory(limit = 100): Promise<ClipboardHistoryEntry[]> {
  await ensureLoaded()
  return entries.slice(0, Math.max(1, Math.min(MAX_ITEMS, limit))).map(publicEntry)
}

export async function getHistoryEntry(id: string): Promise<(ClipboardHistoryEntry & { dataUrl?: string }) | null> {
  await ensureLoaded()
  const e = entries.find((x) => x.id === id)
  if (!e) return null
  const base = publicEntry(e)
  if (e.type === 'image' && e.blobFile) {
    try {
      const buf = await readFile(join(blobsDir(), e.blobFile))
      return { ...base, dataUrl: `data:image/png;base64,${buf.toString('base64')}` }
    } catch {
      return base
    }
  }
  return base
}

export async function removeHistoryEntry(id: string): Promise<boolean> {
  await ensureLoaded()
  const idx = entries.findIndex((e) => e.id === id)
  if (idx < 0) return false
  const [rm] = entries.splice(idx, 1)
  if (rm.blobFile) {
    void import('node:fs/promises').then((fs) =>
      fs.rm(join(blobsDir(), rm.blobFile!), { force: true }).catch(() => {})
    )
  }
  await persist()
  return true
}

export async function clearHistory(): Promise<boolean> {
  await ensureLoaded()
  // 保留置顶条目
  const removed = entries.filter((e) => !e.pinned)
  entries = entries.filter((e) => e.pinned)
  await persist()
  for (const e of removed) {
    if (e.blobFile) {
      void import('node:fs/promises').then((fs) =>
        fs.rm(join(blobsDir(), e.blobFile!), { force: true }).catch(() => {})
      )
    }
  }
  return true
}

export async function togglePinHistoryEntry(id: string): Promise<ClipboardHistoryEntry> {
  await ensureLoaded()
  const e = entries.find((x) => x.id === id)
  if (!e) throw new Error(`history entry not found: ${id}`)
  e.pinned = !e.pinned
  await persist()
  return publicEntry(e)
}

/** 主动推送：插件写入剪贴板后不必等轮询 */
export function noteExternalText(text: string): void {
  lastTextHash = textHash(text)
  lastImageHash = ''
  lastImageFingerprint = ''
}

/**
 * 剪贴板历史搜索（Quick 内置搜索 provider 消费）。
 * 壳子自身能力：不受插件 clipboard.history 权限门控 —— 只有启用剪贴板
 * 历史轮询（存在声明该权限的启用插件）时才有数据，天然自洽。
 * 文本条目按 preview/text 前缀与包含打分；图片条目按尺寸摘要弱匹配。
 */
export async function searchHistory(
  query: string,
  limit = 6
): Promise<ClipboardHistoryEntry[]> {
  const q = (query || '').trim().toLowerCase()
  await ensureLoaded()
  if (!q) return []
  const scored: Array<{ entry: ClipboardHistoryEntry; score: number }> = []
  for (const e of entries) {
    let score = 0
    if (e.type === 'text') {
      const text = (e.text || e.preview || '').toLowerCase()
      const preview = (e.preview || '').toLowerCase()
      if (preview.startsWith(q)) score = 60
      else if (preview.includes(q)) score = 40
      else if (text.startsWith(q)) score = 50
      else if (text.includes(q)) score = 30
    } else {
      const meta = `${e.width ?? ''}x${e.height ?? ''} ${e.preview}`.toLowerCase()
      if (meta.includes(q)) score = 12
    }
    if (score > 0) {
      // 置顶与新鲜度轻微加权
      if (e.pinned) score += 6
      score += Math.max(0, 4 - Math.floor((Date.now() - e.ts) / (24 * 60 * 60 * 1000)))
      scored.push({ entry: publicEntry(e), score })
    }
  }
  scored.sort((a, b) => b.score - a.score || b.entry.ts - a.entry.ts)
  return scored.slice(0, Math.max(1, Math.min(20, limit))).map((s) => s.entry)
}

export function noteExternalImage(image: Electron.NativeImage): void {
  if (!image.isEmpty()) {
    lastImageHash = imageHash(image.toPNG())
    lastImageFingerprint = imageFingerprint(image)
    lastTextHash = ''
  }
}

export { nativeImage }
