/**
 * windowsScanner — 扫描开始菜单与桌面 .lnk 快捷方式
 * 骨架：无原生 MUI 解析；跳过卸载/帮助类名称。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import { shell } from 'electron'
import type { ApplicationScanResult, LocalApp } from '@shared/types/quick'

const SKIP_NAME = /^(uninstall|卸载)|卸载$|website|网站|帮助|help|readme|文档|manual|license|documentation/i

function startMenuRoots(): string[] {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  const programData = process.env.PROGRAMDATA || 'C:\\ProgramData'
  return [
    join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  ]
}

function desktopRoots(): string[] {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  const publicDesktop =
    process.env.PUBLIC || join('C:\\Users', 'Public')
  return [join(homedir(), 'Desktop'), join(publicDesktop, 'Desktop'), join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')]
}

async function scanLnkDir(dir: string, recursive: boolean, depth: number, out: LocalApp[]): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const lower = entry.toLowerCase()
    const full = join(dir, entry)
    let st
    try {
      st = await stat(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (recursive && depth < 3 && !/^(sdk|docs?|samples?|examples?|demos?)$/i.test(entry)) {
        await scanLnkDir(full, true, depth + 1, out)
      }
      continue
    }
    if (!lower.endsWith('.lnk') && !lower.endsWith('.exe')) continue
    const name = entry.replace(/\.(lnk|exe)$/i, '')
    if (SKIP_NAME.test(name)) continue
    let target = full
    if (lower.endsWith('.lnk')) {
      try {
        const info = shell.readShortcutLink(full)
        target = info.target || full
      } catch {
        target = full
      }
    }
    out.push({ name, path: target, alias: full })
  }
}

export async function scanApplications(): Promise<ApplicationScanResult> {
  const apps: LocalApp[] = []
  const errors: string[] = []
  const seen = new Set<string>()

  for (const root of startMenuRoots()) {
    try {
      await scanLnkDir(root, true, 0, apps)
    } catch (err) {
      errors.push(`${root}: ${(err as Error).message}`)
    }
  }
  for (const root of desktopRoots()) {
    try {
      await scanLnkDir(root, false, 0, apps)
    } catch (err) {
      errors.push(`${root}: ${(err as Error).message}`)
    }
  }

  const unique = apps.filter((a) => {
    const key = `${a.name}|${a.path}`.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  unique.sort((a, b) => a.name.localeCompare(b.name))
  return { apps: unique, complete: errors.length === 0, errors }
}
