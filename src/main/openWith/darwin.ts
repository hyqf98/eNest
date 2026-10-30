/** macOS uses the running bundle's declarations and authoritative LaunchServices queries. */
import { app, shell } from 'electron'
import { detectDarwinAssociation, getDarwinBundleAssociations, refreshDarwinAssociation } from './darwinAssociations'
import { registrationAvailable, type OpenWithRegistrar } from './registrar'

export const darwinRegistrar: OpenWithRegistrar = {
  caps(kind) {
    if (kind === 'scheme') {
      return { canSetDefault: registrationAvailable(), needsSystemSettings: !registrationAvailable() }
    }
    return { canSetDefault: false, needsSystemSettings: true }
  },

  /** Candidate registration belongs to the installed bundle, not a plugin manifest at runtime. */
  async registerCandidate(): Promise<void> {},

  async setDefault(kind, value) {
    if (!registrationAvailable()) {
      return { ok: false, error: '开发态未注册打开方式，仅在安装版可用' }
    }
    const bundle = await getDarwinBundleAssociations()
    if (!bundle) return { ok: false, error: '无法读取当前安装包的打开方式声明，系统状态未知' }
    if (kind === 'scheme') {
      if (!bundle.schemes.includes(value)) {
        return { ok: false, status: await detectDarwinAssociation(kind, value), error: '当前安装包未声明该 URL scheme，插件声明不会自动修改安装包' }
      }
      if (!app.setAsDefaultProtocolClient(value)) {
        return { ok: false, error: '系统未接受 URL scheme 默认打开方式变更' }
      }
      const status = await refreshDarwinAssociation(kind, value)
      return status === 'default' ? { ok: true, status }
        : { ok: false, status, error: status === undefined ? '已提交系统，但无法确认默认打开方式；请在系统中核实' : '系统尚未将 eNest 设为该 URL scheme 的默认打开方式' }
    }
    const status = await refreshDarwinAssociation(kind, value)
    if (status === undefined) return { ok: false, error: '无法查询系统打开方式，不能确认候选或默认状态' }
    if (status === 'unregistered') {
      const declared = bundle.extensions.includes(value)
      return { ok: false, status, error: declared
        ? '系统未将当前安装包注册为此文件类型的打开候选，请检查安装包声明或重新安装'
        : '当前安装包尚未成为此文件类型的系统打开候选，请核对扩展名或 UTI 声明；新增类型需要更新壳安装包' }
    }
    if (status === 'default') return { ok: true, status }
    return {
      ok: true,
      status,
      hint: '已确认 eNest 是系统打开候选；请在 Finder 中右键该文件 → 显示简介 → 打开方式 → 全部更改'
    }
  },

  detect: detectDarwinAssociation,

  async openSystemSettings(): Promise<void> {
    await shell.openExternal('x-apple.systempreferences:com.apple.ExtensionsPreferences')
  }
}
