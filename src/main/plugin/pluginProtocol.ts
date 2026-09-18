/**
 * pluginProtocol — 自定义协议 enest://
 * 职责：注册 enest:// 协议，将插件资源请求映射到本地文件系统，包含路径穿越防护与 CSP 注入；
 * 另提供 enest://media/?path= 读取数据根 / 用户在设置中显式选择过的本地媒体（背景图/视频）。
 * 被 index.ts（initPluginProtocol）与 PluginHost（registerPluginProtocolForSession）调用。
 * 关键依赖：PluginRegistry（查找 rootPath）、pathsService（数据根）、settingsStore（已选媒体）、@shared/constants（PROTOCOL）。
 */
import { readFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { app, protocol, session, type Session } from 'electron'
import { PROTOCOL, SHELL_PARTITION } from '@shared/constants'
import { resolvePluginUi } from '@shared/types/plugin'
import { defaultDataRoot, getAppPaths } from '@main/paths/pathsService'
import { settingsStore } from '@main/settings/SettingsStore'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { resolveThemeTokens, themeTokensToCss } from '@main/theme/resolveThemeCss'

/** 壳子生成的主题 CSS 虚拟文件名；插件可 <link href="enest://plugin/{id}/__enest_theme.css"> */
const THEME_CSS_FILE = '__enest_theme.css'

/** 为指定插件生成当前主题 CSS（preferredColorScheme 已解析） */
function buildThemeCssForPlugin(pluginId: string): string {
  const manifest = pluginRegistry.getManifest(pluginId)
  const ui = resolvePluginUi(manifest?.ui)
  const resolved = resolveThemeTokens(ui.preferredColorScheme)
  return themeTokensToCss(resolved, { transparent: ui.background === 'transparent' })
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.map': 'application/json'
}

const DEV_CSP =
  "default-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:* http://127.0.0.1:*; img-src 'self' data: blob:; connect-src 'self' http://localhost:* http://127.0.0.1:*"
const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'"

/** 在 app ready 前注册 enest:// 为特权协议，使后续 handle 能处理 fetch/CORS */
export function registerSchemesAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}

