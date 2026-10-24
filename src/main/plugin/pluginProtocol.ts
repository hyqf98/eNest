/**
 * pluginProtocol — 自定义协议 enest://
 * 职责：注册 enest:// 协议，将插件资源请求映射到本地文件系统，包含路径穿越防护与 CSP 注入；
 * 另提供 enest://media/?path= 读取数据根 / 用户在设置中显式选择过的本地媒体（背景图/视频）。
 * 被 index.ts（initPluginProtocol）与 PluginHost（registerPluginProtocolForSession）调用。
 * 关键依赖：PluginRegistry（查找 rootPath）、pathsService（数据根）、settingsStore（已选媒体）、@shared/constants（PROTOCOL）。
 */
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { app, protocol, session, type Session } from 'electron'
import { PROTOCOL, SHELL_PARTITION, pluginPartition, FONTS_DIR } from '@shared/constants'
import { resolvePluginUi } from '@shared/types/plugin'
import { defaultDataRoot, getAppPaths, getAppPathsRoot } from '@main/paths/pathsService'
import { settingsStore } from '@main/settings/SettingsStore'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { resolveThemeTokens, themeTokensToCss } from '@main/theme/resolveThemeCss'
import { resolveAppearanceResource } from '@main/theme/appearanceResources'
import { QUICK_THEME_PROTOCOL, registerQuickThemeProtocolForSession } from '@main/theme/quickThemeProtocol'
import { pluginAssetCache, pluginFileResponse } from './pluginFileResponse'
import { resolvePluginFile } from './pluginPaths'
import { getPluginContentSecurityPolicy } from './pluginSessionPolicy'

/** 壳子生成的主题 CSS 虚拟文件名；插件可 <link href="enest://plugin/{id}/__enest_theme.css"> */
const THEME_CSS_FILE = '__enest_theme.css'
const FONT_FILE_PREFIX = '__enest_fonts/'
/** Fonts selected by the user are the only shell-owned files exposed to a plugin. */
function resolveFontFile(filePath: string): string | null {
  if (!filePath.startsWith(FONT_FILE_PREFIX)) return null
  const name = filePath.slice(FONT_FILE_PREFIX.length)
  if (basename(name) !== name || !/\.(ttf|otf|woff2?)$/i.test(name)) return null
  if (!(settingsStore.getPluginAppearance().customFonts || []).some(font => font.fileName === name)) return null
  return join(getAppPathsRoot(), FONTS_DIR, name)
}
async function fontResponse(request: Request, path: string): Promise<Response> {
  const file = resolveFontFile(path)
  if (!file) return new Response('forbidden', { status: 403 })
  try { return await fileResponse(request, file, false) } catch { return new Response('not found', { status: 404 }) }
}


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
  '.wasm': 'application/wasm',
  '.md': 'text/markdown; charset=utf-8'
}

/** Register every scheme in one pre-ready call; later calls replace renderer privilege switches. */
export function registerSchemesAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        codeCache: true
      }
    },
    {
      scheme: QUICK_THEME_PROTOCOL,
      privileges: { standard: true, secure: true, corsEnabled: true, supportFetchAPI: true }
    },
    {
      scheme: 'enest-home',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
    },
    {
      scheme: 'enest-chrome',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
    },
    {
      scheme: 'enest-background',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
    },
    {
      scheme: 'enest-settings',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
    }
  ])
}

/** Only the host-owned Buffer LRU is synchronously invalidated; browser storage survives close. */
export function invalidatePluginFileCache(rootPath?: string): void {
  pluginAssetCache.invalidate(rootPath)
}

/** Update/dev-refresh/uninstall only. Empty urls clears this plugin partition's code cache. */
export async function invalidatePluginCodeCache(pluginId: string, urls?: string[]): Promise<void> {
  await session.fromPartition(pluginPartition(pluginId)).clearCodeCaches({ urls })
}

export function getPluginFileCacheStats(): { bytes: number; entries: number; pending: number } {
  return pluginAssetCache.getStats()
}

async function fileResponse(
  request: Request,
  abs: string,
  isDev: boolean,
  root?: string,
  revision?: string,
  pluginId?: string
): Promise<Response> {
  const csp = getPluginContentSecurityPolicy({ pluginId: pluginId ?? '', devUrl: pluginId ? pluginRegistry.get(pluginId)?.devUrl : undefined })
  return pluginFileResponse(request, abs, {
    mime: MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream',
    csp,
    dev: isDev,
    root,
    revision
  })
}

