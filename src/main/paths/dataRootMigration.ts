/**
 * dataRootMigration — 把整个数据根迁到新目录。
 * 职责：暂停全部插件与首页 → 落盘并关闭数据库 → 把旧根完整复制到新根 → 切换指针 → 恢复。
 * 设计：
 *  - 复制而非移动：旧目录原样保留，由用户确认无误后自行处理，迁移出问题时永远有退路；
 *  - 先复制到同级临时目录再 rename 到位，新根不会出现半成品；
 *  - 任一步失败即回滚：删临时目录、重开旧库、恢复插件，旧根与设置保持原状；
 *  - 迁移期间持有路径租约，并发的 dataRoot 写入会被 pathsService 拒绝；切根前释放租约。
 * 已知边界：日志写句柄、字体缓存等运行期资源仍指向旧路径，重启后才完全切换。
 * 被 shellHandlers（shell:migrate-data-root）引用。
 */
import { promises as fs } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { kvStore } from '@main/db/sqliteService'
import { initPluginStorage, flushAll } from '@main/db/pluginStorage'
import { getAppPaths, getAppPathsGeneration, retainAppPaths } from '@main/paths/pathsService'
import { resolveLocalUserPath } from '@main/paths/userPath'
import { reloadDeadlineTasks, shutdownDeadlineTasks } from '@main/timer/deadlineTaskService'
import { resetLogsDir, logError, logInfo } from '@main/logs/logService'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { pluginHost } from '@main/plugin/PluginHost'
import { stopPluginBackground, refreshPluginBackgrounds } from '@main/plugin/pluginBackgroundRuntime'
import { stopPluginBackend } from '@main/plugin/pluginBackendRpc'
import { homeSurfaceManager, prewarmHomeSurface } from '@main/home/HomeSurfaceManager'
import { settingsStore } from '@main/settings/SettingsStore'
import type { DataRootMigrationResult } from '@shared/types/plugin'

/** 复制时跳过的运行期文件：关库时 WAL 已落盘，侧文件再复制会与主库不一致 */
const DATABASE_SIDE_FILES = new Set(['enest.db-wal', 'enest.db-shm'])

function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !resolve(parent, rel).startsWith('..'))
}

async function pathKind(path: string): Promise<'missing' | 'file' | 'dir'> {
  try { return (await fs.lstat(path)).isDirectory() ? 'dir' : 'file' }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw error }
}

/** 关闭一个运行中的插件；从未打开的不碰，避免给无关插件写入关闭态 */
async function pausePlugin(pluginId: string): Promise<void> {
  const release = pluginHost.blockPlugin(pluginId, 'data root migration')
  try {
    stopPluginBackground(pluginId, 'data root migration')
    if (pluginHost.isOpen(pluginId) || pluginHost.isClosing(pluginId)) {
      await pluginHost.closePlugin(pluginId, 'tab-close', true)
    }
    await stopPluginBackend(pluginId)
  } finally { release() }
}

/** 暂停首页、全部插件、定时任务，落盘并关库；返回迁移前打开的 tab 供恢复 */
async function pauseEverything(): Promise<string[]> {
  const openTabs = pluginHost.listTabs().map(tab => tab.id)
  homeSurfaceManager.destroy()
  for (const item of pluginRegistry.getInstalledDescriptors()) await pausePlugin(item.id)
  await shutdownDeadlineTasks()
  flushAll()
  settingsStore.flushNow()
  kvStore.close()
  return openTabs
}

async function resumeServices(): Promise<void> {
  await kvStore.initDatabase()
  initPluginStorage()
  reloadDeadlineTasks()
  refreshPluginBackgrounds()
}

/** 复制整个旧根到目标目录，随后量出文件数与字节数 */
async function copyRoot(from: string, to: string): Promise<{ files: number; bytes: number }> {
  const dataDir = join(from, 'data')
  await fs.cp(from, to, {
    recursive: true,
    // 符号链接原样复制链接本身，不跟随到目标，避免把数据根外的文件拷进来
    dereference: false,
    filter: source => dirname(source) !== dataDir || !DATABASE_SIDE_FILES.has(basename(source)),
  })
  let files = 0, bytes = 0
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) { files++; bytes += (await fs.lstat(full)).size }
    }
  }
  await walk(to)
  return { files, bytes }
}