/** 路径穿越防护：decode 后确认 resolve 结果仍在 root 内，否则拒绝 */
function safeResolve(root: string, relPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(relPath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const abs = resolve(root, decoded)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return abs
}

/** 按扩展名推断 MIME 并返回带 CSP 的 Response */
async function fileResponse(abs: string, isDev: boolean): Promise<Response> {
  const mime = MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream'
  const body = await readFile(abs)
  return new Response(body, {
    headers: {
      'Content-Type': mime,
      'Content-Security-Policy': isDev ? DEV_CSP : PROD_CSP
    }
  })
}

// ---------------------------------------------------------------------------
// 插件资产 LRU 缓存
// 为什么：enest:// 每请求 readFile，插件页反复重载/资源反复拉取时主进程 IO 放大；
//       只缓存文件 Buffer，MIME 与 CSP 头仍按请求动态生成（媒体端点不缓存）。
// 失效：key 含 rootPath，reload/升级用新 rootPath 重绑 session 时自然 miss；
//       开发态插件文件变更依赖 devUrl/重启，不在本缓存处理范围。
// ---------------------------------------------------------------------------
/** 单文件缓存上限：超过则直读不缓存 */
const CACHE_MAX_FILE_BYTES = 512 * 1024
/** 缓存总容量上限 */
const CACHE_MAX_TOTAL_BYTES = 32 * 1024 * 1024
/** Map 迭代序 = 插入序；get 时 delete+set 实现 LRU 触碰 */
const fileCache = new Map<string, Buffer>()
let fileCacheBytes = 0

function cacheGet(key: string): Buffer | undefined {
  const hit = fileCache.get(key)
  if (hit !== undefined) {
    // LRU 触碰：移到迭代序末尾（最旧在下一次 set 淘汰时最先被删）
    fileCache.delete(key)
    fileCache.set(key, hit)
  }
  return hit
}

function cachePut(key: string, body: Buffer): void {
  if (body.byteLength > CACHE_MAX_FILE_BYTES) return
  if (fileCache.has(key)) {
    const old = fileCache.get(key)!
    fileCache.delete(key)
    fileCacheBytes -= old.byteLength
  }
  fileCache.set(key, body)
  fileCacheBytes += body.byteLength
  // 按插入序淘汰最旧条目直到回到容量内
  while (fileCacheBytes > CACHE_MAX_TOTAL_BYTES && fileCache.size > 0) {
    const oldestKey = fileCache.keys().next().value as string
    const oldest = fileCache.get(oldestKey)!
    fileCache.delete(oldestKey)
    fileCacheBytes -= oldest.byteLength
  }
}

/** 带缓存的文件响应（仅插件资产路径使用；MIME/CSP 头仍动态生成） */
async function fileResponseCached(
  rootPath: string,
  abs: string,
  isDev: boolean
): Promise<Response> {
  const key = `${rootPath}|${abs}`
  let body = cacheGet(key)
  if (body === undefined) {
    body = await readFile(abs)
    cachePut(key, body)
  }
  const mime = MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream'
  return new Response(body, {
    headers: {
      'Content-Type': mime,
      'Content-Security-Policy': isDev ? DEV_CSP : PROD_CSP
    }
  })
}

/**
 * 失效 enest:// 资产缓存。
 * - 传 rootPath：只清该插件目录下的 key（热重载/文件监视用）
 * - 不传：清空全部（升级/全局场景）
 */
export function invalidatePluginFileCache(rootPath?: string): void {
  if (!rootPath) {
    fileCache.clear()
    fileCacheBytes = 0
    return
  }
  const prefix = `${rootPath}|`
  for (const key of [...fileCache.keys()]) {
    if (!key.startsWith(prefix)) continue
    const buf = fileCache.get(key)
    fileCache.delete(key)
    if (buf) fileCacheBytes -= buf.byteLength
  }
  if (fileCacheBytes < 0) fileCacheBytes = 0
}

/** 解析 enest://plugin/{pluginId}/{filePath} URL，路径为空时默认 index.html */
function parsePluginUrl(url: string): { pluginId: string; filePath: string } | null {
  try {
    const u = new URL(url)
    if (u.protocol !== `${PROTOCOL}:`) return null
    const parts = u.pathname.split('/').filter(Boolean)
    if (parts.length < 1) return null
    const pluginId = parts[0]
    const filePath = parts.slice(1).join('/') || 'index.html'
    return { pluginId, filePath }
  } catch {
    return null
  }
}

/** 绝对路径是否落在 root 内（含 root 自身）；沿用 path.relative 穿越防护 */
function isInsideRoot(root: string, abs: string): boolean {
  if (!root) return false
  const rel = relative(root, abs)
  if (rel === '') return true
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
}

/** 绝对路径是否落在允许的媒体根（数据根 + 设置中用户显式选择的媒体目录）内 */
function isAllowedMediaPath(abs: string): boolean {
  const roots = [getAppPaths().root, defaultDataRoot()]
  for (const root of roots) {
    if (isInsideRoot(root, abs)) return true
  }
  const theme = settingsStore.getTheme()
  const splash = settingsStore.getAll().general.splashBackground
  const selected = [theme.background?.value, splash?.value]
  for (const value of selected) {
    if (typeof value !== 'string' || !isAbsolute(value)) continue
    if (isInsideRoot(dirname(resolve(value)), abs)) return true
  }
  return false
}

/**
 * 解析 enest://media/?path=<绝对路径>（或 enest://media/<abs>）。
 * 返回已校验的绝对路径；拒绝穿越与越权。
 */
function resolveMediaRequest(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== `${PROTOCOL}:`) return null
    const host = u.hostname || u.pathname.split('/').filter(Boolean)[0] || ''
    if (host !== 'media') return null
    const fromQuery = u.searchParams.get('path')
    const fromPath = u.pathname.replace(/^\/+/, '')
    const raw = fromQuery ?? fromPath
    if (!raw || !isAbsolute(raw)) return null
    if (raw.includes('\0')) return null
    const abs = resolve(raw)
    if (!isAllowedMediaPath(abs)) return null
    return abs
  } catch {
    return null
  }
}

