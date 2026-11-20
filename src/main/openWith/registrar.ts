import { execFile } from 'node:child_process'
import { app } from 'electron'
import type { OpenWithActionResult, OpenWithRow, OpenWithStatus } from '@shared/types/openWith'
import { darwinRegistrar } from './darwin'
import { linuxRegistrar } from './linux'
import { win32Registrar } from './win32'

export type OpenWithKind = OpenWithRow['kind']
export type OpenWithCaps = OpenWithRow['caps']

export interface OpenWithRegistrar {
  caps(kind: OpenWithKind, value: string): OpenWithCaps | Promise<OpenWithCaps>
  /** 尝试设为默认；不能真正切换的平台返回候选状态与引导文案 */
  setDefault(kind: OpenWithKind, value: string): Promise<OpenWithActionResult>
  /** 检测系统当前默认；检测不可用返回 undefined（dev / 系统接口缺失） */
  detect(kind: OpenWithKind, value: string): Promise<OpenWithStatus | undefined>
  /** 打开系统默认应用设置或引导页 */
  openSystemSettings(): Promise<void>
}

/** 仅安装版可写系统关联 */
export function registrationAvailable(): boolean {
  return app.isPackaged
}

/** 统一 execFile：返回退出码与输出，不抛错（注册/检测失败按状态处理） */
export function run(cmd: string, args: string[], timeout = 4000, input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const rawCode = (error as NodeJS.ErrnoException | null)?.code
      const code = typeof rawCode === 'number' ? rawCode : error ? 1 : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
    if (input !== undefined) {
      // A converter may exit before consuming stdin; its exit status remains authoritative.
      child.stdin?.on('error', () => {})
      child.stdin?.end(input)
    }
  })
}

const unsupported: OpenWithRegistrar = {
  caps: () => ({ canSetDefault: false, needsSystemSettings: false }),
  detect: async () => undefined,
  setDefault: async () => ({ ok: false, error: '当前平台不支持系统打开方式注册' }),
  openSystemSettings: async () => {}
}

export function getOpenWithRegistrar(): OpenWithRegistrar {
  return process.platform === 'darwin' ? darwinRegistrar
    : process.platform === 'win32' ? win32Registrar
      : process.platform === 'linux' ? linuxRegistrar : unsupported
}