/**
 * 迁移数据根。成功后旧目录保留，运行期需重启才完全切换。
 * 失败时恢复到迁移前的运行状态并返回错误。
 */
export async function migrateDataRoot(targetRoot: string): Promise<DataRootMigrationResult> {
  const input = typeof targetRoot === 'string' ? targetRoot.trim() : ''
  if (!input) return { ok: false, error: '目标目录不能为空' }
  let target: string
  try { target = resolveLocalUserPath(input, { baseDir: process.cwd() }) }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }

  const from = getAppPaths().root
  if (target === from) return { ok: false, error: '目标目录与当前数据目录相同' }
  if (contains(from, target) || contains(target, from)) {
    return { ok: false, error: '目标目录不能与当前数据目录互相包含，请选择一个独立的位置' }
  }

  // —— 校验目标：在任何状态变更之前完成 ——
  const kind = await pathKind(target)
  if (kind === 'file') return { ok: false, error: '目标位置已存在同名文件' }
  if (kind === 'dir' && (await fs.readdir(target)).length > 0) return { ok: false, error: '目标目录非空，请选择空目录' }
  await fs.mkdir(target, { recursive: true })
  const probe = join(target, `.enest-write-probe-${process.pid}`)
  try { await fs.writeFile(probe, '') } catch (error) {
    return { ok: false, error: `目标目录不可写：${error instanceof Error ? error.message : String(error)}` }
  } finally { await fs.rm(probe, { force: true }).catch(() => {}) }

  const generation = getAppPathsGeneration()
  let release = retainAppPaths()
  let staged: string | null = null
  let paused = false
  let renamed = false
  let openTabs: string[] = []
  try {
    // —— 暂停 ——
    paused = true
    openTabs = await pauseEverything()

    // —— 复制到同级临时目录 ——
    staged = join(dirname(target), `.${basename(target)}.migrating-${process.pid}`)
    await fs.rm(staged, { recursive: true, force: true })
    const copied = await copyRoot(from, staged)
    if (generation !== getAppPathsGeneration()) throw new Error('迁移期间数据目录被更改')

    // —— 切换：先在暂存库上打开连接，让设置行直接写进新库 ——
    // setAll 只做防抖写入，关库前必须 flushNow，否则落盘失败会回退成整份写锚点文件
    const stagedDatabase = join(staged, 'data', 'enest.db')
    await kvStore.initDatabase(stagedDatabase)
    release()
    release = () => {}
    await settingsStore.setAll({ general: { dataRoot: target } })
    settingsStore.flushNow()
    kvStore.close()
    await fs.rename(staged, target)
    staged = null
    renamed = true
    logInfo('main', `data root migrated to ${target} (${copied.files} files)`)

    // —— 恢复 ——
    await resumeServices()
    await pluginHost.restoreTabs(openTabs)
    resetLogsDir()
    // 首页在暂停时已销毁；离开设置页时会自动重建，这里提前预热避免首屏空等
    void prewarmHomeSurface().catch(error => logError('main', `home prewarm after migration failed: ${String(error)}`))
    return { ok: true, fromRoot: from, toRoot: target, files: copied.files, bytes: copied.bytes }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logError('main', `data root migration failed: ${message}`)
    if (staged) await fs.rm(staged, { recursive: true, force: true }).catch(() => {})
    kvStore.close()
    if (renamed) {
      // 已到位但恢复失败：把指针拨回旧根，新目录留着供排查
      try {
        await settingsStore.setAll({ general: { dataRoot: from } })
        settingsStore.flushNow()
      } catch { /* 旧根仍完整，下次启动按锚点恢复 */ }
    }
    if (paused) {
      try { await resumeServices() } catch (resumeError) { logError('main', `data root rollback resume failed: ${String(resumeError)}`) }
      await pluginHost.restoreTabs(openTabs).catch(() => {})
    }
    return { ok: false, error: message }
  } finally {
    release()
  }
}
