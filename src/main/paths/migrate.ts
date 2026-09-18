/**
 * migrate — 旧版 userData 数据迁入 ~/.eNest
 * 只做一次性补缺；目标已有则跳过。数据根固定 ~/.eNest，无其它回落。
 */
import { existsSync } from 'node:fs'
import { copyFile, cp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { ensureAppDirs, getAppPaths, pluginStorageDir } from '@main/paths/pathsService'

const FLAG_FILE = '.migrated'

async function copyDirIfMissing(src: string, dest: string): Promise<void> {
  if (!existsSync(src) || existsSync(dest)) return
  await mkdir(dest, { recursive: true })
  await cp(src, dest, { recursive: true })
}

/** 将 userData 下旧数据复制到 ~/.eNest；幂等 */
export async function migrateToDataRoot(): Promise<void> {
  const paths = ensureAppDirs(getAppPaths())
  const flag = join(paths.root, FLAG_FILE)
  if (existsSync(flag)) return

  const userData = app.getPath('userData')
  const oldSettings = join(userData, 'settings.json')
  const oldPlugins = join(userData, 'plugins')
  const oldPluginData = join(userData, 'plugin-data')

  if (!existsSync(paths.settings) && existsSync(oldSettings)) {
    try {
      await mkdir(paths.root, { recursive: true })
      await copyFile(oldSettings, paths.settings)
    } catch {
      /* ignore */
    }
  }

  await copyDirIfMissing(oldPlugins, paths.plugins)
  if (existsSync(oldPlugins)) {
    try {
      const ids = await readdir(oldPlugins)
      for (const id of ids) {
        await copyDirIfMissing(join(oldPlugins, id), join(paths.plugins, id))
      }
    } catch {
      /* ignore */
    }
  }

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
      /* ignore */
    }
  }

  await writeFile(
    flag,
    JSON.stringify({ migratedAt: new Date().toISOString(), from: userData }, null, 2),
    'utf-8'
  )
}
