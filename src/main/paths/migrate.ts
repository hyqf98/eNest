/**
 * migrate — 首次启动从 userData 迁移到 ~/eNest
 * 职责：旧版 settings.json 与 plugins（及 plugin-data）若仍在 Electron userData 下，
 * 复制到新的数据根；完成后写入 .migrated 标记，保证幂等。
 * 被 index.ts 在 settingsStore.load 之前调用。
 * 关键依赖：electron app（userData 路径）、pathsService。
 * 安全策略：只复制不删除源文件；目标已存在则跳过。
 */
import { existsSync } from 'node:fs'
import { copyFile, cp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { ensureAppDirs, getAppPaths, pluginStorageDir } from './pathsService'

const FLAG_FILE = '.migrated'

/** 递归复制目录（源不存在则跳过）；目标已存在时不覆盖 */
async function copyDirIfMissing(src: string, dest: string): Promise<void> {
  if (!existsSync(src) || existsSync(dest)) return
  await mkdir(dest, { recursive: true })
  await cp(src, dest, { recursive: true })
}

/**
 * 将 userData 下旧数据复制到数据根（~/eNest）。
 * 幂等：已有 .migrated 标记则直接返回；目标已有同名文件时不覆盖。
 */
export async function migrateToDataRoot(): Promise<void> {
  const paths = ensureAppDirs(getAppPaths())
  const flag = join(paths.root, FLAG_FILE)
  if (existsSync(flag)) return

  const userData = app.getPath('userData')
  const oldSettings = join(userData, 'settings.json')
  const oldPlugins = join(userData, 'plugins')
  const oldPluginData = join(userData, 'plugin-data')

  // 1) 设置文件：新位置缺失且旧位置存在时复制
  if (!existsSync(paths.settings) && existsSync(oldSettings)) {
    try {
      await mkdir(paths.root, { recursive: true })
      await copyFile(oldSettings, paths.settings)
    } catch {
      // ignore copy failure; next start will retry unless flag written
    }
  }

  // 2) 已安装插件目录
  await copyDirIfMissing(oldPlugins, paths.plugins)
  if (existsSync(oldPlugins)) {
    // 逐个插件复制，避免目标部分存在时整目录跳过
    try {
      const ids = await readdir(oldPlugins)
      for (const id of ids) {
        await copyDirIfMissing(join(oldPlugins, id), join(paths.plugins, id))
      }
    } catch {
      // ignore
    }
  }

  // 3) 旧 plugin-data/{id}/storage.json → data/plugin-storage/{id}.json
  if (existsSync(oldPluginData)) {
    try {
      const ids = await readdir(oldPluginData)
      const destDir = pluginStorageDir()
      await mkdir(destDir, { recursive: true })
      for (const id of ids) {
        const src = join(oldPluginData, id, 'storage.json')
        const dest = join(destDir, `${id}.json`)
        if (existsSync(src) && !existsSync(dest)) {
          await copyFile(src, dest)
        }
      }
    } catch {
      // ignore
    }
  }

  await writeFile(
    flag,
    JSON.stringify({ migratedAt: new Date().toISOString(), from: userData }, null, 2),
    'utf-8'
  )
}
