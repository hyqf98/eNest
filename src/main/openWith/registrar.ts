/**
 * openWith 平台注册器契约
 *
 * 系统关联的写入目标永远是 eNest 本体（bundle id / exe / .desktop），插件只是
 * 「类型 → 插件」路由的声明者。各平台能力差异如实建模为 caps：
 *  - Linux：文件类型与 scheme 都可程序化设默认（xdg-mime / xdg-settings）；
 *  - Windows：scheme 可设默认；文件类型只能写 HKCU 候选，切换默认受 UserChoice 保护；
 *  - macOS：scheme 由当前安装包 CFBundleURLTypes 决定；文件类型候选来自 Info.plist，
 *    本应用引导用户在 Finder 完成默认选择；状态经 LaunchServices 查询，失败保持未知。
 * 开发态（app.isPackaged=false）没有稳定的 bundle/desktop/registry 目标，注册一律跳过。
 */
import { execFile } from 'node:child_process'
import { app } from 'electron'
import type { OpenWithStatus } from '@shared/types/openWith'
import { darwinRegistrar } from './darwin'
import { linuxRegistrar } from './linux'
import { win32Registrar } from './win32'

export type OpenWithKind = 'ext' | 'scheme'

export interface OpenWithCaps {
  /** 可程序化一键设为系统默认 */
  canSetDefault: boolean
  /** 只能注册候选并引导用户到系统设置完成 */
  needsSystemSettings: boolean
}

export interface OpenWithRegistrar {
  caps(kind: OpenWithKind): OpenWithCaps
  /** 注册为候选（幂等；不可程序化的平台为 no-op，候选来自打包期声明） */
  registerCandidate(kind: OpenWithKind, value: string): Promise<void>
  /** 尝试设为默认；不能真正切换的平台返回候选状态与引导文案 */
  setDefault(kind: OpenWithKind, value: string): Promise<{ ok: boolean; status?: OpenWithStatus; error?: string; hint?: string }>
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

let cached: OpenWithRegistrar | null = null

export function getOpenWithRegistrar(): OpenWithRegistrar {
  if (cached) return cached
  cached = process.platform === 'darwin' ? darwinRegistrar
    : process.platform === 'win32' ? win32Registrar
      : linuxRegistrar
  return cached
}
