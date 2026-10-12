/**
 * DevConsole — 开发态插件加载
 * 职责：从本地目录加载开发中的插件（跳过安装流程），注册到 PluginRegistry 的 dev 通道；
 *       路径写入 dev.json，启动时 restoreDevPlugins 重新挂载。
 * 被 shellHandlers 的 ShellLoadDevPlugin 通道调用。
 * 关键依赖：PluginInstaller、PluginRegistry、devPluginsStore。
 */
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { dialog } from 'electron'
import { installFromDirectory } from '@main/plugin/PluginInstaller'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { invalidatePluginFileCache } from '@main/plugin/pluginProtocol'
import type { PluginForm, PluginManifest, PluginSummary } from '@shared/types/plugin'
import { resolvePluginForm, resolvePluginUi } from '@shared/types/plugin'
import { logInfo, logWarn } from '@main/logs/logService'
import {
  dropDevPluginRecord,
  readDevPluginRecords,
  upsertDevPluginRecord,
  writeDevPluginRecords
} from '@main/dev/devPluginsStore'

function colorFor(category: string): string {
  switch (category) {
    case '效率':
      return '#5b8cff'
    case '开发':
      return '#3ddc97'
    case '设计':
      return '#a78bfa'
    case '媒体':
      return '#38bdf8'
    default:
      return '#f5a524'
  }
}

function glyphFor(name: string): string {
  const ch = (name || '?').trim().charAt(0)
  return ch || '⌥'
}

/** 从指定目录加载开发态插件，注册到 PluginRegistry 的 dev 通道（不复制到 userData） */
export async function loadDevPlugin(dirPath: string): Promise<PluginSummary> {
  const manifest: PluginManifest = await installFromDirectory(dirPath)
  const category = (manifest as { category?: string }).category || '开发'
  const form: PluginForm = resolvePluginForm(manifest.form)
  const summary: PluginSummary = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description ?? '',
    author: manifest.author ?? '',
    category,
    installs: 'dev',
    color: colorFor(category),
    glyph: glyphFor(manifest.name),
    permissions: manifest.permissions ?? [],
    installed: true,
    rootPath: dirPath,
    devUrl: manifest.development?.main,
    dev: true,
    form,
    ui: resolvePluginUi(manifest.ui)
  }
  const registered = pluginRegistry.addDevPlugin(summary, manifest)
  // 持久化源码路径，重启后可自动恢复
  try {
    await upsertDevPluginRecord(manifest.id, dirPath)
  } catch (err) {
    logWarn('dev', `persist dev plugin failed: ${(err as Error).message}`)
  }
  // 文件型插件挂目录监听实现「改码即刷新」；devUrl 插件由 Vite HMR 自理
  if (!summary.devUrl) watchDevSource(manifest.id, dirPath)
  logInfo('dev', `loaded ${manifest.id} from ${dirPath}${summary.devUrl ? ` (HMR ${summary.devUrl})` : ' (watching)'}`)
  return registered
}

/** 可选路径：未传时弹出系统目录选择对话框，用户取消返回 null */
export async function pickAndLoadDevPlugin(dirPath?: string): Promise<PluginSummary | null> {
  let dir = dirPath?.trim() || undefined
  if (!dir) {
    const result = await dialog.showOpenDialog({
      title: '选择插件目录',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    dir = result.filePaths[0]
  }
  return loadDevPlugin(dir)
}

/**
 * 启动时恢复：读 dev.json，目录仍在则重新 load 进 registry。
 * 目录不存在的记录会从列表里清掉，避免脏数据堆积。
 * 同时恢复「退出即杀」开关到 PluginHost 内存（主进程重启后集合为空）。
 */
export async function restoreDevPlugins(): Promise<void> {
  const records = await readDevPluginRecords()
  if (!records.length) return
  const { pluginHost } = await import('@main/plugin/PluginHost')
  const alive: typeof records = []
  for (const rec of records) {
    if (!existsSync(rec.path)) {
      logWarn('dev', `skip restore ${rec.id}: path missing ${rec.path}`)
      continue
    }
    try {
      await loadDevPlugin(rec.path)
      if (rec.killOnHide) pluginHost.setKillOnHide(rec.id, true)
      alive.push(rec)
    } catch (err) {
      logWarn('dev', `restore ${rec.id} failed: ${(err as Error).message}`)
    }
  }
  if (alive.length !== records.length) {
    await writeDevPluginRecords(alive).catch(() => undefined)
  }
  if (alive.length) {
    logInfo('dev', `restored ${alive.length} dev plugin(s)`)
  }
}

/** 卸载开发态时同步删掉持久化记录 */
export async function forgetDevPlugin(id: string): Promise<void> {
  unwatchDevSource(id)
  try {
    await dropDevPluginRecord(id)
  } catch (err) {
    logWarn('dev', `drop dev record failed: ${(err as Error).message}`)
  }
}

// —— dev 源码目录监听：改码保存 → 插件视图自动刷新 ——

interface DevSourceWatch {
  watcher: FSWatcher
  timer: NodeJS.Timeout | null
}

const devWatchers = new Map<string, DevSourceWatch>()

/** 编辑器/系统临时文件，变更不触发刷新 */
const TRANSIENT_FILE = /(^|\/)(\.DS_Store|[^/]*\.swp|[^/]*~|#[^/]*#|[^/]*\.tmp)$/

const RELOAD_DEBOUNCE_MS = 400

/** 监听 dev 插件源码目录（递归）。已在监听则先摘旧表再挂新表。 */
function watchDevSource(pluginId: string, dirPath: string): void {
  unwatchDevSource(pluginId)
  try {
    const state: DevSourceWatch = { watcher: null as unknown as FSWatcher, timer: null }
    const onChange = (_event: string, file: string | null): void => {
      if (!file || TRANSIENT_FILE.test(file)) return
      if (state.timer) clearTimeout(state.timer)
      state.timer = setTimeout(() => {
        state.timer = null
        void handleDevSourceChange(pluginId)
      }, RELOAD_DEBOUNCE_MS)
    }
    state.watcher = watch(dirPath, { recursive: true }, onChange)
    state.watcher.on('error', (err) => {
      logWarn('dev', `watch ${pluginId} error: ${err.message}`)
      unwatchDevSource(pluginId)
    })
    devWatchers.set(pluginId, state)
  } catch (err) {
    logWarn('dev', `watch ${pluginId} failed: ${(err as Error).message}`)
  }
}

function unwatchDevSource(pluginId: string): void {
  const state = devWatchers.get(pluginId)
  if (!state) return
  if (state.timer) clearTimeout(state.timer)
  state.watcher.close()
  devWatchers.delete(pluginId)
}

/**
 * 源码变更落定后的处理：
 * - 打开中（View 存活）→ reloadPlugin 全套刷新（忽略缓存 + 协议重绑）；
 * - 休眠/未打开 → 仅失效文件缓存，下次唤醒或打开即读到新代码，不主动唤醒打扰。
 */
async function handleDevSourceChange(pluginId: string): Promise<void> {
  const { pluginHost } = await import('@main/plugin/PluginHost')
  const summary = pluginRegistry.get(pluginId)
  const rootPath = summary?.rootPath
  if (pluginHost.isOpened(pluginId) && !pluginHost.isHibernated(pluginId)) {
    pluginHost.reloadPlugin(pluginId)
    logInfo('dev', `source changed, reloaded ${pluginId}`)
    return
  }
  if (rootPath) {
    try {
      invalidatePluginFileCache(rootPath)
    } catch {
      /* cache miss 可忽略 */
    }
    logInfo('dev', `source changed (idle), cache invalidated for ${pluginId}`)
  }
}