/** 构造可被 <img>/<video> 使用的本地媒体 URL */
export function mediaProtocolUrl(absPath: string): string {
  return `${PROTOCOL}://media/?path=${encodeURIComponent(absPath)}`
}

/** Default-session handler: plugin assets + local media under allowed roots. */
async function handleEnestProtocol(request: Request): Promise<Response> {
  const mediaAbs = resolveMediaRequest(request.url)
  if (mediaAbs) {
    try {
      return await fileResponse(mediaAbs, !app.isPackaged)
    } catch {
      return new Response('not found', { status: 404 })
    }
  }

  const parsed = parsePluginUrl(request.url)
  if (!parsed) return new Response('bad request', { status: 400 })
  // 主题 CSS 虚拟文件：动态生成，不落盘
  if (parsed.filePath === THEME_CSS_FILE) {
    return new Response(buildThemeCssForPlugin(parsed.pluginId), {
      headers: { 'Content-Type': 'text/css; charset=utf-8' }
    })
  }
  const summary = pluginRegistry.get(parsed.pluginId)
  if (!summary?.rootPath) return new Response('plugin not found', { status: 404 })
  const abs = safeResolve(summary.rootPath, parsed.filePath)
  if (!abs) return new Response('forbidden', { status: 403 })
  try {
    return await fileResponseCached(summary.rootPath, abs, Boolean(summary.devUrl))
  } catch {
    return new Response('not found', { status: 404 })
  }
}

export function initPluginProtocol(): void {
  protocol.handle(PROTOCOL, handleEnestProtocol)
  // Shell 分区（主壳 + Quick 小窗）也要能加载插件 logo 等资源
  try {
    const shellSes = session.fromPartition(SHELL_PARTITION)
    shellSes.protocol.handle(PROTOCOL, handleEnestProtocol)
  } catch {
    /* session 尚未就绪时忽略；窗口创建前会再确保 */
  }
}

/** 确保 SHELL_PARTITION 上已挂 enest://（Quick 等懒创建窗口前调用） */
export function ensureShellSessionProtocol(): void {
  try {
    const shellSes = session.fromPartition(SHELL_PARTITION)
    try {
      shellSes.protocol.unhandle(PROTOCOL)
    } catch {
      /* 尚未注册 */
    }
    shellSes.protocol.handle(PROTOCOL, handleEnestProtocol)
  } catch {
    /* ignore */
  }
}

/** Session-scoped handler: only serves the given plugin root. */
export function registerPluginProtocolForSession(
  ses: Session,
  pluginId: string,
  rootPath: string
): void {
  const isDev = false // session 级始终走生产 CSP，开发态插件走默认 session
  // 同一 persist 分区的 session 对象跨「关闭→再打开」复用；protocol.handle
  // 对已注册 scheme 二次调用会抛 "Failed to register protocol"（Electron 36
  // 实测），必须先 unhandle 再注册（幂等，未注册时忽略）
  try {
    ses.protocol.unhandle(PROTOCOL)
  } catch {
    /* 尚未注册 */
  }
  ses.protocol.handle(PROTOCOL, async (request) => {
    const parsed = parsePluginUrl(request.url)
    if (!parsed || parsed.pluginId !== pluginId) {
      return new Response('forbidden', { status: 403 })
    }
    // 主题 CSS 虚拟文件（session 级 handler 同样支持）
    if (parsed.filePath === THEME_CSS_FILE) {
      return new Response(buildThemeCssForPlugin(pluginId), {
        headers: { 'Content-Type': 'text/css; charset=utf-8' }
      })
    }
    const abs = safeResolve(rootPath, parsed.filePath)
    if (!abs) return new Response('forbidden', { status: 403 })
    try {
      return await fileResponseCached(rootPath, abs, isDev)
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}

export function fileUrlFor(rootPath: string, filePath: string): string {
  return `file://${join(rootPath, filePath)}`
}
