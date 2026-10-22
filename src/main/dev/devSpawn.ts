/**
 * devSpawn — 开发命令进程的通用 spawn 机制（dev server 拉起与 prod 构建共用）。
 * 命令全部来自 devCommandResolver 的解析结果；本模块只负责平台差异与 PATH 兜底。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { DevCommandSpec } from '@shared/types/plugin'

export interface SpawnCandidate {
  command: string
  args: string[]
  useShell?: boolean
}

interface OwnedChild {
  group: boolean
  exited: boolean
  stopping: boolean
  killing?: boolean
  killTimer?: ReturnType<typeof setTimeout>
}
const ownedChildren = new WeakMap<ChildProcess, OwnedChild>()
const KILL_DEADLINE_MS = 250
const MAX_OUTPUT_BYTES = 8 * 1024

/** script 型端口漂移参数模板渲染；raw 型命令中的 {port} 由调用方替换。 */
export function formatPortArgs(template: string[] | undefined, port: number): string[] {
  return (template ?? ['--', '--port={port}']).map(arg => arg.replaceAll('{port}', String(port)))
}

/**
 * 按平台生成候选命令：
 * - script 型 `<manager> run <script>`：Windows 用 `<manager>.cmd`；posix ENOENT 回退 login shell（GUI 启动 PATH 不含 node）
 * - raw 型：整行命令交给系统 shell 执行
 */
export function buildSpawnCandidates(spec: DevCommandSpec, extraArgs: string[]): SpawnCandidate[] {
  const isWin = process.platform === 'win32'
  if (spec.kind === 'raw') {
    return [{ command: [spec.command, ...extraArgs].join(' ').trim(), args: [], useShell: true }]
  }
  const manager = spec.manager ?? 'npm'
  const args = ['run', spec.command, ...extraArgs]
  return isWin
    ? [{ command: `${manager}.cmd`, args, useShell: true }]
    : [
        { command: manager, args },
        { command: process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash', args: ['-lc', `${manager} ${args.join(' ')}`] },
      ]
}

/** 依次尝试候选命令（ENOENT 才前进）；取消后不再回退，迟到的 spawn 仍须回收。 */
export async function spawnCommand(
  cwd: string,
  candidates: SpawnCandidate[],
  env: NodeJS.ProcessEnv,
  onWarn: (message: string) => void,
  options: { signal?: AbortSignal; onChild?: (child: ChildProcess) => void } = {}
): Promise<ChildProcess | null> {
  const isWin = process.platform === 'win32'
  return new Promise(resolve => {
    let settled = false
    let activeChild: ChildProcess | undefined
    const finish = (child: ChildProcess | null) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', abort)
      resolve(child)
    }
    const abort = () => {
      if (activeChild) killTree(activeChild)
      finish(null)
    }
    const attempt = (index: number) => {
      if (settled || options.signal?.aborted) { finish(null); return }
      const candidate = candidates[index]
      if (!candidate) {
        onWarn('启动命令不可用（未安装或不在 PATH）；请手动启动后重载')
        finish(null)
        return
      }
      let child: ChildProcess
      try {
        child = spawn(candidate.command, candidate.args, {
          cwd,
          detached: !isWin, // 只向这里创建的 posix 进程组发送组信号
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
          ...(candidate.useShell || isWin ? { shell: true, windowsHide: true } : {})
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') attempt(index + 1)
        else { onWarn(`启动开发命令失败：${String(error)}`); finish(null) }
        return
      }
      activeChild = child
      const ownership: OwnedChild = { group: !isWin, exited: false, stopping: false }
      ownedChildren.set(child, ownership)
      const exited = () => {
        ownership.exited = true
        if (ownership.killTimer) clearTimeout(ownership.killTimer)
      }
      child.once('exit', exited)
      child.once('close', exited)
      let spawned = false
      child.once('error', error => {
        // A failed signal/IPC operation is not evidence that a spawned child exited.
        if (spawned) return
        ownership.exited = true
        if (ownership.killTimer) clearTimeout(ownership.killTimer)
        if (settled || options.signal?.aborted) { finish(null); return }
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') attempt(index + 1)
        else { onWarn(`启动开发命令失败：${error.message}`); finish(null) }
      })
      child.once('spawn', () => {
        spawned = true
        if (ownership.stopping || options.signal?.aborted) { killTree(child); finish(null) }
        else finish(child)
      })
      // Ownership/output must be installed immediately, not after readiness polling.
      options.onChild?.(child)
      if (options.signal?.aborted) abort()
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    attempt(0)
  })
}

/** 子进程 stdout/stderr 按行转发；无换行输出也只保留/转发有界尾部。 */
export function pipeOutput(child: ChildProcess, onLine: (level: 'info' | 'warn', text: string) => void): void {
  const tail = (text: string): string => {
    const bytes = Buffer.from(text, 'utf8')
    return bytes.length > MAX_OUTPUT_BYTES ? bytes.subarray(-MAX_OUTPUT_BYTES).toString('utf8') : text
  }
  for (const [stream, level] of [[child.stdout, 'info'], [child.stderr, 'warn']] as const) {
    if (!stream) continue
    stream.setEncoding('utf8')
    let buffer = ''
    const flush = () => {
      const text = tail(buffer).trim()
      buffer = ''
      if (text) onLine(level, text)
    }
    stream.on('data', (chunk: string) => {
      let start = 0
      let newline: number
      while ((newline = chunk.indexOf('\n', start)) !== -1) {
        buffer = tail(buffer + chunk.slice(start, newline))
        flush()
        start = newline + 1
      }
      buffer += chunk.slice(start)
      if (Buffer.byteLength(buffer, 'utf8') >= MAX_OUTPUT_BYTES) flush()
    })
    stream.once('end', flush)
  }
}

/** Never signal a discovered PID or an already-reaped group leader (PID/PGID reuse). */
export function killTree(child: ChildProcess): void {
  const ownership = ownedChildren.get(child)
  if (!ownership || ownership.exited || child.exitCode !== null || child.signalCode !== null) return
  ownership.stopping = true
  const pid = child.pid
  if (pid === undefined) return // spawn listener retries termination when the PID becomes available
  const alive = () => !ownership.exited && child.pid === pid && child.exitCode === null && child.signalCode === null
  if (process.platform === 'win32') {
    if (ownership.killing) return
    ownership.killing = true
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
      killer.once('error', () => { if (alive()) { try { child.kill() } catch { /* already gone */ } } })
    } catch { if (alive()) { try { child.kill() } catch { /* already gone */ } } }
  } else {
    try {
      if (ownership.group) process.kill(-pid, 'SIGTERM')
      else child.kill('SIGTERM')
    } catch { if (alive()) { try { child.kill('SIGTERM') } catch { /* already gone */ } } }
    if (!alive() || ownership.killTimer) return
    ownership.killTimer = setTimeout(() => {
      if (!alive()) return
      try {
        if (ownership.group) process.kill(-pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch { /* exit/close listeners own cleanup; never retry a reaped PID */ }
    }, KILL_DEADLINE_MS)
    ownership.killTimer.unref()
  }
}
