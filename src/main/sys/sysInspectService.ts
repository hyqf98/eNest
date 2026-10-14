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
import process from 'node:process'

/** 采样缓存 TTL：1s 内重复调用共享同一次命令输出 */
const SAMPLE_CACHE_MS = 1_000
const CMD_TIMEOUT_MS = 5_000

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

export async function sysProcesses(): Promise<SysProcessInfo[]> {
  return cachedSample('ps', async () => {
    if (process.platform === 'darwin') {
      return parsePsOutput(await run('ps', ['-axo', 'pid,pcpu,pmem,rss,user,comm']))
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
  const identity = (await run('ps', ['-p', String(pid), '-o', 'lstart=,comm='])).trim()
  if (!identity) throw new Error('process no longer exists')
  await confirmPluginOperation(pluginId, `结束进程 ${pid}？`, `${identity}\n信号：${signal}`)
  if ((await run('ps', ['-p', String(pid), '-o', 'lstart=,comm='])).trim() !== identity) throw new Error('process identity changed; select it again')
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
