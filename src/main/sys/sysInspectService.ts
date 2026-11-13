import { confirmPluginOperation } from '@main/plugin/PluginPermissions'
/**
 * sysInspectService — 本机进程 / 端口查看宿主服务（sys.inspect 权限）
 * 职责：解析 `ps -axo ...`（darwin）与 `lsof -nP -iTCP -sTCP:LISTEN`（darwin）
 *      输出；Linux 探测式回退 ps / ss / netstat；sys.kill 需 sys.control 与宿主原生确认
 *      且禁止 kill 壳子自身进程与 PID 1；采样 1s 防抖缓存。
 * 被 pluginHandlers 分发调用（method 以 sys.* 开头）。
 * 关键依赖：node:child_process（零新依赖）。
 */
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import process from 'node:process'

/** 采样缓存 TTL：1s 内重复调用共享同一次命令输出 */
const SAMPLE_CACHE_MS = 1_000
const CMD_TIMEOUT_MS = 5_000

/** Windows PowerShell 启动参数：不走 PATH、不加载用户 profile（与 pluginProcessMemory 一致） */
const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'] as const

/** 解析 System32 下既有 Windows PowerShell 绝对路径，不信任 PATH（防插件投毒） */
function windowsPowerShell(): string {
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

export interface SysProcessInfo {
  pid: number
  pcpu: number
  pmem: number
  /** 常驻内存（KB） */
  rss: number
  user: string
  command: string
}

export interface SysPortInfo {
  command: string
  pid: number
  user: string
  protocol: string
  address: string
  port: number
  name: string
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: CMD_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout ?? ''))
    })
  })
}

/** 采样缓存包装：key → { at, promise }，1s 内直接复用 in-flight/已完成结果 */
const sampleCache = new Map<string, { at: number; promise: Promise<unknown> }>()
function cachedSample<T>(key: string, produce: () => Promise<T>): Promise<T> {
  const hit = sampleCache.get(key)
  if (hit && Date.now() - hit.at < SAMPLE_CACHE_MS) return hit.promise as Promise<T>
  const promise = produce()
  sampleCache.set(key, { at: Date.now(), promise })
  // 失败不缓存失败态：让下次重试
  promise.catch(() => sampleCache.delete(key))
  return promise
}

/**
 * 解析 `ps -axo pid,pcpu,pmem,rss,user,comm` 输出（darwin）或
 * `ps -eo pid,pcpu,pmem,rss,user,args --sort=pid`（Linux 回退）。
 * 纯函数，单测覆盖。
 */
export function parsePsOutput(stdout: string): SysProcessInfo[] {
  const lines = stdout.split('\n')
  const out: SysProcessInfo[] = []
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue
    // pid pcpu pmem rss user 余下为 command（comm 可能带路径；args 带参数）
    const m = /^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    if (!Number.isFinite(pid) || pid <= 0) continue
    out.push({
      pid,
      pcpu: Number(m[2]) || 0,
      pmem: Number(m[3]) || 0,
      rss: Number(m[4]) || 0,
      user: m[5],
      command: m[6].trim()
    })
  }
  return out
}

/**
 * 解析 `lsof -nP -iTCP -sTCP:LISTEN` 输出。
 * 列：COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME（IPv4/IPv6）。
 * 纯函数，单测覆盖。
 */
