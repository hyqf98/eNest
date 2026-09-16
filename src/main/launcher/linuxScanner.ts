/**
 * linuxScanner — 扫描 XDG .desktop 文件
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readdir, readFile, stat } from 'node:fs/promises'
import type { ApplicationScanResult, LocalApp } from '@shared/types/quick'

function desktopDirs(): string[] {
  return [
    join(homedir(), '.local', 'share', 'applications'),
    '/usr/share/applications',
    '/var/lib/flatpak/exports/share/applications',
    '/var/lib/snapd/desktop/applications'
  ]
}

function parseDesktop(content: string): { name: string; exec: string; noDisplay: boolean } | null {
  const lines = content.split(/\r?\n/)
  let inDesktopEntry = false
  let name = ''
  let nameZh = ''
  let exec = ''
  let noDisplay = false
  let hidden = false
  let terminal = false

  for (const line of lines) {
    if (line.startsWith('[')) {
      inDesktopEntry = line.trim() === '[Desktop Entry]'
      continue
    }
    if (!inDesktopEntry) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (key === 'Name') name = value
    else if (key === 'Name[zh_CN]' || key === 'Name[zh]') nameZh = value
    else if (key === 'Exec') exec = value
    else if (key === 'NoDisplay') noDisplay = value === 'true'
    else if (key === 'Hidden') hidden = value === 'true'
    else if (key === 'Terminal') terminal = value === 'true'
  }
  if (noDisplay || hidden || terminal || !exec || !name) return null
  return { name: nameZh || name, exec, noDisplay }
}

export async function scanApplications(): Promise<ApplicationScanResult> {
  const apps: LocalApp[] = []
  const errors: string[] = []
  const seen = new Set<string>()

  for (const dir of desktopDirs()) {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.desktop')) continue
      const full = join(dir, entry)
      try {
        if (!(await stat(full)).isFile()) continue
        const parsed = parseDesktop(await readFile(full, 'utf-8'))
        if (!parsed) continue
        const key = parsed.name.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        apps.push({ name: parsed.name, path: parsed.exec, alias: full })
      } catch (err) {
        errors.push(`${full}: ${(err as Error).message}`)
      }
    }
  }

  apps.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  return { apps, complete: errors.length === 0, errors }
}
