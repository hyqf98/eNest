/**
 * iconExtractor — Windows 本地应用图标提取（固定 JSON 行协议）。
 * Electron 的 getFileIcon 对部分 EXE（如 Electron 应用、Git Bash）返回通用图标；
 * 这里改用 Shell 的 ExtractIconEx / ExtractAssociatedIcon，按快捷方式
 * IconLocation 的索引取图，与资源管理器显示一致。
 * 常驻单个 PowerShell 辅助进程，首次调用有编译延迟，之后逐图标毫秒级。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { app } from 'electron'
import { logWarn } from '@main/logs/logService'

interface PendingIcon { resolve(icon: string | undefined): void; timer: NodeJS.Timeout }

let helper: ChildProcessWithoutNullStreams | null = null
let sequence = 0
let failedUntil = 0
const pending = new Map<number, PendingIcon>()

function helperFile(): string {
  const dir = app.isPackaged ? join(process.resourcesPath, 'native') : join(app.getAppPath(), '.cache/native/bin')
  return join(dir, 'icon-extract.ps1')
}

function failPending(error: string, child?: ChildProcessWithoutNullStreams): void {
  if (error) logWarn('quick', `icon helper: ${error}`)
  for (const [id, request] of [...pending]) {
    clearTimeout(request.timer)
    pending.delete(id)
    request.resolve(undefined)
  }
  if (helper === child) helper = null
}

function connect(): ChildProcessWithoutNullStreams {
  if (helper && helper.exitCode === null && !helper.killed) return helper
  if (Date.now() < failedUntil) throw new Error('图标提取辅助程序不可用')
  const file = helperFile()
  if (!existsSync(file)) { failedUntil = Date.now() + 30_000; throw new Error('图标提取辅助程序未构建') }
  const child = spawn('powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
    { windowsHide: true, stdio: 'pipe' })
  helper = child
  createInterface({ input: child.stdout }).on('line', line => {
    if (line.length > 4 * 1024 * 1024) return
    try {
      const message = JSON.parse(line) as { id?: number; icon?: string; error?: string }
      if (typeof message.id !== 'number') return
      const request = pending.get(message.id)
      if (!request) return
      pending.delete(message.id)
      clearTimeout(request.timer)
      request.resolve(message.icon)
    } catch { /* 非协议输出忽略 */ }
  })
  child.stderr.resume()
  const close = (): void => failPending('', child)
  child.on('error', close)
  child.on('exit', close)
  return child
}

/** 提取单个文件的图标；失败返回 undefined（调用方可回退 Electron getFileIcon）。 */
export function extractWindowsIcon(file: string, index: number, timeout = 10_000): Promise<string | undefined> {
  if (Date.now() < failedUntil) return Promise.resolve(undefined)
  let child: ChildProcessWithoutNullStreams
  try { child = connect() } catch { return Promise.resolve(undefined) }
  const id = ++sequence
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pending.delete(id)
      // 单次超时不惩罚整个辅助进程（首次 Add-Type 编译可能较慢）。
      resolve(undefined)
    }, timeout)
    timer.unref?.()
    pending.set(id, { resolve, timer })
    try { child.stdin.write(`${JSON.stringify({ id, file, index })}\n`) }
    catch (error) { clearTimeout(timer); pending.delete(id); logWarn('quick', `icon request failed: ${String(error)}`); resolve(undefined) }
  })
}

export function disposeIconExtractor(): void {
  failPending('')
  if (helper && helper.exitCode === null) {
    try { helper.kill() } catch { /* 已退出 */ }
  }
  helper = null
}
