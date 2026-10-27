import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, linkSync, unlinkSync } from 'node:fs'
import { copyFile, mkdir, open, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path'
import { dialog } from 'electron'
import { trackNativeInteraction } from '@main/plugin/pluginInteractionPolicy'
import { FONTS_DIR } from '@shared/constants'
import { isPluginAssetPath } from '@shared/pluginContract'
import { isSafeAppearanceBackgroundColor, isSafePalettePaint } from '@shared/theme/defaultTheme/backgroundPalettes'
import { themeProfileKey } from '@shared/theme/appearance'
import { BUILTIN_THEME_PACKS } from '@shared/theme/builtinThemes'
import type { AppearanceFonts, ThemePackV2 } from '@shared/types/appearance'
import type { BackgroundConfig, CustomFontMeta } from '@shared/types/plugin'
import { getAppPathsRoot } from '@main/paths/pathsService'
import { settingsStore } from '@main/settings/SettingsStore'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { resolvePluginFile } from '@main/plugin/pluginPaths'
import { themePackRegistry } from '@main/theme/themePacks'

const MEDIA_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm' }
const FONT_MIME: Record<string, string> = { '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2' }
const MAX_MEDIA_BYTES = 128 * 1024 * 1024
const MAX_FONT_BYTES = 5 * 1024 * 1024
const COMPAT_MEDIA_MIME: Record<string, string> = { ...MEDIA_MIME, '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mov': 'video/quicktime' }
type MediaGrant = { value: string; type: 'image' | 'video'; path?: string; source?: string; asset?: string }
const mediaGrants = new Map<string, MediaGrant>()
const mediaSalt = randomUUID()

function selectedLegacyMedia(grant: MediaGrant): boolean {
  const { legacy, legacyBackup } = settingsStore.getAppearanceSettings()
  const selected = [legacy?.theme.background, legacy?.general?.splashBackground, legacyBackup?.theme.background, legacyBackup?.general.splashBackground]
  return selected.some(media => media?.value === grant.value && media.type === grant.type)
}

/**
 * Adapt selected legacy files and source-owned assets without publishing their paths.
 * `declaredPaints` carries the active pack's own validated palette paints: they already passed
 * the renderer allowlist at registration, so they may cross the bridge even though they are not
 * one of the eight host-authored atmospheres. Anything else stays rejected.
 */
export function publicAppearanceMedia(media: BackgroundConfig | null, declaredPaints?: ReadonlySet<string>): BackgroundConfig | null {
  if (!media) return null
  if (media.type === 'color') {
    // 声明集合只用来"额外放行"，不能豁免白名单本身：边界再跑一次安全画法检查。
    const allowed = isSafeAppearanceBackgroundColor(media.value) ||
      Boolean(declaredPaints?.has(media.value) && isSafePalettePaint(media.value))
    return allowed ? { ...media } : null
  }
  if (media.value === 'enest://appearance/legacy/background' || media.value === 'enest://appearance/legacy/splash') {
    const { legacy, legacyBackup } = settingsStore.getAppearanceSettings()
    const splash = media.value.endsWith('/splash')
    const selected = (splash ? [legacy?.general?.splashBackground, legacyBackup?.general.splashBackground] : [legacy?.theme.background, legacyBackup?.theme.background])
      .find(candidate => candidate?.type === media.type && candidate.value && !candidate.value.startsWith('enest://appearance/legacy/'))
    if (!selected?.value || (splash && selected.type !== 'image')) return null
    return publicAppearanceMedia({ ...media, value: selected.value })
  }
  if (media.type !== 'image' && media.type !== 'video') return null
  const publicId = media.value.match(/^enest:\/\/appearance\/media\/([a-f0-9]{64}\.(?:png|jpe?g|gif|webp|svg|ico|mp4|webm|mov))$/)?.[1]
  if (publicId) {
    const existing = mediaGrants.get(publicId)
    if (existing) {
      if (existing.type !== media.type || (existing.path && !selectedLegacyMedia(existing)) ||
        (existing.source && !pluginRegistry.getInstalledDescriptors().some(item => item.id === existing.source && item.enabled))) return null
      return { ...media }
    }
    // Compatibility extensions are capabilities, never arbitrary library filenames.
    return MEDIA_MIME[extname(publicId)]?.startsWith(`${media.type}/`) ? { ...media } : null
  }
  let grant: MediaGrant
  if (isAbsolute(media.value)) {
    grant = { value: media.value, type: media.type, path: media.value }
    if (!selectedLegacyMedia(grant)) return null
  } else {
    try {
      const url = new URL(media.value)
      if (url.protocol !== 'enest:' || url.hostname !== 'plugin' || url.username || url.password || url.port || url.search || url.hash) return null
      const [source, ...parts] = url.pathname.slice(1).split('/').map(decodeURIComponent)
      const asset = parts.join('/')
      if (!source || !asset.startsWith('assets/') || !isPluginAssetPath(asset)) return null
      if (!pluginRegistry.getInstalledDescriptors().some(item => item.id === source && item.enabled)) return null
      grant = { value: media.value, type: media.type, source, asset }
    } catch { return null }
  }
  const extension = extname(grant.path ?? grant.asset ?? '').toLowerCase()
  if (!(media.type === 'video' ? /\.(mp4|webm|mov)$/ : /\.(png|jpe?g|gif|webp|svg|ico)$/).test(extension)) return null
  const id = `${createHash('sha256').update(`${mediaSalt}:${media.type}:${media.value}`).digest('hex')}${extension}`
  mediaGrants.set(id, grant)
  while (mediaGrants.size > 32) mediaGrants.delete(mediaGrants.keys().next().value!)
  return { type: media.type, value: `enest://appearance/media/${id}`, fit: media.fit, opacity: media.opacity }
}

function fontId(meta: CustomFontMeta): string {
  return createHash('sha256').update(`enest-font:${meta.id}:${meta.fileName}`).digest('hex')
}

/** Only names of the fonts actually used by this appearance cross the Home bridge. */
export function publicAppearanceFonts(fonts: AppearanceFonts): Array<{ family: string; url: string }> {
  const selected = new Set([fonts.body, fonts.heading, fonts.mono, fonts.cjk ?? '', fonts.latin ?? ''].flatMap(stack => stack.split(',').map(value => value.trim().replace(/^(["'])(.*)\1$/, '$2'))))
  return (settingsStore.getPluginAppearance().customFonts ?? []).filter(meta => !!meta.family && /^[\p{L}\p{N} ._-]{1,120}$/u.test(meta.family) && selected.has(meta.family)).slice(0, 8)
    .map(meta => ({ family: meta.family, url: `enest://appearance/font/${fontId(meta)}` }))
}

async function canonicalResource(root: string, file: string, mime: string, maximum = MAX_MEDIA_BYTES): Promise<{ path: string; root: string; mime: string } | null> {
  try {
    const [canonicalRoot, canonicalPath, info] = await Promise.all([realpath(root), realpath(file), stat(file)])
    const rel = relative(canonicalRoot, canonicalPath)
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || !info.isFile() || info.size > maximum) return null
    return { root: canonicalRoot, path: canonicalPath, mime }
  } catch { return null }
}

/** Public library IDs are never accepted as filesystem paths. */
export async function resolveAppearanceResource(kind: 'media' | 'font', id: string): Promise<{ path: string; root: string; mime: string } | null> {
  if (kind === 'font') {
    if (!/^[a-f0-9]{64}$/.test(id)) return null
    const meta = (settingsStore.getPluginAppearance().customFonts ?? []).find(item => fontId(item) === id)
    if (!meta || basename(meta.fileName) !== meta.fileName) return null
    const root = join(getAppPathsRoot(), FONTS_DIR)
    const mime = FONT_MIME[extname(meta.fileName).toLowerCase()]
    return mime ? canonicalResource(root, join(root, meta.fileName), mime, MAX_FONT_BYTES) : null
  }
  if (!/^[a-f0-9]{64}\.(?:png|jpe?g|gif|webp|svg|ico|mp4|webm|mov)$/.test(id)) return null
  const grant = mediaGrants.get(id)
  if (grant?.path) {
    if (!selectedLegacyMedia(grant)) return null
    return canonicalResource(dirname(grant.path), grant.path, COMPAT_MEDIA_MIME[extname(id)])
  }
  if (grant?.source && grant.asset) {
    const descriptor = pluginRegistry.getInstalledDescriptors().find(item => item.id === grant.source && item.enabled)
    if (!descriptor) return null
    const file = await resolvePluginFile(descriptor.rootPath, grant.asset, pluginRegistry.get(grant.source)?.devSource === true)
    return file ? canonicalResource(descriptor.rootPath, file, COMPAT_MEDIA_MIME[extname(id)]) : null
  }
  if (!MEDIA_MIME[extname(id)]) return null
  const root = join(getAppPathsRoot(), 'appearance', 'media')
  return canonicalResource(root, join(root, id), MEDIA_MIME[extname(id)])
}

async function header(file: string): Promise<Buffer> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(32)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } finally { await handle.close() }
}

function validHeader(bytes: Buffer, ext: string): boolean {
  if (ext === '.png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (ext === '.jpg' || ext === '.jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if (ext === '.gif') return /^GIF8[79]a/.test(bytes.toString('ascii'))
  if (ext === '.webp') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  if (ext === '.mp4') return bytes.toString('ascii', 4, 8) === 'ftyp'
  if (ext === '.webm') return bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))
  if (ext === '.ttf') return bytes.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0])) || bytes.toString('ascii', 0, 4) === 'ttcf'
  return ({ '.otf': 'OTTO', '.woff': 'wOFF', '.woff2': 'wOF2' } as Record<string, string>)[ext] === bytes.toString('ascii', 0, 4)
}

