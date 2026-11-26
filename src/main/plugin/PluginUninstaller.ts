/**
 * PluginUninstaller — 插件卸载器
 * 职责：完整卸载一个已安装插件——关闭运行中 Tab → 清空 partition storage 与磁盘残壳
 *       → 删除插件目录、storage.local（SQLite 行 + 旧 JSON 残留）与密钥保险库
 *       → GC 其注册的主题包 → 重扫注册表 → 推送壳子事件。
 * 为什么独立：卸载横跨 Host（视图）、session（分区数据）、文件系统、Registry、
 *       主题包与设置，放在任一现有模块都会造成循环依赖或职责膨胀。
 * 被 shellHandlers（ShellUninstallPlugin）调用。
 * 关键依赖：PluginHost（关 Tab + 生命周期）、PluginRegistry（重扫）、
 *       pathsService（目录）、PluginSessionStore、themePackRegistry、settingsStore、logService。
 */
import { app, session } from 'electron'
import { existsSync } from 'node:fs'
import { readdir, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_SUBDIR, PLUGINS_DIR, pluginPartition, pluginPartitionDirName } from '@shared/constants'
import { clearPluginStorage } from '@main/db/pluginStorage'
import { kvDelete } from '@main/db/sqliteService'
import { logError, logInfo, logWarn } from '@main/logs/logService'
import { getAppPaths, getAppPathsGeneration, pluginStorageFile, retainAppPaths } from '@main/paths/pathsService'
import { existingOwnedDirectory } from '@main/paths/ownedDirectory'
import { vaultClearPlugin } from '@main/vault/secretVault'
import { sendShellEvent } from '@main/window/createShellWindow'
import { clearPluginSession, deleteSessionSnapshot } from '@main/plugin/PluginSessionStore'
import { clearPluginDisabled } from '@main/plugin/pluginEnabledStore'
import { permissionService } from '@main/plugin/PermissionService'
import { withInstallLock, cancelPluginInstalls } from '@main/plugin/PluginInstaller'
import { isPackageId, isPackageVersion } from './packageIdentity'
import { ownedPackageVersion } from './packageOwnership'
import { invalidatePluginCodeCache, invalidatePluginFileCache } from '@main/plugin/pluginProtocol'
import { pluginHost } from '@main/plugin/PluginHost'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { dropUninstalledDevRegistration } from '@main/dev/DevConsole'
import { settingsStore } from '@main/settings/SettingsStore'
import { themePackRegistry } from '@main/theme/themePacks'
import { contributionRegistry } from '@main/contrib/ContributionRegistry'
import { clearPluginDeadlineTasks } from '@main/timer/deadlineTaskService'
import { refreshPluginBackgrounds, stopPluginBackground } from '@main/plugin/pluginBackgroundRuntime'
import { clearPrivateDocuments } from '@main/plugin/pluginPrivateDocuments'
import { clearPluginFileStreams } from '@main/plugin/pluginFileStreams'
import { clearPluginAssets } from '@main/plugin/pluginAssets'
import { getDevPluginSource } from '@main/dev/devPluginRuntime'
import { quickProviderStates } from '@main/theme/quickStateService'
import { suspendQuickThemeSource } from '@main/theme/quickThemeProtocol'

export interface UninstallResult {
  ok: boolean
  error?: string
}

/**
 * 卸载插件完整流程。每一步都落日志；失败会继续尽量清理剩余项，
 * 最终通过 shell:event `uninstall-result` 通知壳子 toast + 刷新列表。
 */
