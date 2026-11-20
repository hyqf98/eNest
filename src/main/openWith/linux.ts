/// <reference types="vite/client" />
import { constants } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { app } from 'electron'
import { validOpenWithValue, type OpenWithStatus } from '@shared/types/openWith'
import { registrationAvailable, run, type OpenWithKind, type OpenWithRegistrar } from './registrar'

function mimeForExtension(extension: string): string | undefined {
  const packaged = import.meta.glob<Array<{ ext: string; mimeType: string }>>('/build/open-with.json', { eager: true, import: 'fileAssociations' })
  return packaged['/build/open-with.json']?.find(entry => entry.ext === extension)?.mimeType
}

async function desktopName(): Promise<string | undefined> {
  try {
    const { desktopName: name } = JSON.parse(await readFile(join(app.getAppPath(), 'package.json'), 'utf8'))
    if (typeof name !== 'string') return undefined
    const id = name.trim().replace(/\.desktop$/, '')
    return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) ? `${id}.desktop` : undefined
  } catch { return undefined }
}

function desktopEntry(text: string): Map<string, string> {
  const fields = new Map<string, string>()
  let inEntry = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      if (inEntry) break
      inEntry = line === '[Desktop Entry]'
    } else if (inEntry && line && !line.startsWith('#')) {
      const separator = line.indexOf('=')
      if (separator > 0) fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
    }
  }
  return fields
}

async function installedEntry(id: string): Promise<Map<string, string> | undefined> {
  const home = process.env.XDG_DATA_HOME
  const roots = [home && isAbsolute(home) ? home : join(homedir(), '.local/share'),
    ...(process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(isAbsolute)]
  for (const root of new Set(roots)) {
    try { return desktopEntry(await readFile(join(root, 'applications', id), 'utf8')) }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return undefined
    }
  }
  return undefined
}

async function executable(name: string): Promise<string | undefined> {
  const paths = isAbsolute(name) ? [name] : name.includes('/') ? []
    : (process.env.PATH ?? '/usr/bin:/bin').split(':').filter(isAbsolute).map(dir => join(dir, name))
  for (const path of paths) {
    try {
      await access(path, constants.X_OK)
      if ((await stat(path)).isFile()) return path
    } catch { continue }
  }
  return undefined
}

function launcherName(exec: string | undefined): string | undefined {
  const token = exec?.match(/^(?:"((?:\\.|[^"\\])+)"|([^\s"\\]+))(?=\s|$)/)
  return token?.[1]?.replace(/\\(["`$\\])/g, '$1') ?? token?.[2]
}

async function targetFor(kind: OpenWithKind, value: string) {
  if (!registrationAvailable() || typeof value !== 'string' || !validOpenWithValue(kind, value)) return undefined
  const mime = kind === 'scheme' ? `x-scheme-handler/${value}`
    : mimeForExtension(value)
  if (!mime) return undefined
  const id = await desktopName()
  const entry = id && await installedEntry(id)
  if (!id || !entry || entry.get('Type') !== 'Application' || entry.get('Hidden')?.toLowerCase() === 'true'
    || !entry.get('MimeType')?.split(';').some(type => type.trim() === mime)) return undefined
  const launcher = launcherName(entry.get('Exec'))
  if (!launcher || !await executable(launcher)) return undefined
  const tryExec = entry.get('TryExec')
  if (tryExec && tryExec !== launcher && !await executable(tryExec)) return undefined
  const command = await executable('xdg-mime')
  return command ? { id, mime, command } : undefined
}

async function detect(kind: OpenWithKind, value: string): Promise<OpenWithStatus | undefined> {
  const target = await targetFor(kind, value)
  if (!target) return undefined
  const result = await run(target.command, ['query', 'default', target.mime])
  const selected = result.stdout.trim()
  if (result.code !== 0 || !/^[^/\r\n]+\.desktop$/.test(selected)) return undefined
  return selected === target.id ? 'default' : 'candidate'
}

export const linuxRegistrar: OpenWithRegistrar = {
  async caps(kind, value) {
    return { canSetDefault: Boolean(await targetFor(kind, value)), needsSystemSettings: false }
  },

  async setDefault(kind, value) {
    const target = await targetFor(kind, value)
    if (!target) return { ok: false, error: '没有可用的 eNest 桌面入口、类型声明或 xdg-mime；无法设置系统默认' }
    const result = await run(target.command, ['default', target.id, target.mime])
    if (result.code !== 0) return { ok: false, error: result.stderr.trim() || 'xdg-mime 未接受默认打开方式变更' }
    const status = await detect(kind, value)
    return status === 'default' ? { ok: true, status } : { ok: false, status, error: '未能确认系统已将 eNest 设为默认' }
  },

  detect,
  async openSystemSettings() {}
}