function assertImportCurrent(canCommit: () => boolean): void {
  if (!canCommit()) throw new Error('Appearance import owner is no longer active')
}

function removeImportFile(file: string): void {
  try { unlinkSync(file) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}

async function importSelectedFile(kind: 'media' | 'font', canCommit: () => boolean, imageOnly = false): Promise<{ id: string; original: string; fileName: string; discard(): void } | null> {
  assertImportCurrent(canCommit)
  const allowed = kind === 'font' ? FONT_MIME : Object.fromEntries(Object.entries(MEDIA_MIME).filter(([, mime]) => !imageOnly || mime.startsWith('image/')))
  const extensions = Object.keys(allowed).map(ext => ext.slice(1))
  const selection = await trackNativeInteraction(dialog.showOpenDialog({ title: kind === 'font' ? '导入公共字体' : '选择主题背景', properties: ['openFile'], filters: [{ name: kind === 'font' ? '字体' : imageOnly ? '图片' : '图片与视频', extensions }] }))
  assertImportCurrent(canCommit)
  if (selection.canceled || selection.filePaths.length !== 1) return null
  const source = await realpath(selection.filePaths[0])
  assertImportCurrent(canCommit)
  const ext = extname(source).toLowerCase()
  const mime = allowed[ext]
  const info = await stat(source)
  assertImportCurrent(canCommit)
  if (!mime || !info.isFile() || info.size < 4 || info.size > (kind === 'font' ? MAX_FONT_BYTES : MAX_MEDIA_BYTES)) throw new Error('文件格式或大小不受支持')
  const root = kind === 'font' ? join(getAppPathsRoot(), FONTS_DIR) : join(getAppPathsRoot(), 'appearance', 'media')
  await mkdir(root, { recursive: true })
  assertImportCurrent(canCommit)
  const temporary = join(root, `.import-${randomUUID()}`)
  let created: string | undefined
  try {
    await copyFile(source, temporary)
    assertImportCurrent(canCommit)
    const copied = await stat(temporary)
    if (copied.size !== info.size || !validHeader(await header(temporary), ext)) throw new Error('文件内容与格式不匹配')
    assertImportCurrent(canCommit)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(temporary)) {
      assertImportCurrent(canCommit)
      hash.update(chunk)
    }
    const digest = hash.digest('hex')
    const fileName = `${digest}${ext}`
    const destination = join(root, fileName)
    assertImportCurrent(canCommit)
    // Publish atomically without replacing a resource another import already owns.
    try { linkSync(temporary, destination); created = destination }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    assertImportCurrent(canCommit)
    return { id: digest, fileName, original: basename(source, ext), discard: () => { if (created) removeImportFile(created) } }
  } catch (error) {
    if (created) removeImportFile(created)
    throw error
  } finally { removeImportFile(temporary) }
}

