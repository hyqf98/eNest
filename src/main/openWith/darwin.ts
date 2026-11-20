import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { detectDarwinAssociation, getDarwinBundleAssociations } from './darwinAssociations'
import { registrationAvailable, run, type OpenWithKind, type OpenWithRegistrar } from './registrar'

const finderGuide = '在 Finder 中选中此类型的文件 → 显示简介 → 打开方式 → 选择 eNest → 全部更改。'

async function fileHelper(): Promise<string | undefined> {
  if (!process.resourcesPath || !(Number.parseInt(process.getSystemVersion?.() ?? '', 10) >= 12)) return undefined
  const path = join(process.resourcesPath, 'native', 'open-with-helper')
  try {
    await access(path, constants.X_OK)
    return (await stat(path)).isFile() ? path : undefined
  } catch { return undefined }
}

async function declared(kind: OpenWithKind, value: string): Promise<boolean> {
  const bundle = await getDarwinBundleAssociations()
  return (kind === 'ext' ? bundle?.extensions : kind === 'scheme' ? bundle?.schemes : undefined)?.includes(value) ?? false
}

async function requestFileDefault(value: string): Promise<string | undefined> {
  const helper = await fileHelper()
  if (!helper) return '当前安装包不能直接切换文件的默认打开方式'
  const bundlePath = dirname(dirname(dirname(app.getPath('exe'))))
  const result = await run(helper, ['ext', value, bundlePath], 12_000)
  try {
    const answer = JSON.parse(result.stdout)
    if (result.code === 0 && answer?.status === 'ok') return undefined
    if (typeof answer?.message === 'string' && answer.message) return answer.message
  } catch {}
  return '系统未接受文件默认打开方式变更'
}

export const darwinRegistrar: OpenWithRegistrar = {
  async caps(kind, value) {
    if (!await declared(kind, value)) return { canSetDefault: false, needsSystemSettings: false }
    const canSetDefault = kind === 'scheme' || Boolean(await fileHelper())
    return { canSetDefault, needsSystemSettings: !canSetDefault }
  },

  async setDefault(kind, value) {
    if (!registrationAvailable()) return { ok: false, error: '开发态不能设置系统默认打开方式' }
    if (!await declared(kind, value)) return { ok: false, error: '无法确认当前安装包声明了此类型，不能设置系统默认' }
    let error: string | undefined
    try {
      if (kind === 'ext') error = await requestFileDefault(value)
      else if (!app.setAsDefaultProtocolClient(value)) error = '系统未接受链接默认打开方式变更'
    } catch { error = '无法请求系统更改默认打开方式' }
    const status = await detectDarwinAssociation(kind, value)
    if (status === 'default') return { ok: true, status }
    return { ok: false, status, error: error ?? '系统未确认 eNest 为默认打开方式', hint: kind === 'ext' ? finderGuide : undefined }
  },

  detect: detectDarwinAssociation,

  async openSystemSettings() {
    const { dialog } = await import('electron')
    await dialog.showMessageBox({ type: 'info', message: '在 Finder 中设置文件的打开方式', detail: finderGuide })
  }
}
