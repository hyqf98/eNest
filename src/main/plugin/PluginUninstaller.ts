/**
 * PluginUninstaller — 插件卸载器
 * 职责：完整卸载一个已安装插件——关闭运行中 Tab → 清空 partition storage
 *       → 删除插件目录与 storage.local（SQLite 行 + 旧 JSON 残留）→ GC 其注册的主题包
 *       → 重扫注册表 → 推送壳子事件。
 * 为什么独立：卸载横跨 Host（视图）、session（分区数据）、文件系统、Registry、
 *       主题包与设置，放在任一现有模块都会造成循环依赖或职责膨胀。
 * 被 shellHandlers（ShellUninstallPlugin）调用。
 * 关键依赖：PluginHost（关 Tab + 生命周期）、PluginRegistry（重扫）、
 *       pathsService（目录）、PluginSessionStore、themePackRegistry、settingsStore、logService。
 */
import { session } from 'electron'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pluginPartition } from '@shared/constants'
import { clearPluginStorage } from '@main/db/pluginStorage'
import { logError, logInfo, logWarn } from '@main/logs/logService'
import { getAppPaths, pluginStorageFile } from '@main/paths/pathsService'
import { sendShellEvent } from '@main/window/createShellWindow'
import { clearPluginSession, deleteSessionSnapshot } from '@main/plugin/PluginSessionStore'
import { clearPluginDisabled } from '@main/plugin/pluginEnabledStore'
import { pluginHost } from '@main/plugin/PluginHost'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { forgetDevPlugin } from '@main/dev/DevConsole'
import { settingsStore } from '@main/settings/SettingsStore'
import { themePackRegistry } from '@main/theme/themePacks'
import { contributionRegistry } from '@main/contrib/ContributionRegistry'

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

  // 6) 清空 storage.local（enest.db plugin_storage 行）+ 会话快照；兼容删除旧 JSON 与迁移残留
  try {
    clearPluginStorage(id)
    logInfo('uninstall', `cleared plugin storage ${id}`)
  } catch (err) {
    const msg = `clear plugin storage failed: ${(err as Error).message}`
    errors.push(msg)
    logWarn('uninstall', `${id} ${msg}`)
  }
  try {
    deleteSessionSnapshot(id)
  } catch (err) {
    logWarn('uninstall', `${id} session snapshot delete failed: ${(err as Error).message}`)
  }
  try {
    // 旧版整文件 JSON（若从未被迁移）与迁移后保留的 {id}.json.migrated 一并清理
    const legacy = pluginStorageFile(id)
    for (const file of [legacy, `${legacy}.migrated`]) {
      if (existsSync(file)) {
        await rm(file, { force: true })
        logInfo('uninstall', `removed legacy storage file ${file}`)
      }
    }
  } catch (err) {
    const msg = `remove storage json failed: ${(err as Error).message}`
    errors.push(msg)
    logWarn('uninstall', `${id} ${msg}`)
  }

  // 7) 开发态一并移除（若曾 addDevPlugin）；清理启用/禁用记录避免重装后仍禁用
  try {
    pluginRegistry.removeDevPlugin(id)
  } catch {
    // 非开发态时无副作用
  }
  try {
    // 同步删掉 dev.json 里的路径，避免重启又把已移除的开发插件挂回来
    await forgetDevPlugin(id)
  } catch {
    // ignore
  }
  try {
    await clearPluginDisabled(id)
    logInfo('uninstall', `cleared disabled record ${id}`)
  } catch (err) {
    logWarn('uninstall', `${id} clear disabled record failed: ${(err as Error).message}`)
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

  // 8b) GC 该插件注册的主题包（source === pluginId）；活动 pack 指向被删包时清 packId
  try {
    const removedPackIds = await themePackRegistry.removeBySource(id)
    if (removedPackIds.length > 0) {
      logInfo('uninstall', `removed theme packs ${removedPackIds.join(', ')}`)
      const theme = settingsStore.getTheme()
      if (theme.packId && removedPackIds.includes(theme.packId)) {
        await settingsStore.setTheme({ packId: undefined })
        logInfo('uninstall', `cleared active packId ${theme.packId}`)
      }
      sendShellEvent({ type: 'theme-packs-changed' })
    }
  } catch (err) {
    const msg = `remove theme packs failed: ${(err as Error).message}`
    errors.push(msg)
    logWarn('uninstall', `${id} ${msg}`)
  }

  // 8c) GC 该插件的全部贡献点（设置 section / 首页卡片 / 轨道入口等）；
  //     目录已删除，重扫不会重放，必须在此显式清除
  try {
    contributionRegistry.unregisterBySource(id)
  } catch (err) {
    logWarn('uninstall', `${id} remove contributions failed: ${(err as Error).message}`)
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