export async function uninstallPlugin(pluginId: string): Promise<UninstallResult> {
  if (!isPackageId(pluginId)) return { ok: false, error: 'Invalid plugin id' }
  const installed = pluginRegistry.getInstalledPackage(pluginId), source = getDevPluginSource(pluginId)
  if (!installed && !source || !pluginRegistry.get(pluginId)?.installed) return { ok: false, error: 'Plugin is not installed locally' }
  const generation = getAppPathsGeneration(), releasePaths = retainAppPaths()
  const paths = getAppPaths()
  const assertSelected = () => {
    const current = pluginRegistry.getInstalledPackage(pluginId)
    if (generation !== getAppPathsGeneration() || current?.rootPath !== installed?.rootPath || current?.buildRevision !== installed?.buildRevision
      || current && (current.manifest.id !== pluginId || current.rootPath !== join(paths.plugins, pluginId, current.version))
      || getDevPluginSource(pluginId) !== source || !pluginRegistry.get(pluginId)?.installed) throw new Error('Local registration changed')
  }
  try {
    assertSelected()
    await Promise.all([existingOwnedDirectory(paths.root, PLUGINS_DIR, ...(installed ? [pluginId] : [])),
      existingOwnedDirectory(paths.root, DATA_SUBDIR, 'secrets', pluginId), existingOwnedDirectory(paths.root, DATA_SUBDIR, 'plugin-storage'),
      existingOwnedDirectory(paths.root, DATA_SUBDIR, 'plugin-documents'), existingOwnedDirectory(app.getPath('userData'), 'Partitions', pluginPartitionDirName(pluginId))])
    assertSelected()
    cancelPluginInstalls(pluginId)
    return await withInstallLock(pluginId, async () => {
      assertSelected()
      const sources = await pluginRegistry.getDevSourcePaths()
      const tree = installed ? await ownedInstallTree(pluginId, installed.version, sources) : null
      assertSelected()
      const release = pluginHost.blockPlugin(pluginId, 'uninstall')
      try {
        const resumeTheme = suspendQuickThemeSource(pluginId)
        try {
          stopPluginBackground(pluginId, 'plugin uninstall')
          return await uninstallLocked(pluginId, tree)
        } finally { resumeTheme() }
      } finally { release() }
    })
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  finally { releasePaths() }
}

interface OwnedInstallTree { directory: string; versions: string[] }

async function ownedInstallTree(id: string, activeVersion: string, sources: string[]): Promise<OwnedInstallTree> {
  const paths = getAppPaths()
  const directory = await existingOwnedDirectory(paths.root, PLUGINS_DIR, id)
  if (!directory) throw new Error('Installed package directory changed')
  const versions: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isPackageVersion(entry.name) || entry.name === activeVersion) continue
    if (await ownedPackageVersion(paths.plugins, id, entry.name, sources, true)) versions.push(entry.name)
  }
  if (!await ownedPackageVersion(paths.plugins, id, activeVersion, sources)) throw new Error('Installed package directory changed')
  return { directory, versions: [...versions, activeVersion] }
}

