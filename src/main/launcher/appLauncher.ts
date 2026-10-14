/**
 * appLauncher — 按平台启动本地应用
 * mac: shell.openPath(.app) / open
 * win: shell.openPath 或 spawn 目标
 * linux: 解析 Exec 字段后 spawn（剥离 %U/%F 等）
 * 安全：只允许启动扫描缓存中的应用路径，拒绝任意路径。
 */
import { execFile, spawn } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'
import { app, nativeImage, shell } from 'electron'
import { getCachedApps } from './appScanner'
import { logError, logInfo, logWarn } from '@main/logs/logService'

/** 将 Linux Exec 字符串拆成 [cmd, ...args] */
export function parseExecString(exec: string): [string, string[]] {
  const cleaned = exec.replace(/%[fFuUdDnNickvm]/g, '').trim()
  const parts: string[] = []
  let current = ''
  let quote: string | null = null
  for (const ch of cleaned) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (current) {
        parts.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (current) parts.push(current)
  return [parts[0] ?? '', parts.slice(1)]
}

/** 校验 path 是否来自扫描缓存（防渲染层注入任意可执行路径） */
export function isKnownAppPath(path: string): boolean {
  const cached = getCachedApps()
  if (!cached) return false
  return cached.apps.some((a) => a.path === path)
}

const execFileAsync = promisify(execFile)
const ICON_SIZE = 96
const ICON_CACHE_LIMIT = 256
const ICON_SUCCESS_TTL = 15 * 60_000
const ICON_RETRY_TTL = 15_000
const iconCache = new Map<string, { url?: string; expires: number }>()
const pendingIcons = new Map<string, Promise<string | undefined>>()
let activeIconLoads = 0
const iconLoadQueue: Array<() => void> = []

/** Limit native decodes/subprocesses while preserving request coalescing across searches. */
async function withIconSlot<T>(load: () => Promise<T>): Promise<T> {
  if (activeIconLoads >= 6) await new Promise<void>((resolve) => iconLoadQueue.push(resolve))
  else activeIconLoads++
  try { return await load() }
  finally {
    const next = iconLoadQueue.shift()
    if (next) next()
    else activeIconLoads--
  }
}

function boundedImageUrl(image: Electron.NativeImage): string | undefined {
  if (image.isEmpty()) return undefined
  const { width, height } = image.getSize()
  return (width > ICON_SIZE || height > ICON_SIZE
    ? image.resize({ width: ICON_SIZE, height: ICON_SIZE, quality: 'best' })
    : image).toDataURL()
}

/** Modern ICNS bundles contain ordinary, full-colour PNG representations. */
export function extractIcnsPng(data: Buffer): Buffer | undefined {
  if (data.length < 8 || data.toString('ascii', 0, 4) !== 'icns') return undefined
  const length = data.readUInt32BE(4)
  if (length < 8 || length > data.length) return undefined
  let best: Buffer | undefined
  let bestScore = Infinity
  for (let offset = 8; offset + 8 <= length;) {
    const size = data.readUInt32BE(offset + 4)
    if (size < 8 || offset + size > length) break
    const png = data.subarray(offset + 8, offset + size)
    if (png.length >= 24 && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      const width = png.readUInt32BE(16), height = png.readUInt32BE(20)
      const side = Math.min(width, height)
      if (side > 0 && Math.max(width, height) <= 2048) {
        const score = side >= ICON_SIZE ? side - ICON_SIZE : 2048 - side
        if (score < bestScore) { best = png; bestScore = score }
      }
    }
    offset += size
  }
  return best
}

function plistString(xml: string, key: string): string | undefined {
  return new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]*)</string>`).exec(xml)?.[1]
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

/** Read the application's own icon without starting AppKit/osascript for ordinary bundles. */
async function macBundleIcon(path: string): Promise<string | undefined> {
  try {
    const plistPath = join(path, 'Contents', 'Info.plist')
    const data = await readFile(plistPath)
    let iconFile: string | undefined
    if (data.subarray(0, 6).toString() === 'bplist') {
      try {
        const { stdout } = await execFileAsync('/usr/bin/plutil', ['-extract', 'CFBundleIconFile', 'raw', '-o', '-', plistPath], { timeout: 2000, maxBuffer: 64 * 1024 })
        iconFile = stdout.trim()
      } catch { /* Asset-only applications may omit this key but still ship AppIcon.icns. */ }
    } else iconFile = plistString(data.toString('utf8'), 'CFBundleIconFile')
    const names = [...new Set([iconFile, 'AppIcon.icns', 'app.icns', 'icon.icns', `${basename(path, '.app')}.icns`].filter((name): name is string => Boolean(name)))]
    for (const name of names) {
      const file = join(path, 'Contents', 'Resources', extname(name) ? name : `${name}.icns`)
      try {
        if ((await stat(file)).size > 16 * 1024 * 1024) continue
        const source = await readFile(file)
        const png = extname(file).toLowerCase() === '.icns' ? extractIcnsPng(source) : source
        if (!png) continue
        const url = boundedImageUrl(nativeImage.createFromBuffer(png))
        if (url) return url
      } catch { /* A legacy ICNS or missing candidate falls back to NSWorkspace below. */ }
    }
  } catch { /* Missing icon metadata falls back to the system icon resolver. */ }
  return undefined
}

/** darwin 批量提图脚本（JXA/NSWorkspace）：一次 osascript 进程取全部路径，结果 JSON base64 map。
 *  setSize 不缩放位图（仍输出 1024² 16-bit 大图），必须经位图上下文重绘到 96² 8-bit。 */
const MAC_ICON_SCRIPT = `ObjC.import('AppKit')
ObjC.import('Foundation')
function run(argv) {
  const out = {}
  const S = 96
  for (const p of argv) {
    try {
      const icon = $.NSWorkspace.sharedWorkspace.iconForFile($(p))
      icon.setSize($.NSMakeSize(S, S))
      const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
        null, S, S, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0)
      rep.setSize($.NSMakeSize(S, S))
      const ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep)
      $.NSGraphicsContext.saveGraphicsState
      $.NSGraphicsContext.setCurrentContext(ctx)
      icon.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, S, S), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1.0)
      $.NSGraphicsContext.restoreGraphicsState
      const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $())
      out[p] = ObjC.unwrap(png.base64EncodedStringWithOptions($(0)))
    } catch (e) {
      out[p] = null
    }
  }
  return JSON.stringify(out)
}`

const pendingMacIcons = new Map<string, { promise: Promise<string | undefined>; resolve: (value: string | undefined) => void }>()
const queuedMacIcons = new Set<string>()
let macIconFlush: ReturnType<typeof setTimeout> | null = null
let macIconBatchRunning = false

/** Prefer full-colour application representations, never a symbolic/template variant. */
const LINUX_ICON_EXTS = ['.png', '.xpm', '.svg', '']
const LINUX_APP_ICON_DIRS = ['96x96/apps', '128x128/apps', '64x64/apps', 'scalable/apps', '48x48/apps', '256x256/apps', '32x32/apps', '512x512/apps', '16x16/apps', 'apps', '']
let linuxDirectories: { expires: number; promise: Promise<string[]> } | undefined

async function linuxIconDirectories(): Promise<string[]> {
  if (linuxDirectories && linuxDirectories.expires > Date.now()) return linuxDirectories.promise
  const promise = (async () => {
    const dataDirs = [...new Set([process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
      ...(process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean),
      join(homedir(), '.local/share/flatpak/exports/share'), '/var/lib/flatpak/exports/share', '/var/lib/snapd/desktop'])]
    const roots = [...new Set([join(homedir(), '.icons'), ...dataDirs.map(dir => join(dir, 'icons'))])]
    const directories: string[] = []
    for (const root of roots) {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
      const themes = [...new Set(['hicolor', ...entries.filter(entry => entry.isDirectory()).map(entry => entry.name)])]
      for (const theme of themes) {
        const themeRoot = join(root, theme)
        const index = await readFile(join(themeRoot, 'index.theme'), 'utf8').catch(() => '')
        const declared = [...index.matchAll(/^(?:ScaledDirectories|Directories)=(.+)$/gm)]
          .flatMap(match => match[1].split(',').map(value => value.trim())).filter(value => value && !value.includes('symbolic'))
        directories.push(...[...new Set([...LINUX_APP_ICON_DIRS, ...declared])].map(dir => join(themeRoot, dir)))
      }
      directories.push(root)
    }
    return [...new Set([...directories, ...dataDirs.map(dir => join(dir, 'pixmaps'))])]
  })()
  linuxDirectories = { expires: Date.now() + 60_000, promise }
  return promise
}

/**
 * 解析 .desktop Icon= 值为 data URL。
 * 绝对路径直接读文件；主题名按 XDG 目录顺序查找 name+ext。
 * PNG/XPM 用 nativeImage 解码（SVG 无法位图化，直接原样内联 data URL）。
 */
async function linuxDesktopIconUrl(iconName: string): Promise<string | undefined> {
  try {
    const candidates = iconName.startsWith('/')
      ? [iconName]
      : (await linuxIconDirectories()).flatMap((dir) => LINUX_ICON_EXTS.map((ext) => join(dir, `${iconName}${ext}`)))
    for (const file of candidates) {
      try {
        const st = await stat(file)
        if (!st.isFile() || st.size > 4 * 1024 * 1024) continue
        if (file.toLowerCase().endsWith('.svg')) {
          const svg = await readFile(file, 'utf-8')
          return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
        }
        const img = nativeImage.createFromPath(file)
        const url = boundedImageUrl(img)
        if (url) return url
      } catch {
        /* 逐个候选继续 */
      }
    }
  } catch {
    /* 解析失败走 undefined */
  }
  return undefined
}

/**
 * 少数旧 ICNS / asset-only 应用用 NSWorkspace 兜底，JXA 合批且同一时刻只运行一批。
 * 失败保持短期负缓存，后续查询可重试真实图标。
 */
function macIconData(path: string): Promise<string | undefined> {
  const active = pendingMacIcons.get(path)
  if (active) return active.promise
  let finish!: (value: string | undefined) => void
  const promise = new Promise<string | undefined>((resolve) => { finish = resolve })
  pendingMacIcons.set(path, { promise, resolve: finish })
  queuedMacIcons.add(path)
  flushMacIcons()
  return promise
}

function flushMacIcons(): void {
  if (!macIconFlush && !macIconBatchRunning && queuedMacIcons.size) {
    // 同一轮可见搜索结果合批；不再为一个结果等待整机全部应用提图。
    macIconFlush = setTimeout(async () => {
      macIconFlush = null
      macIconBatchRunning = true
      const batch = [...queuedMacIcons].map((path) => [path, pendingMacIcons.get(path)!] as const)
      queuedMacIcons.clear()
      let icons: Record<string, string | null> = {}
      try {
        const output = await new Promise<string>((resolve, reject) => {
          execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_ICON_SCRIPT, ...batch.map(([path]) => path)],
            // Cold AppKit startup may exceed 5s under load. Icon enrichment is
            // asynchronous; keep the process bounded without discarding real icons.
            { maxBuffer: 16 * 1024 * 1024, timeout: 15000 },
            (error, stdout) => error ? reject(error) : resolve(stdout))
        })
        icons = JSON.parse(output)
      } catch (error) {
        const failure = error as NodeJS.ErrnoException & { killed?: boolean }
        logWarn('quick', `mac icon batch failed (${batch.length} icons, ${failure.killed ? 'timeout' : failure.code ?? 'unavailable'})`)
      }
      for (const [path, request] of batch) {
        pendingMacIcons.delete(path)
        request.resolve(icons[path] ? `data:image/png;base64,${icons[path]}` : undefined)
      }
      macIconBatchRunning = false
      flushMacIcons()
    }, 0)
  }
}

/**
 * 取本地应用图标（data URL）。失败/无图标返回 undefined。
 * 结果缓存，命令面搜索时只为 top 结果解析，不阻塞扫描。
 * 跨平台：
 * - darwin：直接解包应用原生 ICNS PNG；少数旧格式走 NSWorkspace 批量提取
 * - win32：优先 .lnk 自定义图标/可执行目标，再交给系统提取
 * - linux：path 是 Exec 命令串，getFileIcon 不适用；按 iconName（Icon= 字段）
 *   解析——绝对路径直读，主题名查 hicolor/pixmaps 目录（PNG 优先，SVG 兜底）
 */
export async function getAppIconDataUrl(path: string, iconName?: string): Promise<string | undefined> {
  const key = JSON.stringify([path, iconName ?? ''])
  const hit = iconCache.get(key)
  if (hit && hit.expires > Date.now()) {
    iconCache.delete(key)
    iconCache.set(key, hit)
    return hit.url
  }
  const pending = pendingIcons.get(key)
  if (pending) return pending
  const task = withIconSlot(async () => {
    let url: string | undefined
    try {
      if (process.platform === 'darwin') {
        url = await macBundleIcon(path) ?? await macIconData(path)
        // getFileIcon can return only a generic document icon on modern macOS.
        // Leave a failed native lookup retryable instead of caching that as success.
      } else if (process.platform === 'linux') {
        if (iconName) url = await linuxDesktopIconUrl(iconName)
        // Exec= is a command line, not a file path. Its generic executable icon
        // must not hide a missing .desktop icon or prevent a later theme retry.
        if (!url && iconName) logWarn('quick', `linux desktop icon not found: ${iconName}`)
      } else {
        let target = path
        if (extname(path).toLowerCase() === '.lnk') {
          try {
            const shortcut = shell.readShortcutLink(path)
            if (shortcut.icon && /\.(?:ico|png|jpe?g)$/i.test(shortcut.icon)) {
              url = boundedImageUrl(nativeImage.createFromPath(shortcut.icon))
            }
            // A resource icon's index belongs to the shortcut; let Windows
            // resolve it rather than reading the first icon of its DLL/EXE.
            target = shortcut.icon ? path : shortcut.target || path
          } catch { /* The system can still resolve a shortcut that cannot be read. */ }
        }
        if (!url) url = boundedImageUrl(await app.getFileIcon(target, { size: 'large' }))
      }
    } catch { /* Short negative caching allows transient extraction failures to recover. */ }
    iconCache.delete(key)
    iconCache.set(key, { url, expires: Date.now() + (url ? ICON_SUCCESS_TTL : ICON_RETRY_TTL) })
    while (iconCache.size > ICON_CACHE_LIMIT) iconCache.delete(iconCache.keys().next().value!)
    return url
  })
  pendingIcons.set(key, task)
  try { return await task }
  finally { if (pendingIcons.get(key) === task) pendingIcons.delete(key) }
}

export async function launchLocalApp(path: string): Promise<void> {
  if (!isKnownAppPath(path)) {
    logError('quick', `blocked launch of unknown path: ${path}`)
    throw new Error('应用不在扫描列表中，已拒绝启动')
  }

  const platform = process.platform

  if (platform === 'linux') {
    const [cmd, args] = parseExecString(path)
    if (!cmd) throw new Error('empty Exec')
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
      child.once('error', reject)
      child.once('spawn', () => { child.unref(); resolve() })
    })
  }

  // mac .app 与 win 路径优先 openPath
  const err = await shell.openPath(path)
  if (err) {
    if (platform === 'darwin') {
      return new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/open', ['-a', path], { stdio: 'ignore' })
        child.once('error', reject)
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`应用启动失败（${code}）`)))
      })
    }
    logError('quick', `launch failed: ${path} — ${err}`)
    throw new Error(err)
  }
  logInfo('quick', `launched: ${path}`)
}
