/**
 * pluginDataClear — 「全部重置」某个插件在数据根下的全部数据。
 * 职责：关闭运行中的插件 → 清存储 / 图片 / 文件 / 私有文档 / 密钥 / 会话与定时任务 →
 *       清插件设置、权限授权与快捷键。保留插件包本体与 Electron Partition（卸载才清）。
 * 为什么独立：与 PluginUninstaller 共用同一批清理函数，但不动安装目录、不重扫注册表、
 *       不回收贡献点（贡献点由 manifest 声明，重开插件时会重放）。
 * 被 shellHandlers（shell:clear-plugin-data）引用。
 */
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { pluginHost } from '@main/plugin/PluginHost'
import { withInstallLock } from '@main/plugin/PluginInstaller'
import { clearPluginStorage, releasePluginStorage } from '@main/db/pluginStorage'
import { getAppPaths, pluginStorageFile, retainAppPaths } from '@main/paths/pathsService'
import { existingOwnedDirectory } from '@main/paths/ownedDirectory'
import { vaultClearPlugin } from '@main/vault/secretVault'
import { deleteSessionSnapshot } from '@main/plugin/PluginSessionStore'
import { clearPluginDisabled } from '@main/plugin/pluginEnabledStore'
import { stopPluginBackground, refreshPluginBackgrounds } from '@main/plugin/pluginBackgroundRuntime'
import { stopPluginBackend } from '@main/plugin/pluginBackendRpc'
import { clearPrivateDocuments } from '@main/plugin/pluginPrivateDocuments'
import { clearPluginFileStreams } from '@main/plugin/pluginFileStreams'
import { clearPluginAssets } from '@main/plugin/pluginAssets'
import { clearPluginDeadlineTasks } from '@main/timer/deadlineTaskService'
import { clearPluginLaunch } from '@main/hotkey/pluginLaunchHotkeys'
import { refreshPluginMemoryAfterClose } from '@main/plugin/pluginMemoryMonitor'
import { settingsStore } from '@main/settings/SettingsStore'
import { homeSurfaceManager } from '@main/home/HomeSurfaceManager'
import { collectPluginDataUsage } from './pluginDataUsage'
import { isPackageId } from './packageIdentity'
import type { OrphanDataClearResult, PluginDataClearResult } from '@shared/types/plugin'

/** 与「释放资源」同一套关闭顺序；清理函数在运行时会直接抛错，所以必须先关 */
async function closeForClear(pluginId: string): Promise<void> {
  if (homeSurfaceManager.getMemoryOwners().some(owner => owner.pluginId === pluginId)) {
    throw new Error('该插件正被首页占用，请先切换到其他主题或离开首页')
  }
  stopPluginBackground(pluginId, 'plugin data cleared')
  await pluginHost.closePlugin(pluginId, 'tab-close', true)
  await stopPluginBackend(pluginId)
}

/** 关闭单个插件并清空它的全部数据；任何一步失败都抛出，由调用方汇总 */
export async function clearPluginData(pluginId: string): Promise<void> {
  if (!isPackageId(pluginId)) throw new Error('Invalid plugin id')
  return withInstallLock(pluginId, () => clearLocalData(pluginId))
}

async function clearLocalData(pluginId: string): Promise<void> {
  if (pluginHost.isBlockedForOpen(pluginId)) throw new Error('插件数据正在使用或等待恢复')
  if (!pluginRegistry.getInstalledPackage(pluginId) && !pluginRegistry.getInstalledDescriptors().some(item => item.id === pluginId)) {
    throw new Error('Plugin is not installed locally')
  }
  const releasePaths = retainAppPaths()
  const unblock = pluginHost.blockPlugin(pluginId, 'clear data')
  try {
    await closeForClear(pluginId)

    clearPluginStorage(pluginId)
    releasePluginStorage(pluginId)
    await clearPrivateDocuments(pluginId)
    await clearPluginFileStreams(pluginId)
    await clearPluginAssets(pluginId)
    vaultClearPlugin(pluginId)
    deleteSessionSnapshot(pluginId)
    clearPluginDeadlineTasks(pluginId)

    const legacy = pluginStorageFile(pluginId)
    for (const file of [legacy, `${legacy}.migrated`]) {
      if (existsSync(file)) await rm(file, { force: true })
    }

    // permissionGrants 是保留键，存在同一个 settings bag 里，随整包一起清掉
    await settingsStore.removePluginSettings(pluginId)
    await clearPluginLaunch(pluginId)
    await clearPluginDisabled(pluginId)
  } finally {
    unblock()
    releasePaths()
    refreshPluginBackgrounds()
    await refreshPluginMemoryAfterClose()
  }
}

/** pluginId 省略时清理全部已安装插件；单个失败不中断其余，结果里逐条列出 */
export async function clearPluginDataFor(pluginId?: string): Promise<PluginDataClearResult> {
  const targets = pluginId ? [pluginId] : pluginRegistry.getInstalledDescriptors().map(item => item.id)
  const before = await collectPluginDataUsage()
  const bytesOf = new Map(before.plugins.map(item => [item.pluginId, item.total - item.packageBytes]))
  let releasedBytes = 0
  let cleared = 0
  const failed: Record<string, string> = {}
  for (const id of targets) {
    try {
      await clearPluginData(id)
      cleared++
      releasedBytes += bytesOf.get(id) ?? 0
    } catch (error) {
      failed[id] = error instanceof Error ? error.message : String(error)
    }
  }
  return { ok: Object.keys(failed).length === 0, cleared, failed, releasedBytes }
}

/**
 * 清理全部未归属目录。删除前逐段校验路径仍是数据根下的规范目录（拒绝符号链接与 `..`），
 * 并重新统计一次确认它此刻仍未被任何插件认领——统计与清理之间可能有插件刚装上。
 */
export async function clearOrphanData(): Promise<OrphanDataClearResult> {
  const releasePaths = retainAppPaths()
  try {
    const usage = await collectPluginDataUsage()
    const failed: string[] = []
    let removed = 0
    for (const orphan of usage.orphans) {
      const root = getAppPaths().root
      const segments = orphan.relativePath.split('/')
      try {
        if (segments.some(segment => !segment || segment === '.' || segment === '..')) throw new Error('Invalid orphan path')
        const dir = await existingOwnedDirectory(root, ...segments)
        if (!dir) continue
        await rm(dir, { recursive: true, force: true })
        removed++
      } catch (error) {
        failed.push(`${orphan.relativePath}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { ok: failed.length === 0, removed, failed }
  } finally {
    releasePaths()
  }
}
