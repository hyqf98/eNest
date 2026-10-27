/**
 * Linux 注册器
 *
 * 能力边界：xdg-mime / xdg-settings 按用户写入 mimeapps.list，可程序化切换默认；
 * 前提是安装包生成了 .desktop 且其 MimeType 覆盖目标类型（electron-builder 负责）。
 * 扩展名先映射到 MIME；未收录的扩展名不猜测（返回 undefined / 明确错误）。
 * 开发态没有 .desktop 入口，注册与设默认都不可用。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { app } from 'electron'
import type { OpenWithStatus } from '@shared/types/openWith'
import { registrationAvailable, run, type OpenWithRegistrar } from './registrar'

/** 官方声明用到的扩展名 → MIME；未收录的扩展名在 Linux 上无法定位 MIME */
const EXT_MIME: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  jsonc: 'application/json',
  sqlite: 'application/vnd.sqlite3',
  db: 'application/vnd.sqlite3',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  log: 'text/plain'
}

let desktopCache: string | null | undefined

/** 从已安装的 .desktop 中找指向本应用的入口（Exec 含可执行文件名） */
function findDesktopFile(): string | null {
  if (desktopCache !== undefined) return desktopCache
  desktopCache = null
  if (!registrationAvailable()) return null
  const exe = basename(app.getPath('exe'))
  const dirs = [
    join(homedir(), '.local/share/applications'),
    '/usr/share/applications',
    '/var/lib/flatpak/exports/share/applications'
  ]
  for (const dir of dirs) {
    let files: string[]
    try {
      files = readdirSync(dir)
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.desktop')) continue
      try {
        const text = readFileSync(join(dir, file), 'utf8')
        if (text.includes(exe) && /^Exec=/m.test(text)) {
          desktopCache = file
          return file
        }
      } catch {
        /* 跳过不可读条目 */
      }
    }
  }
  return null
}

function mimeFor(ext: string): string | null {
  return EXT_MIME[ext] ?? null
}

export const linuxRegistrar: OpenWithRegistrar = {
  caps() {
    return { canSetDefault: registrationAvailable(), needsSystemSettings: !registrationAvailable() }
  },

  /** 候选由安装包的 .desktop MimeType 声明；运行时无额外写入 */
  async registerCandidate(): Promise<void> {},

  async setDefault(kind, value) {
    const desktop = findDesktopFile()
    if (!desktop) {
      return { ok: false, error: '未找到 eNest 桌面入口：仅安装版可用（开发态请用打包产物验证）' }
    }
    if (kind === 'scheme') {
      const res = await run('xdg-settings', ['set', 'default-url-scheme-handler', value, desktop])
      if (res.code !== 0) return { ok: false, error: res.stderr.trim() || 'xdg-settings 执行失败' }
      return { ok: true, status: 'default' }
    }
    const mime = mimeFor(value)
    if (!mime) {
      return { ok: false, error: `扩展名 .${value} 未映射到 MIME，Linux 上无法注册默认` }
    }
    const res = await run('xdg-mime', ['default', desktop, mime])
    if (res.code !== 0) return { ok: false, error: res.stderr.trim() || 'xdg-mime 执行失败' }
    return { ok: true, status: 'default' }
  },

  async detect(kind, value): Promise<OpenWithStatus | undefined> {
    const desktop = findDesktopFile()
    if (!desktop) return undefined
    if (kind === 'scheme') {
      const res = await run('xdg-settings', ['get', 'default-url-scheme-handler', value])
      if (res.code !== 0) return undefined
      return res.stdout.trim() === desktop ? 'default' : 'candidate'
    }
    const mime = mimeFor(value)
    if (!mime) return undefined
    const res = await run('xdg-mime', ['query', 'default', mime])
    if (res.code !== 0) return undefined
    return res.stdout.trim() === desktop ? 'default' : 'candidate'
  },

  /** Linux 无统一默认应用设置界面；由 xdg 命令直接完成，无需引导 */
  async openSystemSettings(): Promise<void> {}
}
