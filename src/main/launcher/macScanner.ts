/**
 * macScanner — 扫描 macOS .app 包
 * 源：/Applications、/System/Applications、~/Applications（一层 + 有限子目录）。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readdir, readFile, stat } from 'node:fs/promises'
import type { ApplicationScanResult, LocalApp } from '@shared/types/quick'

function roots(): string[] {
  return ['/Applications', '/System/Applications', join(homedir(), 'Applications')]
}

const SKIP_DIR = new Set(['Utilities', 'Utilities.localized'])

/** 从 Info.plist 文本中粗提 CFBundleDisplayName / CFBundleName */
function extractPlistName(xml: string): string | null {
  const display = /<key>CFBundleDisplayName<\/key>\s*<string>([^<]+)<\/string>/.exec(xml)
  if (display?.[1]) return display[1].trim()
  const name = /<key>CFBundleName<\/key>\s*<string>([^<]+)<\/string>/.exec(xml)
  if (name?.[1]) return name[1].trim()
  return null
}

async function readAppName(appPath: string): Promise<string | null> {
  try {
    const plist = await readFile(join(appPath, 'Contents', 'Info.plist'), 'utf-8')
    return extractPlistName(plist)
  } catch {
    return null
  }
}

async function scanDir(dir: string, depth: number, out: LocalApp[]): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    const full = join(dir, entry)
    let st
    try {
      st = await stat(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (entry.endsWith('.app')) {
        const name = (await readAppName(full)) || entry.replace(/\.app$/i, '')
        out.push({ name, path: full })
      } else if (depth < 2 && !SKIP_DIR.has(entry) && !entry.endsWith('.app')) {
        await scanDir(full, depth + 1, out)
      }
    }
  }
}

export async function scanApplications(): Promise<ApplicationScanResult> {
  const apps: LocalApp[] = []
  const errors: string[] = []
  for (const root of roots()) {
    try {
      await scanDir(root, 0, apps)
    } catch (err) {
      errors.push(`${root}: ${(err as Error).message}`)
    }
  }
  // 去重（同 path）
  const seen = new Set<string>()
  const unique = apps.filter((a) => {
    if (seen.has(a.path)) return false
    seen.add(a.path)
    return true
  })
  unique.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  return { apps: unique, complete: errors.length === 0, errors }
}