export async function pickAppearanceMedia(canCommit: () => boolean = () => true, options: { imageOnly?: boolean } = {}): Promise<BackgroundConfig | null> {
  const imported = await importSelectedFile('media', canCommit, options.imageOnly === true)
  if (!imported) return null
  try {
    assertImportCurrent(canCommit)
    const video = /\.(mp4|webm)$/.test(imported.fileName)
    return { type: video ? 'video' : 'image', value: `enest://appearance/media/${imported.fileName}`, fit: 'cover', opacity: 0.85 }
  } catch (error) { imported.discard(); throw error }
}

export async function importAppearanceFont(canCommit: () => boolean = () => true): Promise<CustomFontMeta | null> {
  const imported = await importSelectedFile('font', canCommit)
  if (!imported) return null
  try {
    assertImportCurrent(canCommit)
    const current = settingsStore.getPluginAppearance().customFonts ?? []
    const existing = current.find(meta => meta.fileName === imported.fileName)
    if (existing) return existing
    const family = `eNestFont-${imported.id.slice(0, 16)}`
    const meta: CustomFontMeta = { id: imported.id, name: imported.original.slice(0, 80), family, fileName: imported.fileName }
    assertImportCurrent(canCommit)
    await settingsStore.setAll({ general: { customFonts: [...current, meta] } })
    return meta
  } catch (error) { imported.discard(); throw error }
}

