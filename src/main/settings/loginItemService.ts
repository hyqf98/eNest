/**
 * loginItemService — 开机自启（登录启动）三平台实现
 * 职责：读/写系统级自启注册，并把偏好同步落 settings.general.launchAtLogin。
 *  - macOS：app.setLoginItemSettings（SMAppService/LoginItems，需打包+签名+公证才可靠）。
 *  - Windows：同 API 走 HKCU Run 键；打包后 process.execPath 即最终 exe，直接注册。
 *  - Linux：Electron 无原生实现，自管 XDG ~/.config/autostart/*.desktop（仅写 Exec，
 *    不带 --hidden——登录即唤起主窗，与 macOS/Windows 行为一致）。
 * 状态以「系统实际注册」为唯一事实：用户在系统设置里手动禁用后，读取回写偏好同步。
 * 被 shellHandlers 调用；关键依赖 electron app、settingsStore。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { LoginItemSetResult, LoginItemState } from '@shared/types/shell'
import { logInfo, logWarn } from '@main/logs/logService'

const LINUX_DESKTOP_FILE = 'eNest.desktop'

function linuxAutostartDir(): string {
  const configHome = process.env.XDG_CONFIG_HOME
    || (process.env.HOME ? join(process.env.HOME, '.config') : '')
  return configHome ? join(configHome, 'autostart') : ''
}

function linuxDesktopPath(): string {
  return join(linuxAutostartDir(), LINUX_DESKTOP_FILE)
}

/** Linux：桌面文件存在且含有效 Exec 行即视为已注册。 */
function readLinuxRegistered(): boolean {
  try {
    const file = linuxDesktopPath()
    if (!existsSync(file)) return false
    return /^\s*Exec\s*=/m.test(readFileSync(file, 'utf-8'))
  } catch {
    return false
  }
}

function writeLinuxDesktopFile(): void {
  const dir = linuxAutostartDir()
  mkdirSync(dir, { recursive: true })
  const execPath = process.execPath.replace(/(["\\$`])/g, '\\$1')
  const content = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${app.getName() || 'eNest'}`,
    `Exec=${execPath}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n')
  writeFileSync(linuxDesktopPath(), content, 'utf-8')
}

/**
 * 读取系统实际自启状态。非 Linux 平台未打包（dev）时 Electron API 不可靠，
 * 直接返回 supported=false 而非呈现一个开关了也不生效的假状态。
 */
export function getLoginItemState(): LoginItemState {
  if (process.platform === 'linux') {
    // 无 XDG 目录（HOME 缺失等）视为平台不支持，开关只读。
    if (!linuxAutostartDir()) return { supported: false, enabled: false }
    return { supported: true, enabled: readLinuxRegistered() }
  }
  // macOS/Windows：dev 未打包时注册会指向 node/electron 二进制，静默失败或行为错误。
  if (!app.isPackaged) return { supported: false, enabled: false }
  try {
    return { supported: true, enabled: app.getLoginItemSettings().openAtLogin === true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logWarn('login-item', `read state failed: ${message}`)
    return { supported: true, enabled: false, error: message }
  }
}

/**
 * 注册/注销自启并落偏好。注册后立即读回验证（macOS 未签名未公证会静默失败），
 * 以验证结果为准返回，避免「设置显示已开启、系统实际没注册」的假状态。
 */
export async function setLoginItemEnabled(enabled: boolean): Promise<LoginItemSetResult> {
  const state = getLoginItemState()
  if (!state.supported) {
    return { ok: false, enabled: state.enabled, error: 'login item not supported on this setup' }
  }
  try {
    if (process.platform === 'linux') {
      if (enabled) writeLinuxDesktopFile()
      else if (existsSync(linuxDesktopPath())) rmSync(linuxDesktopPath())
    } else {
      app.setLoginItemSettings({ openAtLogin: enabled })
    }
    // 读回验证：Electron 注册可能静默失败（签名/权限），存储与 UI 都以真实结果为准。
    const actual = getLoginItemState()
    if (actual.enabled !== enabled) {
      logWarn('login-item', `register mismatch: want=${enabled} actual=${actual.enabled}`)
      return { ok: false, enabled: actual.enabled, error: actual.error ?? 'system rejected the login item change' }
    }
    logInfo('login-item', `login item ${enabled ? 'registered' : 'unregistered'}`)
    return { ok: true, enabled: actual.enabled }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logWarn('login-item', `write failed: ${message}`)
    return { ok: false, enabled: getLoginItemState().enabled, error: message }
  }
}