export function parseLsofOutput(stdout: string): SysPortInfo[] {
  const lines = stdout.split('\n')
  const out: SysPortInfo[] = []
  const seen = new Set<string>()
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue
    const cols = line.trim().split(/\s+/)
    if (cols.length < 9) continue
    const [command, pidRaw, user, , , , , , nameCol] = cols
    // NAME 形如 127.0.0.1:5900 / *:5900 / [::1]:5900
    const nameMatch = /^(.+):(\d+)$/.exec(nameCol)
    if (!nameMatch) continue
    const pid = Number(pidRaw)
    if (!Number.isFinite(pid) || pid <= 0) continue
    const key = `${pid}/${nameCol}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      command,
      pid,
      user,
      // lsof TCP 行均为 IPv4/IPv6；NODE 列是 TCP/UDP 标识，此处固定 TCP（LISTEN 过滤）
      protocol: 'TCP',
      address: nameMatch[1] === '*' ? '0.0.0.0' : nameMatch[1].replace(/^\[|\]$/g, ''),
      port: Number(nameMatch[2]),
      name: nameCol
    })
  }
  return out
}

/** Linux 回退：解析 `ss -ltnp` 输出 */
export function parseSsOutput(stdout: string): SysPortInfo[] {
  const lines = stdout.split('\n')
  const out: SysPortInfo[] = []
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue
    const cols = line.trim().split(/\s+/)
    if (cols.length < 4) continue
    // State Recv-Q Send-Q LocalAddr:Port PeerAddr:Port Process
    const local = cols[3]
    const nameMatch =/^(.+):(\d+)$/.exec(local)
    if (!nameMatch) continue
    const processCol = cols.slice(5).join(' ') || ''
    const pidMatch = /pid=(\d+)/.exec(processCol)
    const cmdMatch = /users:\(\("([^"]+)"/.exec(processCol)
    const pid = pidMatch ? Number(pidMatch[1]) : 0
    out.push({
      command: cmdMatch ? cmdMatch[1] : '',
      pid,
      user: '',
      protocol: cols[0].toUpperCase().includes('TCP6') ? 'TCP6' : 'TCP',
      address: nameMatch[1].replace(/^\[|\]$/g, '') || '0.0.0.0',
      port: Number(nameMatch[2]),
      name: local
    })
  }
  return out
}

/**
 * 解析 Windows PowerShell `Get-Process | Select-Object Id,ProcessName,CPU,WS,Path |
 * ConvertTo-Json -Compress` 输出（win32）。ConvertTo-Json 单对象/数组均可能出现，统一按数组处理。
 * 字段映射（对齐 parsePsOutput 语义）：
 * - rss：WS 为工作集字节数，除以 1024 对齐 ps rss 的 KB 单位
 * - pcpu / pmem：Get-Process 的 CPU 是累计处理器秒数而非瞬时百分比，无法等价换算，置 0
 * - user：Get-Process 不提供属主（查询 Owner 需提权 Win32 API），置空串
 * - command：优先 Path（可执行完整路径），系统/受保护进程 Path 为 null 时回退 ProcessName
 */
export function parsePowerShellProcesses(stdout: string): SysProcessInfo[] {
  const text = stdout.trim()
  if (!text) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const out: SysProcessInfo[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const pid = Number(r.Id)
    if (!Number.isInteger(pid) || pid <= 0) continue
    out.push({
      pid,
      pcpu: 0,
      pmem: 0,
      rss: Math.round((Number(r.WS) || 0) / 1024),
      user: '',
      command: typeof r.Path === 'string' && r.Path ? r.Path : String(r.ProcessName ?? '')
    })
  }
  return out
}

export async function sysProcesses(): Promise<SysProcessInfo[]> {
  return cachedSample('ps', async () => {
    if (process.platform === 'darwin') {
      return parsePsOutput(await run('ps', ['-axo', 'pid,pcpu,pmem,rss,user,comm']))
    }
    if (process.platform === 'win32') {
      const text = await run(windowsPowerShell(), [
        ...POWERSHELL_ARGS,
        '-Command',
        'Get-Process | Select-Object Id,ProcessName,CPU,WS,Path | ConvertTo-Json -Compress'
      ])
      return parsePowerShellProcesses(text)
    }
    // Linux 回退（探测式：先试 --sort 参数形态，失败回退朴素 -eo）
    try {
      return parsePsOutput(await run('ps', ['-eo', 'pid,pcpu,pmem,rss,user,args', '--sort=pid']))
    } catch {
      return parsePsOutput(await run('ps', ['-eo', 'pid,pcpu,pmem,rss,user,args']))
    }
  })
}

export async function sysPorts(): Promise<SysPortInfo[]> {
  return cachedSample('ports', async () => {
    if (process.platform === 'darwin') {
      return parseLsofOutput(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']))
    }
    if (process.platform === 'linux') {
      try {
        return parseSsOutput(await run('ss', ['-ltnp']))
      } catch {
        // netstat 回退：netstat -ltnp 输出与 ss 不同，尽力解析（address:port 末两列）
        const text = await run('netstat', ['-ltnp'])
        return parseSsOutput(text.replace(/^Active Internet connections.*\n/, ''))
      }
    }
    throw new Error(`sys.ports unsupported on ${process.platform}`)
  })
}

/**
 * 读取待 kill 进程的身份字符串（启动时间 + 命令名）。
 * darwin/Linux：`ps -p <pid> -o lstart=,comm=`；win32：PowerShell
 * `Get-Process -Id <pid> | Select-Object ProcessName,StartTime | ConvertTo-Json -Compress`，
 * 组合 `StartTime/ProcessName` 保持「启动时间 + 命令名」的同一防 TOCTOU 语义。
 * 进程不存在返回空串。
 */
async function processIdentity(pid: number): Promise<string> {
  if (process.platform === 'win32') {
    const text = await run(windowsPowerShell(), [
      ...POWERSHELL_ARGS,
      '-Command',
      `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object ProcessName,StartTime | ConvertTo-Json -Compress`
    ])
    const row = text.trim() ? JSON.parse(text.trim()) as Record<string, unknown> : null
    if (!row) return ''
    const start = row.StartTime // ConvertTo-Json 序列化为 /Date(epochMs)/ 或 ISO 字符串，按原样拼接
    const name = row.ProcessName
    if (typeof start !== 'string' || typeof name !== 'string' || !start || !name) return ''
    return `${start} ${name}`
  }
  return (await run('ps', ['-p', String(pid), '-o', 'lstart=,comm='])).trim()
}

export async function sysKill(
  pluginId: string,
  pid: number,
  signal: 'TERM' | 'KILL' | 'INT',
  confirmed: boolean
): Promise<boolean> {
  void confirmed // UI hints cannot authorize an operating system action.
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('refusing to kill pid <= 1')
  if (pid === process.pid || pid === process.ppid) {
    throw new Error('refusing to kill eNest process')
  }
  const identity = await processIdentity(pid)
  if (!identity) throw new Error('process no longer exists')
  await confirmPluginOperation(pluginId, `结束进程 ${pid}？`, `${identity}\n信号：${signal}`)
  if ((await processIdentity(pid)) !== identity) throw new Error('process identity changed; select it again')
  const sig = signal === 'KILL' ? 'SIGKILL' : signal === 'INT' ? 'SIGINT' : 'SIGTERM'
  await new Promise<void>((resolve, reject) => {
    // process.kill 同步抛错（ESRCH 等）；用 try 包成 Promise 语义
    try {
      process.kill(pid, sig)
      resolve()
    } catch (err) {
      reject(err)
    }
  })
  return true
}
