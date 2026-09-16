/**
 * PluginUninstaller — 插件卸载器
 * 职责：完整卸载一个已安装插件——关闭运行中 Tab → 清空 partition storage
 *       → 删除插件目录与 storage JSON → 重扫注册表 → 推送壳子事件。
 * 为什么独立：卸载横跨 Host（视图）、session（分区数据）、文件系统、Registry，
 *       放在任一现有模块都会造成循环依赖或职责膨胀。
 * 被 shellHandlers（ShellUninstallPlugin）调用。
 * 关键依赖：PluginHost（关 Tab + 生命周期）、PluginRegistry（重扫）、
 *       pathsService（目录）、PluginSessionStore、logService。
 */
import { session } from 'electron'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pluginPartition } from '@shared/constants'
import { logError, logInfo, logWarn } from '../logs/logService'
import { getAppPaths, pluginStorageFile } from '../paths/pathsService'
import { sendShellEvent } from '../window/createShellWindow'
import { clearPluginSession } from './PluginSessionStore'
import { pluginHost } from './PluginHost'
import { pluginRegistry } from './PluginRegistry'

export interface UninstallResult {
  ok: boolean
  error?: string
}

/**
 * 卸载插件完整流程。每一步都落日志；失败会继续尽量清理剩余项，
 * 最终通过 shell:event `uninstall-result` 通知壳子 toast + 刷新列表。
 */
export async function uninstallPlugin(pluginId: string): Promise<UninstallResult> {
  const id = String(pluginId ?? '').trim()
  if (!id) return { ok: false, error: 'plugin id required' }

  // 卸载前取展示名，删完目录后 Registry 已无此插件
  const summary = pluginRegistry.get(id)
  const name = summary?.name || id

  logInfo('uninstall', `start ${id} (${name})`)

  const errors: string[] = []

  // 1) 若插件正在运行，以 uninstall 原因关闭（beforeClose → destroy）
  try {
    if (pluginHost.isOpened(id)) {
      logInfo('uninstall', `closing open tab ${id}`)
      await pluginHost.closePlugin(id, 'uninstall')
    }
  } catch (err) {
    const msg = `close tab failed: ${(err as Error).message}`
    errors.push(msg)
    logWarn('uninstall', `${id} ${msg}`)
  }

  // 2) 生命周期：任意 → clearing-storage
  pluginHost.beginUninstall(id)

  // 3) 清空 partition（cookie / localStorage / IndexedDB / cache）
  try {
    const partition = pluginPartition(id)
    const ses = session.fromPartition(partition)
    await ses.clearStorageData()
    logInfo('uninstall', `cleared partition storage ${partition}`)
  } catch (err) {
    const msg = `clearStorageData failed: ${(err as Error).message}`
    errors.push(msg)
    logWarn('uninstall', `${id} ${msg}`)
  }

  // 4) 清空主进程会话态 bag
  try {
    clearPluginSession(id)
    logInfo('uninstall', `cleared session bag ${id}`)
  } catch (err) {
    logWarn('uninstall', `${id} session bag clear failed: ${(err as Error).message}`)
  }

  // 5) 删除 ~/eNest/plugins/{id} 整棵版本树
  try {
    const pluginDir = join(getAppPaths().plugins, id)
    if (existsSync(pluginDir)) {
      await rm(pluginDir, { recursive: true, force: true })
      logInfo('uninstall', `removed plugin dir ${pluginDir}`)
    } else {
      logInfo('uninstall', `plugin dir already absent ${pluginDir}`)
    }
  } catch (err) {
    const msg = `remove plugin dir failed: ${(err as Error).message}`
    errors.push(msg)
    logError('uninstall', `${id} ${msg}`)
  }

  // 6) 删除 storage.local JSON（与 partition 是两套数据）
  try {
    const storageJson = pluginStorageFile(id)
    if (existsSync(storageJson)) {
      await rm(storageJson, { force: true })
      logInfo('uninstall', `removed storage json ${storageJson}`)
    }
  } catch (err) {
    const msg = `remove storage json failed: ${(err as Error).message}`
    errors.push(msg)
    logWarn('uninstall', `${id} ${msg}`)
  }

  // 7) 开发态一并移除（若曾 addDevPlugin）
  try {
    pluginRegistry.removeDevPlugin(id)
  } catch {
    // 非开发态时无副作用
  }

  // 8) 重扫注册表，让列表回到磁盘真实状态
  try {
    await pluginRegistry.scan()
    logInfo('uninstall', `registry rescanned`)
  } catch (err) {
    const msg = `registry scan failed: ${(err as Error).message}`
    errors.push(msg)
    logWarn('uninstall', `${id} ${msg}`)
  }

  // 9) 生命周期：clearing-storage → uninstalled
  pluginHost.finishUninstall(id)

  const ok = errors.length === 0
  if (ok) {
    logInfo('uninstall', `done ${id}`)
  } else {
    logWarn('uninstall', `done with errors ${id}: ${errors.join('; ')}`)
  }

  // 10) 壳子事件：列表刷新 + 结果 toast（与 install-result 同级）
  sendShellEvent({ type: 'plugins-changed' })
  sendShellEvent({
    type: 'uninstall-result',
    pluginId: id,
    name,
    ok,
    error: ok ? undefined : errors.join('; ')
  })

  return ok ? { ok: true } : { ok: false, error: errors.join('; ') }
}
