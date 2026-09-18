/**
 * pathsService — 应用数据根路径解析
 * 职责：统一解析 ~/.eNest 数据目录结构（plugins / data / themes / settings.json / data/enest.db），
 * 支持 settings.general.dataRoot 覆盖；提供 ensureAppDirs 做 mkdir -p。
 * 被 SettingsStore / PluginRegistry / sqliteService / themePacks / migrate / 各 IPC handler 引用。
 * 关键依赖：node:path、node:os、@shared/constants、@shared/types/plugin。
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DATA_DIR_NAME,
  DATA_SUBDIR,
  DATABASE_FILE,
  PLUGINS_DIR,
  SETTINGS_FILE,
  THEMES_DIR
} from '@shared/constants'
import type { AppPaths } from '@shared/types/plugin'

/** 运行期数据根覆盖（来自 settings.general.dataRoot）；null 表示用默认 ~/.eNest */
let effectiveRoot: string | null = null

/** 默认数据根：~/.eNest（跨平台隐藏目录） */
export function defaultDataRoot(): string {
  return join(homedir(), DATA_DIR_NAME)
}

/** 设置 dataRoot 覆盖；传 null/空串恢复默认 */
export function setAppPathsRoot(root: string | null | undefined): void {
  effectiveRoot = root && root.trim() ? root.trim() : null
}

/** 当前生效的数据根（不含 override 参数时） */
export function getAppPathsRoot(): string {
  return effectiveRoot ?? defaultDataRoot()
}

/**
 * 解析完整 AppPaths。
 * @param overrideRoot 优先级最高；否则用 setAppPathsRoot 设定的覆盖；否则默认 ~/eNest
 */
export function getAppPaths(overrideRoot?: string): AppPaths {
  const root = overrideRoot && overrideRoot.trim() ? overrideRoot.trim() : getAppPathsRoot()
  return {
    root,
    plugins: join(root, PLUGINS_DIR),
    data: join(root, DATA_SUBDIR),
    themes: join(root, THEMES_DIR),
    settings: join(root, SETTINGS_FILE),
    database: join(root, DATA_SUBDIR, DATABASE_FILE)
  }
}

/**
 * settings.json 固定路径：始终位于默认数据根 ~/.eNest/settings.json。
 * dataRoot 覆盖只影响 plugins/data/themes/database，避免设置自指迁移。
 */
export function getDefaultSettingsPath(): string {
  return join(defaultDataRoot(), SETTINGS_FILE)
}

/** 插件 storage.local 落盘目录：{root}/data/plugin-storage */
export function pluginStorageDir(): string {
  return join(getAppPaths().data, 'plugin-storage')
}

/** 单插件 storage 文件：{root}/data/plugin-storage/{pluginId}.json */
export function pluginStorageFile(pluginId: string): string {
  return join(pluginStorageDir(), `${pluginId}.json`)
}

/** mkdir -p 创建数据根及各级子目录 */
export function ensureAppDirs(paths: AppPaths = getAppPaths()): AppPaths {
  mkdirSync(paths.root, { recursive: true })
  mkdirSync(paths.plugins, { recursive: true })
  mkdirSync(paths.data, { recursive: true })
  mkdirSync(paths.themes, { recursive: true })
  return paths
}
