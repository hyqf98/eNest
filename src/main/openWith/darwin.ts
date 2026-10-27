/**
 * macOS 注册器
 *
 * 能力边界：
 *  - URL scheme：打包期经 Info.plist CFBundleURLTypes 声明；安装版可用
 *    app.setAsDefaultProtocolClient 切换默认（dev 态 Electron.app 的 Info.plist
 *    不可靠，跳过）。
 *  - 文件类型：CFBundleDocumentTypes 只在打包期生成；macOS 不允许第三方程序
 *    直接改某扩展名的默认应用，只能注册为候选，由用户在 Finder「显示简介 →
 *    打开方式 → 全部更改」确认。
 *  - 状态检测：读 LaunchServices 偏好里的 LSHandlers（只读；失败返回 undefined）。
 */
import { app, shell } from 'electron'
import type { OpenWithStatus } from '@shared/types/openWith'
import { registrationAvailable, run, type OpenWithRegistrar } from './registrar'

const MAC_BUNDLE_ID = 'com.github.eNest.shell'

interface LSHandler {
  LSHandlerContentTag?: string
  LSHandlerContentTagClass?: string
  LSHandlerRoleAll?: string
  LSHandlerRoleViewer?: string
  LSHandlerRoleEditor?: string
  LSHandlerURLScheme?: string
}

let handlersCache: { expiresAt: number; value: LSHandler[] | null } | undefined
let handlersRead: Promise<LSHandler[] | null> | undefined

/** 读 LaunchServices secure 偏好；同一列表只读取一次，子进程不阻塞窗口与快捷键。 */
async function loadLaunchServicesHandlers(): Promise<LSHandler[] | null> {
  try {
    const xml = await run('/usr/bin/defaults', ['export', 'com.apple.LaunchServices/com.apple.launchservices.secure', '-'], 3000)
    if (xml.code !== 0) return null
    const json = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], 3000, xml.stdout)
    if (json.code !== 0) return null
    const parsed = JSON.parse(json.stdout) as { LSHandlers?: unknown }
    return Array.isArray(parsed.LSHandlers) ? (parsed.LSHandlers as LSHandler[]) : null
  } catch {
    return null
  }
}

function readLaunchServicesHandlers(): Promise<LSHandler[] | null> {
  if (handlersCache && handlersCache.expiresAt > Date.now()) return Promise.resolve(handlersCache.value)
  if (!handlersRead) {
    handlersRead = loadLaunchServicesHandlers().then(value => {
      handlersCache = { value, expiresAt: Date.now() + 30_000 }
      return value
    }).finally(() => { handlersRead = undefined })
  }
  return handlersRead
}

async function extIsDefault(ext: string): Promise<boolean | undefined> {
  const handlers = await readLaunchServicesHandlers()
  if (!handlers) return undefined
  const hit = handlers.find(
    (h) => h?.LSHandlerContentTag === ext && h?.LSHandlerContentTagClass === 'public.filename-extension'
  )
  if (!hit) return false
  return [hit.LSHandlerRoleAll, hit.LSHandlerRoleViewer, hit.LSHandlerRoleEditor].includes(MAC_BUNDLE_ID)
}

export const darwinRegistrar: OpenWithRegistrar = {
  caps(kind) {
    if (kind === 'scheme') {
      return { canSetDefault: registrationAvailable(), needsSystemSettings: !registrationAvailable() }
    }
    return { canSetDefault: false, needsSystemSettings: true }
  },

  /** 候选来自打包期 Info.plist（fileAssociations / protocols），运行时无需写入 */
  async registerCandidate(): Promise<void> {},

  async setDefault(kind, value) {
    if (kind === 'scheme') {
      if (!registrationAvailable()) {
        return { ok: false, error: '开发态未注册 URL scheme，仅在安装版可用' }
      }
      const ok = app.setAsDefaultProtocolClient(value)
      return ok
        ? { ok: true, status: 'default' }
        : { ok: false, error: '系统未接受 scheme 注册（请确认安装包已声明该 scheme）' }
    }
    if (!registrationAvailable()) {
      return { ok: false, error: '开发态未注册文件类型，仅在安装版可用' }
    }
    return {
      ok: true,
      status: 'candidate',
      hint: 'macOS 不允许程序直接切换文件类型默认：请在 Finder 中右键该文件 → 显示简介 → 打开方式 → 全部更改'
    }
  },

  async detect(kind, value): Promise<OpenWithStatus | undefined> {
    if (!registrationAvailable()) return undefined
    if (kind === 'scheme') {
      if (app.isDefaultProtocolClient(value)) return 'default'
      return registrationAvailable() ? 'candidate' : undefined
    }
    const isDefault = await extIsDefault(value)
    if (isDefault === undefined) return undefined
    if (isDefault) return 'default'
    return registrationAvailable() ? 'candidate' : 'unregistered'
  },

  async openSystemSettings(): Promise<void> {
    await shell.openExternal('x-apple.systempreferences:com.apple.ExtensionsPreferences')
  }
}
