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

/** 依次尝试候选命令（ENOENT 才前进）；全部不可用返回 null 并经 onWarn 提示。 */
export async function spawnCommand(
  cwd: string,
  candidates: SpawnCandidate[],
  env: NodeJS.ProcessEnv,
  onWarn: (message: string) => void
): Promise<ChildProcess | null> {
  const isWin = process.platform === 'win32'
  return new Promise(resolve => {
    const attempt = (index: number) => {
      const candidate = candidates[index]
      if (!candidate) {
        onWarn('启动命令不可用（未安装或不在 PATH）；请手动启动后重载')
        resolve(null)
        return
      }
      const child = spawn(candidate.command, candidate.args, {
        cwd,
        detached: !isWin, // posix 侧整组 kill(-pid)；Windows 用 taskkill /T
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        ...(candidate.useShell || isWin ? { shell: true, windowsHide: true } : {})
      })
      child.once('error', (error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') attempt(index + 1)
        else {
          onWarn(`启动开发命令失败：${error.message}`)
          resolve(null)
        }
      })
      child.once('spawn', () => resolve(child))
    }
    attempt(0)
  })
}

/** 子进程 stdout/stderr 按行转发到开发者日志面板。 */
export function pipeOutput(child: ChildProcess, onLine: (level: 'info' | 'warn', text: string) => void): void {
  for (const [stream, level] of [[child.stdout, 'info'], [child.stderr, 'warn']] as const) {
    if (!stream) continue
    stream.setEncoding('utf8')
    let buffer = ''
    stream.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const text = line.trim()
        if (text) onLine(level, text)
      }
    })
  }
}

export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      .once('error', () => { try { child.kill() } catch { /* already gone */ } })
  } else {
    try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch { /* already gone */ } }
  }
}
