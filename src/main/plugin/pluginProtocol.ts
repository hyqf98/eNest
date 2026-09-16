/**
 * pluginProtocol — 自定义协议 enest://
 * 职责：注册 enest:// 协议，将插件资源请求映射到本地文件系统，包含路径穿越防护与 CSP 注入；
 * 另提供 enest://media/?path= 读取用户主目录 / 数据根下的本地媒体（背景图/视频）。
 * 被 index.ts（initPluginProtocol）与 PluginHost（registerPluginProtocolForSession）调用。
 * 关键依赖：PluginRegistry（查找 rootPath）、pathsService（数据根）、@shared/constants（PROTOCOL）。
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { protocol, type Session } from 'electron'
import { PROTOCOL } from '@shared/constants'
import { resolvePluginUi } from '@shared/types/plugin'
import { getAppPaths } from '@main/paths/pathsService'
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

/** 绝对路径是否落在允许的媒体根（用户主目录或数据根）内 */
function isAllowedMediaPath(abs: string): boolean {
  const roots = [homedir(), getAppPaths().root]
  for (const root of roots) {
    if (!root) continue
    const rel = relative(root, abs)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return true
    if (rel === '') return true
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
export function initPluginProtocol(): void {
  protocol.handle(PROTOCOL, async (request) => {
    const mediaAbs = resolveMediaRequest(request.url)
    if (mediaAbs) {
      try {
        return await fileResponse(mediaAbs, true)
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
      return await fileResponse(abs, Boolean(summary.devUrl))
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}

/** Session-scoped handler: only serves the given plugin root. */
export function registerPluginProtocolForSession(
  ses: Session,
  pluginId: string,
  rootPath: string
): void {
  const isDev = false // session 级始终走生产 CSP，开发态插件走默认 session
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
      return await fileResponse(abs, isDev)
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}

export function fileUrlFor(rootPath: string, filePath: string): string {
  return `file://${join(rootPath, filePath)}`
}
