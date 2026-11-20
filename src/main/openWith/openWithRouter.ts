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
import { grantLocalFile, releaseLocalFileHandles } from '@main/plugin/localFiles'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { getMainWindow, getShellWebContents, sendShellEvent } from '@main/window/createShellWindow'
import { openNativeModal } from '@main/window/modalSurface'
import { extKey, schemeKey, validOpenWithValue, type OpenWithKey } from '@shared/types/openWith'
import type { LocalFileHandle } from '@shared/types/local-files'
import { associationService, type OpenWithProvider } from './associationService'

type OpenItem =
  | { kind: 'file'; paths: string[] }
  | { kind: 'url'; url: string }

const pending: OpenItem[] = []
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
  for (const paths of byExt.values()) enqueue({ kind: 'file', paths })
  for (const url of urls) handleOpenUrl(url)
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
  const value = item.kind === 'file' ? extOf(item.paths[0]) : schemeOf(item.url)
  if (!value) return
  const kind = item.kind === 'file' ? 'ext' : 'scheme'
  const key = kind === 'ext' ? extKey(value) : schemeKey(value)
  const target = associationService.resolveTarget(key)
  const builds = new Map(target.providers.map(provider => [provider.pluginId, pluginRegistry.getBuildRevision(provider.pluginId)]))
  let pluginId = target.pluginId
  if (target.ambiguous) {
    pluginId = await chooseProvider(key, target.providers)
    if (!pluginId) return
    if (builds.get(pluginId) !== pluginRegistry.getBuildRevision(pluginId) || !(await associationService.route(key, pluginId)).ok) {
      sendShellEvent({ type: 'open-with-unhandled', kind, value, reason: 'no-provider' })
      return
    }
  }
  if (!pluginId) {
    sendShellEvent({ type: 'open-with-unhandled', kind, value, reason: 'no-provider' })
    return
  }
  const owner = pluginId
  const currentBuild = () => pluginRegistry.isEnabled(owner) && builds.get(owner) === pluginRegistry.getBuildRevision(owner)
  const guard = () => currentBuild() && associationService.resolveTarget(key).pluginId === owner
  const handles: LocalFileHandle[] = []
  try {
    if (item.kind === 'file') {
      const assertCurrent = () => { if (!currentBuild()) throw new Error('打开方式的插件已变更') }
      for (const path of item.paths) handles.push(await grantLocalFile(owner, path, { writable: false }, assertCurrent))
    }
    const result = await launchPlugin({ pluginId: owner, source: 'open-with', mode: 'shell', guard,
      enter: item.kind === 'file' ? { code: 'open-file', type: 'files', payload: { paths: item.paths, handles } }
        : { code: 'open-url', payload: { url: item.url } } })
    if (!result.ok) throw new Error(result.error ?? '打开方式启动失败')
    logInfo('open-with', `open ${key} → ${owner}`)
  } catch (error) {
    releaseLocalFileHandles(owner, handles)
    sendShellEvent({ type: 'open-with-unhandled', kind, value, reason: 'launch-failed' })
    throw error
  }
}

async function chooseProvider(key: OpenWithKey, providers: OpenWithProvider[]): Promise<string | undefined> {
  const owner = getShellWebContents()
  const window = getMainWindow()
  if (!owner || owner.isDestroyed() || !window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  if (!window.isVisible()) window.show()
  window.focus()
  const label = key.startsWith('scheme:') ? `${key.slice('scheme:'.length)}:// 链接` : `.${key.slice('ext:'.length)} 文件`
  const out: { picked?: string } = {}
  let confirmed = false
  try {
    confirmed = await openNativeModal(owner, {
      kind: 'open-with-choice',
      options: {
        title: '选择打开方式',
        message: `选择处理 ${label} 的插件。eNest 会记住选择，不会更改系统默认应用。`,
        value: label,
        choices: providers.map(({ pluginId, pluginName, icon, glyph, color }) => ({
          pluginId, pluginName, icon, glyph, color
        }))
      }
    }, out)
  } catch (err) {
    logWarn('open-with', `choice modal failed: ${(err as Error).message}`)
  }
  return confirmed && providers.some(provider => provider.pluginId === out.picked) ? out.picked : undefined
}

function extOf(path: string): string | null {
  const ext = extname(path).slice(1).toLowerCase()
  return ext || null
}

function schemeOf(url: string): string | null {
  const match = /^([a-z][a-z0-9+.-]{1,63}):/i.exec(url)
  if (!match) return null
  const scheme = match[1].toLowerCase()
  return validOpenWithValue('scheme', scheme) ? scheme : null
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