/** Remove only a library-owned resource, never a caller-authored filesystem path. */
export async function removeAppearanceFont(id: string, canCommit: () => boolean = () => true): Promise<void> {
  assertImportCurrent(canCommit)
  if (typeof id !== 'string' || !id || id.length > 128) throw new Error('Invalid font handle')
  const meta = (settingsStore.getPluginAppearance().customFonts ?? []).find(item => item.id === id)
  if (!meta || basename(meta.fileName) !== meta.fileName || !FONT_MIME[extname(meta.fileName).toLowerCase()]) throw new Error('Font is unavailable')
  const root = join(getAppPathsRoot(), FONTS_DIR)
  const file = join(root, meta.fileName)
  const resource = await canonicalResource(root, file, FONT_MIME[extname(meta.fileName).toLowerCase()], MAX_FONT_BYTES)
  assertImportCurrent(canCommit)
  if (!resource) throw new Error('Font resource is outside its library or unavailable')
  const current = (settingsStore.getPluginAppearance().customFonts ?? []).find(item => item.id === id)
  if (!current || current.fileName !== meta.fileName || current.family !== meta.family) throw new Error('Font library changed; refresh before editing')
  assertImportCurrent(canCommit)
  const packs = [...BUILTIN_THEME_PACKS, ...themePackRegistry.list().filter((pack): pack is ThemePackV2 => (pack as Partial<ThemePackV2>).schemaVersion === 2)]
  const fontFields = Object.fromEntries(packs.map(pack => [themeProfileKey(pack), pack.settings.groups.flatMap(group => group.fields)
    .filter(field => field.binding.target === 'font' && field.binding.key !== 'scale').map(field => field.key)]))
  settingsStore.commitAppearanceFontRemoval(meta.id, meta.family, fontFields)
  // Revocation is durable before cleanup. A failed unlink must not restore the font grant.
  if (!(settingsStore.getPluginAppearance().customFonts ?? []).some(font => font.fileName === meta.fileName)) {
    try { removeImportFile(file) } catch { /* An unreferenced file may be cleaned up on a later library maintenance pass. */ }
  }
}
