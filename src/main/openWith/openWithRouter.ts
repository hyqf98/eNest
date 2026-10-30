/**
 * openWithRouter — 外部打开路由（双击文件 / 点击链接 → 对应插件）
 *
 * 入口：
 *  - macOS：app.on('open-file') / app.on('open-url')（ready 前入队）
 *  - Windows/Linux：second-instance argv、冷启动 process.argv
 * 处理：
 *  - 解析类型/scheme → associationService.resolveTarget（路由表优先，单候选自动路由）
 *  - 命中后签发只读文件句柄（不把裸路径交给插件）→ launchPlugin(mode='shell')
 *  - 多候选时暂停并请渲染层选择（open-with-choice），选择后恢复
 *  - 无人接手/启动失败发 open-with-unhandled 供壳内提示
 */
import { existsSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'
import { launchPlugin } from '@main/launcher/pluginLauncher'
import { logInfo, logWarn } from '@main/logs/logService'
import { isAbsoluteLocalUserPath, resolveLocalUserPath } from '@main/paths/userPath'
import { grantLocalFile } from '@main/plugin/localFiles'
import { getShellWebContents, sendShellEvent } from '@main/window/createShellWindow'
import { openNativeModal } from '@main/window/modalSurface'
import { extKey, schemeKey, type OpenWithKey } from '@shared/types/openWith'
import { associationService, type OpenWithProvider } from './associationService'

type OpenItem =
  | { kind: 'file'; paths: string[] }
  | { kind: 'url'; url: string }

const pending: OpenItem[] = []
/** 等待用户选择的条目：key → items（选择后恢复） */
const deferred = new Map<OpenWithKey, OpenItem[]>()
/** 已发出选择请求但尚未响应的 key（避免重复弹框） */
const awaitingChoice = new Set<OpenWithKey>()
let readyProbe: (() => boolean) | null = null
let flushing = false

export function setOpenWithReadyProbe(probe: () => boolean): void {
  readyProbe = probe
}

/** macOS open-file（ready 前事件也会入队） */
export function handleOpenFile(path: string): void {
  const resolved = normalizeFileArg(path)
  if (!resolved) return
  enqueue({ kind: 'file', paths: [resolved] })
}

/** macOS open-url / 通用 URL 打开 */
export function handleOpenUrl(url: string): void {
  const scheme = schemeOf(url)
  if (!scheme) return
  enqueue({ kind: 'url', url })
}

/** Windows/Linux：second-instance 或冷启动 argv */
export function handleOpenWithArgv(argv: string[]): void {
  if (!Array.isArray(argv) || !argv.length) return
  const skip = new Set<string>([process.execPath, app.getAppPath(), '.'])
  const byExt = new Map<string, string[]>()
  const urls: string[] = []
  for (const raw of argv.slice(1)) {
    if (!raw || raw.startsWith('-') || skip.has(raw)) continue
    if (/^file:\/\//i.test(raw)) {
      const path = safeFileUrlToPath(raw)
      const ext = path ? extOf(path) : null
      if (path && ext) byExt.set(ext, [...(byExt.get(ext) ?? []), path])
      continue
    }
    if (schemeOf(raw)) {
      urls.push(raw)
      continue
    }
    const path = normalizeFileArg(raw)
    const ext = path ? extOf(path) : null
    if (path && ext) byExt.set(ext, [...(byExt.get(ext) ?? []), path])
  }
  for (const [ext, paths] of byExt) enqueue({ kind: 'file', paths })
  for (const url of urls) handleOpenUrl(url)
}

/** 渲染层完成「用哪个插件打开」选择后调用：写路由并恢复被暂停的条目 */
export async function resumeDeferredOpen(key: OpenWithKey, pluginId: string): Promise<boolean> {
  const result = await associationService.route(key, pluginId)
  awaitingChoice.delete(key)
  if (!result.ok) return false
  const items = deferred.get(key)
  deferred.delete(key)
  if (items?.length) {
    pending.push(...items)
    void flush()
  }
  return true
}

/** 窗口就绪后由 index.ts 调用，处理启动期排队的打开请求 */
export function flushPendingOpenWith(): void {
  void flush()
}

function enqueue(item: OpenItem): void {
  pending.push(item)
  void flush()
}

async function flush(): Promise<void> {
  if (flushing || !readyProbe?.()) return
  flushing = true
  try {
    while (pending.length) {
      const item = pending.shift()!
      try {
        await routeItem(item)
      } catch (err) {
        logWarn('open-with', `route failed: ${(err as Error).message}`)
      }
    }
  } finally {
    flushing = false
  }
}

async function routeItem(item: OpenItem): Promise<void> {
  if (item.kind === 'file') {
    const ext = extOf(item.paths[0])
    if (!ext) return
    const key = extKey(ext)
    const target = associationService.resolveTarget(key)
    if (target.ambiguous) {
      await defer(key, item, target.providers)
      return
    }
    if (!target.pluginId) {
      sendShellEvent({ type: 'open-with-unhandled', kind: 'ext', value: ext, reason: 'no-provider' })
      return
    }
    const pluginId = target.pluginId
    const handles = await Promise.all(
      item.paths.map((path) => grantLocalFile(pluginId, path, { writable: false }))
    )
    logInfo('open-with', `open ${item.paths.length} file(s) .${ext} → ${pluginId}`)
    const result = await launchPlugin({
      pluginId,
      source: 'open-with',
      mode: 'shell',
      enter: { code: 'open-file', type: 'files', payload: { paths: item.paths, handles } }
    })
    if (!result.ok) {
      sendShellEvent({ type: 'open-with-unhandled', kind: 'ext', value: ext, reason: 'launch-failed' })
    }
    return
  }

  const scheme = schemeOf(item.url)
  if (!scheme) return
  const key = schemeKey(scheme)
  const target = associationService.resolveTarget(key)
  if (target.ambiguous) {
    await defer(key, item, target.providers)
    return
  }
  if (!target.pluginId) {
    sendShellEvent({ type: 'open-with-unhandled', kind: 'scheme', value: scheme, reason: 'no-provider' })
    return
  }
  const result = await launchPlugin({
    pluginId: target.pluginId,
    source: 'open-with',
    mode: 'shell',
    enter: { code: 'open-url', payload: { url: item.url } }
  })
  if (!result.ok) {
    sendShellEvent({ type: 'open-with-unhandled', kind: 'scheme', value: scheme, reason: 'launch-failed' })
  }
}

/** 多候选：入队等待 + 原生选择框；选中写路由并恢复，取消则丢弃本次打开 */
async function defer(key: OpenWithKey, item: OpenItem, providers: OpenWithProvider[]): Promise<void> {
  deferred.set(key, [...(deferred.get(key) ?? []), item])
  if (awaitingChoice.has(key)) return
  awaitingChoice.add(key)
  const owner = getShellWebContents()
  if (!owner || owner.isDestroyed()) return
  const label = key.startsWith('scheme:') ? `${key.slice('scheme:'.length)}:// 链接` : `.${key.slice('ext:'.length)} 文件`
  const out: { picked?: string } = {}
  let confirmed = false
  try {
    confirmed = await openNativeModal(owner, {
      kind: 'open-with-choice',
      options: {
        title: '选择打开方式',
        message: `要用哪个组件打开此${label}？选择后会记住，下次直接打开。`,
        value: label,
        choices: providers.map(({ pluginId, pluginName, icon, glyph, color }) => ({
          pluginId, pluginName, icon, glyph, color
        }))
      }
    }, out)
  } catch (err) {
    logWarn('open-with', `choice modal failed: ${(err as Error).message}`)
  }
  if (confirmed && out.picked) {
    await resumeDeferredOpen(key, out.picked)
  } else {
    deferred.delete(key)
    awaitingChoice.delete(key)
  }
}

function extOf(path: string): string | null {
  const ext = extname(path).slice(1).toLowerCase()
  return ext || null
}

function schemeOf(url: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)
  if (!match) return null
  const scheme = match[1].toLowerCase()
  if (scheme === 'http' || scheme === 'https' || scheme === 'file' || scheme === 'enest') return null
  return scheme
}

function normalizeFileArg(raw: string): string | null {
  if (typeof raw !== 'string' || !raw.trim() || !isAbsoluteLocalUserPath(raw)) return null
  try {
    const path = resolveLocalUserPath(raw, { baseDir: process.cwd() })
    if (!existsSync(path) || !statSync(path).isFile()) return null
    return path
  } catch {
    return null
  }
}

function safeFileUrlToPath(url: string): string | null {
  try {
    const path = fileURLToPath(url)
    return normalizeFileArg(path)
  } catch {
    return null
  }
}
