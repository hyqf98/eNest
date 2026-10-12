/**
 * macScanner — 扫描 macOS .app 包
 * 源：/Applications、/System/Applications、~/Applications（一层 + 有限子目录）。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readdir, readFile, stat } from 'node:fs/promises'
import type { ApplicationScanResult, LocalApp } from '@shared/types/quick'

function roots(): string[] {
  return ['/Applications', '/System/Applications', join(homedir(), 'Applications')]
}

const execFileAsync = promisify(execFile)

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
    const path = join(appPath, 'Contents', 'Info.plist')
    const plist = await readFile(path, 'utf-8')
    if (!plist.startsWith('bplist')) return extractPlistName(plist)
    const { stdout } = await execFileAsync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', path], { timeout: 1500 })
    return extractPlistName(stdout)
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
      if (/\.app$/i.test(entry)) {
        const name = (await readAppName(full)) || entry.replace(/\.app$/i, '')
        out.push({ name, path: full, alias: entry.replace(/\.app$/i, '') })
      } else if (depth < 2) {
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
  // Finder 不在 /Applications 内，仍是用户可启动的系统应用。
  const finder = '/System/Library/CoreServices/Finder.app'
  if (await stat(finder).then((entry) => entry.isDirectory()).catch(() => false)) {
    apps.push({ name: '访达', alias: 'Finder', path: finder })
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
