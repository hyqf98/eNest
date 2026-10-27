/**
 * OsPermissionChecks — OS 层权限检查（屏幕录制/截图）
 * 职责：在壳层 grant 放行后、真正执行前检查操作系统级授权，
 *       避免 grant 已允许但系统拒绝导致的黑屏/空帧。
 * 现状（按平台查证结论）：
 *  - darwin：systemPreferences.getMediaAccessStatus('screen') 可查询；
 *    denied 后 macOS 需用户手改系统设置（tccutil 重置也需用户再次授权）。
 *  - win32：无状态查询 API，桌面截图走 GDI/DXGI 无需授权 → 恒 ok。
 *  - linux：无状态查询 API；Wayland 经 WebRTCPipeWireCapturer（index.ts 已预置）。
 * 关键依赖：electron systemPreferences / shell。
 */
import { shell, systemPreferences } from 'electron'
import { interactionError, isNonInteractive } from '@main/plugin/pluginInteractionPolicy'

/** macOS 屏幕授权检查结果 */
export interface ScreenCaptureCheck {
  ok: boolean
  verified?: boolean
  /** system-pending：首次调用会弹系统授权（not-determined）；denied：已被系统拒绝 */
  hint?: 'system-pending' | 'denied'
}

/**
 * 检查屏幕捕获 OS 权限：
 * - 非 darwin 恒 ok（无查询 API，也无需授权）
 * - granted / not-determined → ok（not-determined 附 system-pending 提示，
 *   表示首次实际调用时 macOS 会弹系统授权窗）
 * - denied / restricted → { ok:false, hint:'denied' }
 */
export function checkScreenCapture(): ScreenCaptureCheck {
  if (process.platform !== 'darwin') return { ok: true }
  let status: string
  try {
    status = systemPreferences.getMediaAccessStatus('screen')
  } catch {
    // 查询异常不拦截调用（老系统无该 API 时回退放行）
    return { ok: true, verified: false }
  }
  if (status === 'granted') return { ok: true }
  if (status === 'not-determined') return { ok: true, hint: 'system-pending' }
  // denied / restricted / 未知拒绝态
  return { ok: false, hint: 'denied' }
}

/** Never let a background call discover an OS permission by triggering its prompt. */
export function assertScreenCaptureAllowed(pluginId: string): void {
  const check = checkScreenCapture()
  if (!check.ok) throw interactionError('permission-denied', 'os permission denied: screen')
  const systemPicker = process.platform === 'linux' && (process.env.XDG_SESSION_TYPE !== 'x11' || !!process.env.WAYLAND_DISPLAY)
  if (isNonInteractive(pluginId) && (check.hint === 'system-pending' || check.verified === false || systemPicker)) {
    throw interactionError('interaction-required', 'Screen capture requires interactive system authorization')
  }
}

/**
 * 打开 macOS「屏幕录制」隐私设置面板。
 * 内部专用（壳渲染层权限弹窗引导跳转），不走插件 shell.openExternal 白名单，
 * 仅跳转系统设置页，不暴露任何用户数据。
 */
export function openScreenCaptureSettings(): void {
  void shell
    .openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    )
    .catch((err: Error) => {
      // eslint-disable-next-line no-console
      console.warn('[enest] open screen capture settings failed:', err.message)
    })
}
