/**
 * hardwareAcceleration — GPU 硬件加速开关
 * 职责：在 app.ready 之前根据引导锚点定位 SQLite 设置，同步读取偏好并决定是否
 * app.disableHardwareAcceleration()；提供 IPC 读写（写后需重启生效）。
 * 被 index.ts（ready 前）与 shellHandlers 调用。
 * 关键依赖：electron app、pathsService（settings 路径）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { defaultDataRoot, getAppPaths, getDefaultSettingsPath } from '@main/paths/pathsService'

/** 默认开启硬件加速 */
const DEFAULT_ENABLED = true

/**
 * 同步读取硬件加速偏好。
 * SettingsStore 尚未初始化；短暂打开只读连接，不建库、不迁移、不改变路径全局状态。
 * 与 SettingsStore 一致：优先库内 app 行，库不可用时兼容旧版全量 settings.json。
 */
export function readHardwareAccelPreferenceSync(): boolean {
  let legacyValue: unknown
  let dataRoot = defaultDataRoot()
  try {
    const file = getDefaultSettingsPath()
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as {
        general?: { hardwareAcceleration?: unknown; dataRoot?: unknown }
      }
      legacyValue = raw?.general?.hardwareAcceleration
      const root = raw?.general?.dataRoot
      if (typeof root === 'string' && root.trim()) dataRoot = root.trim()
    }
  } catch {
    // 损坏的锚点不妨碍读取默认数据根内的有效设置。
  }
  let db: DatabaseSync | undefined
  try {
    const file = getAppPaths(dataRoot).database
    if (existsSync(file)) {
      db = new DatabaseSync(file, { readOnly: true })
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('app') as { value: string } | undefined
      const value = row ? JSON.parse(row.value)?.general?.hardwareAcceleration : undefined
      if (typeof value === 'boolean') return value
    }
  } catch {
    // 旧版/不可用库继续使用全量文件偏好；关闭连接后再启动正常迁移流程。
  } finally {
    db?.close()
  }
  return typeof legacyValue === 'boolean' ? legacyValue : DEFAULT_ENABLED
}

/**
 * 必须在 app.whenReady 之前调用：偏好为 false 时禁用硬件加速。
 * @returns 实际生效的 enabled 标志
 */
export function applyHardwareAccelerationBeforeReady(): boolean {
  const enabled = readHardwareAccelPreferenceSync()
  if (!enabled) {
    app.disableHardwareAcceleration()
  }
  return enabled
}
