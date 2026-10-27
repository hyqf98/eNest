/**
 * Windows 注册器
 *
 * 能力边界：
 *  - URL scheme：app.setAsDefaultProtocolClient 写 HKCU 并通知系统，可切换默认。
 *  - 文件类型：写 HKCU\Software\Classes 的 ProgID + OpenWithProgids 候选（无需管理员），
 *    但 Win10+ 的 UserChoice 受哈希保护，程序无法静默切换默认 → 只能引导到
 *    「设置 → 默认应用」（ms-settings:defaultapps）。
 *  - 状态检测：读 FileExts\<ext>\UserChoice 的 ProgId；读不到再看候选键。
 */
import { app, shell } from 'electron'
import type { OpenWithStatus } from '@shared/types/openWith'
import { registrationAvailable, run, type OpenWithRegistrar } from './registrar'

const APPLICATIONS_KEY = 'HKCU\\Software\\Classes\\Applications\\eNest.exe'

function progId(ext: string): string {
  return `eNest.${ext}`
}

async function regAddDefault(key: string, data: string): Promise<void> {
  await run('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', data, '/f'])
}

async function regAddValue(key: string, name: string, data: string, type = 'REG_SZ'): Promise<void> {
  await run('reg', ['add', key, '/v', name, '/t', type, '/d', data, '/f'])
}

async function registerFileCandidate(ext: string): Promise<void> {
  const exe = app.getPath('exe')
  const id = progId(ext)
  await regAddDefault(`HKCU\\Software\\Classes\\${id}`, `eNest ${ext.toUpperCase()} file`)
  await regAddDefault(`HKCU\\Software\\Classes\\${id}\\DefaultIcon`, `"${exe}",0`)
  await regAddDefault(`HKCU\\Software\\Classes\\${id}\\shell\\open\\command`, `"${exe}" "%1"`)
  await regAddValue(`HKCU\\Software\\Classes\\.${ext}\\OpenWithProgids`, id, '', 'REG_NONE')
  // 让「打开方式」列表出现 eNest
  await regAddDefault(`${APPLICATIONS_KEY}\\shell\\open\\command`, `"${exe}" "%1"`)
  await regAddValue(`${APPLICATIONS_KEY}\\SupportedTypes`, `.${ext}`, '', 'REG_NONE')
}

export const win32Registrar: OpenWithRegistrar = {
  caps(kind) {
    if (kind === 'scheme') {
      return { canSetDefault: registrationAvailable(), needsSystemSettings: !registrationAvailable() }
    }
    return { canSetDefault: false, needsSystemSettings: true }
  },

  async registerCandidate(kind, value): Promise<void> {
    if (!registrationAvailable() || kind !== 'ext') return
    await registerFileCandidate(value)
  },

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
    await registerFileCandidate(value)
    return {
      ok: true,
      status: 'candidate',
      hint: '已注册为候选：Windows 不允许程序直接切换默认，请在「设置 → 默认应用」中确认 eNest'
    }
  },

  async detect(kind, value): Promise<OpenWithStatus | undefined> {
    if (kind === 'scheme') {
      if (app.isDefaultProtocolClient(value)) return 'default'
      return registrationAvailable() ? 'candidate' : undefined
    }
    const userChoice = await run('reg', [
      'query', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.${value}\\UserChoice`, '/v', 'ProgId'
    ])
    if (userChoice.code === 0 && /eNest/i.test(userChoice.stdout)) return 'default'
    const candidate = await run('reg', [
      'query', `HKCU\\Software\\Classes\\.${value}\\OpenWithProgids`, '/v', progId(value)
    ])
    return candidate.code === 0 ? 'candidate' : 'unregistered'
  },

  async openSystemSettings(): Promise<void> {
    await shell.openExternal('ms-settings:defaultapps')
  }
}