async function uninstallLocked(id: string, tree: OwnedInstallTree | null): Promise<UninstallResult> {
  // 卸载前取展示名，删完目录后 Registry 已无此插件
  const summary = pluginRegistry.get(id)
  const name = summary?.name || id
  const selectedPack = settingsStore.getTheme().packId
  const ownedPack = selectedPack && themePackRegistry.get(selectedPack)?.source === id ? selectedPack : undefined

  logInfo('uninstall', `start ${id} (${name})`)

  const errors: string[] = []

  // 1) 若插件正在运行，以 uninstall 原因关闭（beforeClose → destroy）
  try {
    logInfo('uninstall', `closing open tab ${id}`)
    await pluginHost.closePlugin(id, 'uninstall')
  } catch (err) {
    const msg = `close tab failed: ${(err as Error).message}`
    logWarn('uninstall', `${id} ${msg}`)
    sendShellEvent({ type: 'uninstall-result', pluginId: id, name, ok: false, error: msg })
    return { ok: false, error: msg }
  }

  try {
    if (tree) {
      const paths = getAppPaths(), sources = await pluginRegistry.getDevSourcePaths()
      for (const version of tree.versions) {
        const directory = await ownedPackageVersion(paths.plugins, id, version, sources)
        if (!directory) throw new Error('Installed package directory changed')
        await rm(directory, { recursive: true })
      }
      await rmdir(tree.directory).catch(error => { if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error })
      pluginRegistry.removeInstalledBuild(id)
    }
  } catch (err) {
    const message = `remove plugin dir failed: ${(err as Error).message}`
    logError('uninstall', `${id} ${message}`)
    sendShellEvent({ type: 'uninstall-result', pluginId: id, name, ok: false, error: message })
    return { ok: false, error: message }
  }

  // Timers outlive renderer tabs, so uninstall explicitly removes their state and records.
  try { await clearPluginDeadlineTasks(id) } catch (err) {
    const msg = `clear deadline tasks failed: ${(err as Error).message}`
    errors.push(msg)
    logWarn('uninstall', `${id} ${msg}`)
  }

  // 2) 生命周期：任意 → clearing-storage
  pluginHost.beginUninstall(id)

  // 2b) 取消该插件挂起/排队中的权限请求（按拒绝 settle，不持久化）
  permissionService.cancelFor(id)

  // 3) 清空 partition（cookie / localStorage / IndexedDB / cache）
  try {
    const partition = pluginPartition(id)
    const ses = session.fromPartition(partition)
    await ses.clearStorageData()
    await invalidatePluginCodeCache(id)
    if (summary?.rootPath) invalidatePluginFileCache(summary.rootPath)
    logInfo('uninstall', `cleared partition storage ${partition}`)
  } catch (err) {
    const msg = `clearStorageData failed: ${(err as Error).message}`
    errors.push(msg)
    logWarn('uninstall', `${id} ${msg}`)
  }

  // 3b) 删除 partition 磁盘残壳：clearStorageData 只清数据不删目录；
  //     best-effort（Windows 下句柄未放会失败），残留无数据，不计入卸载错误
  try {
    const partitionDir = await existingOwnedDirectory(app.getPath('userData'), 'Partitions', pluginPartitionDirName(id))
    if (partitionDir) {
      await rm(partitionDir, { recursive: true, force: true })
      logInfo('uninstall', `removed partition dir ${partitionDir}`)
    }
  } catch (err) {
    logWarn('uninstall', `${id} remove partition dir failed: ${(err as Error).message}`)
  }

  // 4) 清空主进程会话态 bag
  try {
    clearPluginSession(id)
    logInfo('uninstall', `cleared session bag ${id}`)
  } catch (err) {
    logWarn('uninstall', `${id} session bag clear failed: ${(err as Error).message}`)
  }

  try {
    quickProviderStates.removeSource(id)
  } catch (err) {
    const msg = `clear Quick provider state failed: ${(err as Error).message}`
    errors.push(msg)
    logWarn('uninstall', `${id} ${msg}`)
  }
  try {
    await settingsStore.removePluginSettings(id)
    refreshPluginBackgrounds()
    logInfo('uninstall', `cleared plugin settings and permissions ${id}`)
  } catch (err) {
    const msg = `clear plugin settings failed: ${(err as Error).message}`
    errors.push(msg)
    logWarn('uninstall', `${id} ${msg}`)
  }
  try {
    kvDelete(`launcher.pinned:${id}`)
  } catch (err) {
    const msg = `clear launcher targets failed: ${(err as Error).message}`
    errors.push(msg)
    logWarn('uninstall', `${id} ${msg}`)
  }
  try {
    const removedSecrets = vaultClearPlugin(id)
    logInfo('uninstall', `cleared vault secrets ${id} (${removedSecrets})`)
  } catch (err) {
    const msg = `clear vault secrets failed: ${(err as Error).message}`
    errors.push(msg)
    logWarn('uninstall', `${id} ${msg}`)
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

  try { await clearPrivateDocuments(id) } catch (error) { errors.push(`remove private documents failed: ${String(error)}`) }
  try { await clearPluginFileStreams(id) } catch (error) { errors.push(`remove private outputs failed: ${String(error)}`) }
  try { await clearPluginAssets(id) } catch (error) { errors.push(`remove plugin assets failed: ${String(error)}`) }

  // 7) 开发态一并移除（若曾 addDevPlugin）；清理启用/禁用记录避免重装后仍禁用
  try {
    await dropUninstalledDevRegistration(id)
  } catch (error) {
    errors.push(`remove development registration failed: ${String(error)}`)
  }
  try {
    await clearPluginDisabled(id)
    logInfo('uninstall', `cleared disabled record ${id}`)
  } catch (err) {
    logWarn('uninstall', `${id} clear disabled record failed: ${(err as Error).message}`)
  }

  // 8b) GC 该插件注册的主题包（source === pluginId）；活动 pack 指向被删包时清 packId
  try {
    await pluginRegistry.waitForThemeContributions(id)
    const removedPackIds = await themePackRegistry.removeBySource(id)
    if (removedPackIds.length > 0 || ownedPack) {
      logInfo('uninstall', `removed theme packs ${removedPackIds.join(', ')}`)
      const theme = settingsStore.getTheme()
      if (theme.packId && (removedPackIds.includes(theme.packId) || theme.packId === ownedPack) && !themePackRegistry.get(theme.packId)) {
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

  // 8d) GC 指向该插件的「打开方式」路由（openWith 段仅主进程写）
  try {
    await settingsStore.removeOpenWithRoutesForPlugin(id)
  } catch (err) {
    logWarn('uninstall', `${id} remove openWith routes failed: ${(err as Error).message}`)
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
