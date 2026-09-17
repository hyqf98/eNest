/**
 * appLauncher — 按平台启动本地应用
 * mac: shell.openPath(.app) / open
 * win: shell.openPath 或 spawn 目标
 * linux: 解析 Exec 字段后 spawn（剥离 %U/%F 等）
 * 安全：只允许启动扫描缓存中的应用路径，拒绝任意路径。
 */
import { spawn } from 'node:child_process'
import { app, shell } from 'electron'
import { getCachedApps } from './appScanner'
import { logError, logInfo } from '../logs/logService'

/** 将 Linux Exec 字符串拆成 [cmd, ...args] */
export function parseExecString(exec: string): [string, string[]] {
  const cleaned = exec.replace(/%[fFuUdDnNickvm]/g, '').trim()
  const parts: string[] = []
  let current = ''
  let quote: string | null = null
  for (const ch of cleaned) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (current) {
        parts.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (current) parts.push(current)
  return [parts[0] ?? '', parts.slice(1)]
}

/** 校验 path 是否来自扫描缓存（防渲染层注入任意可执行路径） */
export function isKnownAppPath(path: string): boolean {
  const cached = getCachedApps()
  if (!cached) return false
  return cached.apps.some((a) => a.path === path)
}

/** path → dataURL 图标缓存；空串表示无图标，避免重复 getFileIcon */
const iconCache = new Map<string, string>()

/**
 * 取本地应用图标（data URL）。失败/无图标返回 undefined。
 * 结果缓存，命令面搜索时只为 top 结果解析，不阻塞扫描。
 */
export async function getAppIconDataUrl(path: string): Promise<string | undefined> {
  const hit = iconCache.get(path)
  if (hit !== undefined) return hit || undefined
  try {
    const img = await app.getFileIcon(path, { size: 'normal' })
    if (!img || img.isEmpty()) {
      iconCache.set(path, '')
      return undefined
    }
    const url = img.toDataURL()
    iconCache.set(path, url)
    return url
  } catch {
    iconCache.set(path, '')
    return undefined
  }
}

export async function launchLocalApp(path: string): Promise<void> {
  if (!isKnownAppPath(path)) {
    logError('quick', `blocked launch of unknown path: ${path}`)
    throw new Error('应用不在扫描列表中，已拒绝启动')
  }

  const platform = process.platform

  if (platform === 'linux') {
    const [cmd, args] = parseExecString(path)
    if (!cmd) throw new Error('empty Exec')
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
      child.on('error', reject)
      child.unref()
      resolve()
    })
  }

  // mac .app 与 win 路径优先 openPath
  const err = await shell.openPath(path)
  if (err) {
    if (platform === 'darwin') {
      return new Promise((resolve, reject) => {
        spawn('open', ['-a', path], { detached: true, stdio: 'ignore' }).on('error', reject)
        resolve()
      })
    }
    logError('quick', `launch failed: ${path} — ${err}`)
    throw new Error(err)
  }
  logInfo('quick', `launched: ${path}`)
}
