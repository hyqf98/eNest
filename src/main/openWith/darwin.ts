/** macOS uses the running bundle's declarations and authoritative LaunchServices queries. */
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { app, shell } from 'electron'
import { detectDarwinAssociation, getDarwinBundleAssociations, refreshDarwinAssociation } from './darwinAssociations'
import { registrationAvailable, type OpenWithKind, type OpenWithRegistrar } from './registrar'

/** Fixed helper path: packaged resources or the build output, never a PATH lookup. */
function helperPath(): string {
  const dir = app.isPackaged ? join(process.resourcesPath, 'native') : join(app.getAppPath(), 'native/bin')
  return join(dir, 'open-with-helper')
}

interface HelperResult { ok: boolean; message?: string }

/**
 * macOS 12+ exposes NSWorkspace default-handler setters, but they take a completion
 * block that JXA cannot construct, so the switch runs through a small fixed helper.
 */
function setDefaultViaHelper(kind: OpenWithKind, value: string): Promise<HelperResult> {
  return new Promise((resolve) => {
    execFile(helperPath(), [kind, value, app.getPath('exe').replace(/\/Contents\/MacOS\/[^/]+$/, '')], {
      timeout: 12_000, windowsHide: true, maxBuffer: 64 * 1024
    }, (error, stdout) => {
      if (error && !stdout) { resolve({ ok: false, message: error.message }); return }
      try {
        const parsed = JSON.parse(String(stdout).trim()) as { status?: unknown; message?: unknown }
        if (parsed.status === 'ok') { resolve({ ok: true }); return }
        resolve({ ok: false, message: typeof parsed.message === 'string' ? parsed.message : '系统未接受默认打开方式变更' })
      } catch { resolve({ ok: false, message: '无法解析系统返回结果' }) }
    })
  })
}

export const darwinRegistrar: OpenWithRegistrar = {
  caps() {
    // 文件类型与 URL scheme 在 macOS 12+ 都可程序化切换；更早系统回退为引导。
    return registrationAvailable()
      ? { canSetDefault: true, needsSystemSettings: false }
      : { canSetDefault: false, needsSystemSettings: true }
  },

  /** Candidate registration belongs to the installed bundle, not a plugin manifest at runtime. */
  async registerCandidate(): Promise<void> {},

  async setDefault(kind, value) {
    if (!registrationAvailable()) {
      return { ok: false, error: '开发态未注册打开方式，仅在安装版可用' }
    }
    const bundle = await getDarwinBundleAssociations()
    if (!bundle) return { ok: false, error: '无法读取当前安装包的打开方式声明，系统状态未知' }
    // Only a type the installed bundle actually declares can become its default.
    const declared = kind === 'scheme' ? bundle.schemes.includes(value) : bundle.extensions.includes(value)
    if (!declared) {
      return {
        ok: false,
        status: await detectDarwinAssociation(kind, value),
        error: kind === 'scheme'
          ? '当前安装包未声明该 URL scheme，插件声明不会自动修改安装包'
          : '当前安装包尚未声明此文件类型；新增类型需要更新壳安装包',
      }
    }
    const result = await setDefaultViaHelper(kind, value)
    const status = await refreshDarwinAssociation(kind, value)
    if (result.ok && status !== 'unregistered') return { ok: true, status }
    if (result.ok) return { ok: true, status, hint: '系统已接受变更，但未能确认生效；请在系统设置中核实' }
    return {
      ok: false,
      status,
      error: result.message,
      hint: kind === 'ext' ? '也可在 Finder 中右键该文件 → 显示简介 → 打开方式 → 全部更改' : undefined,
    }
  },

  detect: detectDarwinAssociation,

  async openSystemSettings(): Promise<void> {
    await shell.openExternal('x-apple.systempreferences:com.apple.ExtensionsPreferences')
  }
}
