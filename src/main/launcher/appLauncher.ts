/**
 * appLauncher — 按平台启动本地应用
 * mac: shell.openPath(.app) / open
 * win: shell.openPath 或 spawn 目标
 * linux: 解析 Exec 字段后 spawn（剥离 %U/%F 等）
 * 安全：只允许启动扫描缓存中的应用路径，拒绝任意路径。
 */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, nativeImage, shell } from 'electron'
import { getCachedApps } from './appScanner'
import { logError, logInfo, logWarn } from '../logs/logService'

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

/** path → dataURL 图标缓存；空串表示无图标，避免重复 getFileIcon */
const iconCache = new Map<string, string>()

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

/** JXA 批量提取的内存缓存（进程生命周期内一次） */
let macIconBatch: Promise<Map<string, string | null>> | null = null

/** XDG 图标主题查找目录（绝对路径 Icon= 之外的名称在这几处兜底） */
const LINUX_ICON_DIRS = [
  '/usr/share/pixmaps',
  '/usr/local/share/pixmaps',
  ...[process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), '/usr/share', '/var/lib/flatpak/exports/share', '/var/lib/snapd/desktop'].flatMap(
    (dataDir) => [join(dataDir, 'icons', 'hicolor'), join(dataDir, 'icons')]
  )
]
/** 按优先级尝试的图标扩展名（位图优先，SVG 兜底） */
const LINUX_ICON_EXTS = ['.png', '.xpm', '.svg', '']

/**
 * 解析 .desktop Icon= 值为 data URL。
 * 绝对路径直接读文件；主题名按 XDG 目录顺序查找 name+ext。
 * PNG/XPM 用 nativeImage 解码（SVG 无法位图化，直接原样内联 data URL）。
 */
async function linuxDesktopIconUrl(iconName: string): Promise<string | undefined> {
  try {
    const { readFile, stat } = await import('node:fs/promises')
    const candidates = iconName.startsWith('/')
      ? [iconName]
      : LINUX_ICON_DIRS.flatMap((dir) => LINUX_ICON_EXTS.map((ext) => join(dir, `${iconName}${ext}`)))
    for (const file of candidates) {
      try {
        const st = await stat(file)
        if (!st.isFile()) continue
        if (file.toLowerCase().endsWith('.svg')) {
          const svg = await readFile(file, 'utf-8')
          return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
        }
        const img = nativeImage.createFromPath(file)
        if (!img.isEmpty()) return img.toDataURL()
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
 * darwin 图标提取：app.getFileIcon 在新系统返回通用占位图，
 * 改走 NSWorkspace iconForFile（JXA 一次子进程批量取全部已扫应用）。
 * 失败回退空 map，上层继续走 getFileIcon 兜底。
 */
async function macIconMap(): Promise<Map<string, string | null>> {
  if (!macIconBatch) {
    macIconBatch = (async () => {
      const map = new Map<string, string | null>()
      try {
        const { execFile } = await import('node:child_process')
        const cached = getCachedApps()
        if (!cached || cached.apps.length === 0) return map
        const paths = cached.apps.map((a) => a.path)
        const out = await new Promise<string>((resolve, reject) => {
          execFile(
            '/usr/bin/osascript',
            ['-l', 'JavaScript', '-e', MAC_ICON_SCRIPT, ...paths],
            { maxBuffer: 64 * 1024 * 1024, timeout: 30_000 },
            (err, stdout) => (err ? reject(err) : resolve(stdout))
          )
        })
        const parsed = JSON.parse(out) as Record<string, string | null>
        for (const [k, v] of Object.entries(parsed)) map.set(k, v)
      } catch (err) {
        logWarn('quick', `mac icon batch failed: ${(err as Error).message}`)
      }
      return map
    })()
  }
  return macIconBatch
}

/**
 * 取本地应用图标（data URL）。失败/无图标返回 undefined。
 * 结果缓存，命令面搜索时只为 top 结果解析，不阻塞扫描。
 * 跨平台：
 * - darwin：NSWorkspace 批量提取（getFileIcon 返回通用占位图），失败回退 getFileIcon
 * - win32：getFileIcon 直取 .exe/.lnk 目标
 * - linux：path 是 Exec 命令串，getFileIcon 不适用；按 iconName（Icon= 字段）
 *   解析——绝对路径直读，主题名查 hicolor/pixmaps 目录（PNG 优先，SVG 兜底）
 */
export async function getAppIconDataUrl(path: string, iconName?: string): Promise<string | undefined> {
  const hit = iconCache.get(path)
  if (hit !== undefined) return hit || undefined
  // darwin：优先 NSWorkspace 批量结果（真实应用图标）
  if (process.platform === 'darwin') {
    const map = await macIconMap()
    const b64 = map.get(path)
    if (b64) {
      const url = `data:image/png;base64,${b64}`
      iconCache.set(path, url)
      return url
    }
    // 批量里没有该路径（新装应用等）→ 记负缓存防抖，仍可走 getFileIcon 兜底
    if (!map.has(path)) {
      logWarn('quick', `icon not in scan batch, fallback: ${path}`)
    }
  }
  // linux：.desktop Icon= 解析
  if (process.platform === 'linux' && iconName) {
    const url = await linuxDesktopIconUrl(iconName)
    iconCache.set(path, url ?? '')
    if (url) return url
    logWarn('quick', `linux desktop icon not found: ${iconName}`)
  }
  try {
    const img = await app.getFileIcon(path, { size: 'normal' })
    if (!img || img.isEmpty()) {
      iconCache.set(path, '')
      return undefined
    }
    const url = img.toDataURL()
    iconCache.set(path, url)
    return url
  } catch {
    iconCache.set(path, '')
    return undefined
  }
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
      child.on('error', reject)
      child.unref()
      resolve()
    })
  }

  // mac .app 与 win 路径优先 openPath
  const err = await shell.openPath(path)
  if (err) {
    if (platform === 'darwin') {
      return new Promise((resolve, reject) => {
        spawn('open', ['-a', path], { detached: true, stdio: 'ignore' }).on('error', reject)
        resolve()
      })
    }
    logError('quick', `launch failed: ${path} — ${err}`)
    throw new Error(err)
  }
  logInfo('quick', `launched: ${path}`)
}