/** 解析 enest://plugin/{pluginId}/{filePath} URL，路径为空时默认 index.html */
function parsePluginUrl(url: string): { pluginId: string; filePath: string } | null {
  try {
    const u = new URL(url)
    if (u.protocol !== `${PROTOCOL}:` || u.hostname !== 'plugin') return null
    const parts = u.pathname.split('/').filter(Boolean)
    if (parts.length < 1) return null
    const pluginId = parts[0]
    const filePath = decodeURIComponent(parts.slice(1).join('/') || 'index.html')
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
  const publicUrl = new URL(request.url)
  if (publicUrl.hostname === 'appearance') {
    const match = /^\/(media|font)\/([^/]+)$/.exec(publicUrl.pathname)
    const resource = match && !publicUrl.username && !publicUrl.password && !publicUrl.search && !publicUrl.hash
      ? await resolveAppearanceResource(match[1] as 'media' | 'font', match[2]) : null
    if (!resource) return new Response('forbidden', { status: 403 })
    return pluginFileResponse(request, resource.path, { mime: resource.mime, root: resource.root, csp: "default-src 'none'" })
  }
  const mediaAbs = resolveMediaRequest(request.url)
  if (mediaAbs) {
    try {
      return await fileResponse(request, mediaAbs, !app.isPackaged)
    } catch {
      return new Response('not found', { status: 404 })
    }
  }

  const parsed = parsePluginUrl(request.url)
  if (!parsed) return new Response('bad request', { status: 400 })
  if (parsed.filePath.startsWith(FONT_FILE_PREFIX)) return fontResponse(request, parsed.filePath)
  // 主题 CSS 虚拟文件：动态生成，不落盘
  if (parsed.filePath === THEME_CSS_FILE) {
    return new Response(buildThemeCssForPlugin(parsed.pluginId), {
      headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' }
    })
  }
  const summary = pluginRegistry.get(parsed.pluginId)
  // 禁用只影响插件执行；图标、截图仍可通过真实安装/开发目录读取。
  const rootPath = pluginRegistry.getAssetRootPath(parsed.pluginId)
  if (!rootPath) return new Response('plugin not found', { status: 404 })
  const abs = await resolvePluginFile(rootPath, parsed.filePath, summary?.devSource === true)
  if (!abs) return new Response('forbidden', { status: 403 })
  try {
      return await fileResponse(request, abs, Boolean(summary?.dev), rootPath, pluginRegistry.getBuildRevision(parsed.pluginId), parsed.pluginId)
  } catch {
    return new Response('not found', { status: 404 })
  }
}

export function initPluginProtocol(): void {
  protocol.handle(PROTOCOL, handleEnestProtocol)
  registerQuickThemeProtocolForSession(session.defaultSession)
  // Shell 分区（主壳 + Quick 小窗）也要能加载插件 logo 等资源
  try {
    const shellSes = session.fromPartition(SHELL_PARTITION)
    registerQuickThemeProtocolForSession(shellSes)
    shellSes.protocol.handle(PROTOCOL, handleEnestProtocol)
  } catch {
    /* session 尚未就绪时忽略；窗口创建前会再确保 */
  }
}

/** 确保 SHELL_PARTITION 上已挂 enest://（Quick 等懒创建窗口前调用） */
export function ensureShellSessionProtocol(): void {
  try {
    const shellSes = session.fromPartition(SHELL_PARTITION)
    registerQuickThemeProtocolForSession(shellSes)
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
  const summary = pluginRegistry.get(pluginId)
  const isDev = summary?.dev === true
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
    if (parsed.filePath.startsWith(FONT_FILE_PREFIX)) return fontResponse(request, parsed.filePath)
    // 主题 CSS 虚拟文件（session 级 handler 同样支持）
    if (parsed.filePath === THEME_CSS_FILE) {
      return new Response(buildThemeCssForPlugin(pluginId), {
        headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' }
      })
    }
    const abs = await resolvePluginFile(rootPath, parsed.filePath, summary?.devSource === true)
    if (!abs) return new Response('forbidden', { status: 403 })
    try {
      return await fileResponse(request, abs, isDev, rootPath, pluginRegistry.getBuildRevision(pluginId), pluginId)
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}

export function fileUrlFor(rootPath: string, filePath: string): string {
  return `file://${join(rootPath, filePath)}`
}
