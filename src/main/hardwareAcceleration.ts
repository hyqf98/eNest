/**
 * hardwareAcceleration — GPU 硬件加速开关
 * 职责：在 app.ready 之前根据 ~/eNest/settings.json 同步读取偏好并决定是否
 * app.disableHardwareAcceleration()；提供 IPC 读写（写后需重启生效）。
 * 被 index.ts（ready 前）与 shellHandlers 调用。
 * 关键依赖：electron app、pathsService（settings 路径）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { app } from 'electron'
import { getDefaultSettingsPath } from '@main/paths/pathsService'

/** 默认开启硬件加速 */
const DEFAULT_ENABLED = true

/**
 * 同步读取硬件加速偏好。
 * settings 加载依赖 app ready，而 GPU 开关必须在 ready 前决策，故这里直接读文件。
 */
export function readHardwareAccelPreferenceSync(): boolean {
  try {
    const file = getDefaultSettingsPath()
    if (!existsSync(file)) return DEFAULT_ENABLED
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as {
      general?: { hardwareAcceleration?: unknown }
    }
    const value = raw?.general?.hardwareAcceleration
    if (typeof value === 'boolean') return value
    return DEFAULT_ENABLED
  } catch {
    return DEFAULT_ENABLED
  }
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
