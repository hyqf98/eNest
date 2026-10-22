import { app } from 'electron'
import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { endianness } from 'node:os'
import { join } from 'node:path'

export type ProcessMemoryMetric = 'footprint' | 'private' | 'resident-swap' | 'resident' | 'unavailable'

export interface ProcessMemorySample {
  pid: number
  /** 0 when the parent is unknown. */
  parentPid: number
  /** Unix milliseconds; 0 when unavailable. ps fallback has only second precision. */
  startedAt: number
  /** Bytes, including compressed/swapped memory only when the metric supports it. */
  memoryBytes: number | null
  /** Resident bytes, not an alternative name for footprint/private memory. */
  residentBytes: number | null
  metric: ProcessMemoryMetric
}

const COMMAND_TIMEOUT_MS = 2500
const MAX_BUFFER_BYTES = 2 * 1024 * 1024
const PROC_CONCURRENCY = 8
const HELPER_RETRY_MS = 30_000
let macHelperRetryAt = 0

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 0xffffffff
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function unavailable(pid: number, parentPid = 0, startedAt = 0): ProcessMemorySample {
  return { pid, parentPid, startedAt, memoryBytes: null, residentBytes: null, metric: 'unavailable' }
}

function helperPath(file: string): string {
  const dir = app.isPackaged ? join(process.resourcesPath, 'native') : join(app.getAppPath(), 'native/bin')
  return join(dir, file)
}

/** Fixed executables/arguments only; never invokes a shell or includes process command lines. */
function run(file: string, args: string[], utc = false): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      encoding: 'utf8',
      windowsHide: true,
      ...(utc ? { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } } : {})
    }, (error, stdout) => {
      // Discard partial output on timeout, buffer overflow or nonzero exit.
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

/** Native wire format is a compact array of [pid, ppid, epochMs, memoryBytes, residentBytes]. */
function parseNativeRows(text: string, metric: 'footprint' | 'private'): ProcessMemorySample[] {
  const input: unknown = JSON.parse(text.replace(/^\uFEFF/, ''))
  if (!Array.isArray(input) || input.length === 0) throw new Error('No process memory snapshot')
  const rows = new Map<number, ProcessMemorySample>()
  for (const row of input) {
    if (!Array.isArray(row) || row.length !== 5 || !isPid(row[0])
      || nonnegativeInteger(row[1]) === null || row[1] > 0xffffffff
      || nonnegativeInteger(row[2]) === null) throw new Error('Invalid process memory snapshot')
    const memoryBytes = nonnegativeInteger(row[3])
    const residentBytes = nonnegativeInteger(row[4])
    rows.set(row[0], {
      pid: row[0], parentPid: row[1], startedAt: row[2],
      memoryBytes: memoryBytes ?? residentBytes, residentBytes,
      metric: memoryBytes !== null ? metric : residentBytes !== null ? 'resident' : 'unavailable'
    })
  }
  return [...rows.values()]
}

/** Linear traversal, including grandchildren and parents whose metadata could not be read. */
function descendants(rows: ProcessMemorySample[], roots: number[]): Set<number> {
  const byPid = new Map(rows.map(row => [row.pid, row]))
  const children = new Map<number, ProcessMemorySample[]>()
  for (const row of rows) {
    if (!row.parentPid || row.parentPid === row.pid) continue
    const parent = byPid.get(row.parentPid)
    // Windows retains a dead parent's PID; do not attach to a newer reuse of that PID.
    if (parent?.startedAt && row.startedAt && row.startedAt < parent.startedAt) continue
    const siblings = children.get(row.parentPid)
    if (siblings) siblings.push(row)
    else children.set(row.parentPid, [row])
  }
  const selected = new Set(roots)
  const queue = [...selected]
  for (let index = 0; index < queue.length; index++) {
    for (const child of children.get(queue[index]) ?? []) {
      if (selected.has(child.pid)) continue
      selected.add(child.pid)
      queue.push(child.pid)
    }
  }
  return selected
}

async function sampleMacResident(): Promise<ProcessMemorySample[]> {
  // lstart, unlike elapsed time, remains stable between samples. No user/name/args columns.
  const text = await run('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,rss='], true)
  const rows: ProcessMemorySample[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\d+)\s*$/.exec(line)
    if (!match) continue
    const pid = Number(match[1]), parentPid = Number(match[2])
    if (!isPid(pid) || nonnegativeInteger(parentPid) === null || parentPid > 0xffffffff) continue
    const parsedStart = Date.parse(`${match[3]} UTC`)
    const startedAt = nonnegativeInteger(parsedStart) ?? 0
    const residentBytes = nonnegativeInteger(Number(match[4]) * 1024)
    rows.push({
      ...unavailable(pid, parentPid, startedAt),
      memoryBytes: residentBytes, residentBytes,
      metric: residentBytes === null ? 'unavailable' : 'resident'
    })
  }
  if (!rows.length) throw new Error('No resident memory snapshot')
  return rows
}

async function sampleMac(roots: number[]): Promise<ProcessMemorySample[]> {
  let rows: ProcessMemorySample[]
  if (Date.now() < macHelperRetryAt) return sampleMacResident()
  try {
    rows = parseNativeRows(await run(helperPath('process-memory-helper'), []), 'footprint')
    macHelperRetryAt = 0
  } catch {
    // Missing/not executable helper, denied libproc enumeration, timeout or invalid JSON.
    macHelperRetryAt = Date.now() + HELPER_RETRY_MS
    return sampleMacResident()
  }

  const selected = descendants(rows, roots)
  const missing = new Set(roots.filter(pid => !rows.some(row => row.pid === pid)))
  for (const row of rows) if (selected.has(row.pid) && row.memoryBytes === null) missing.add(row.pid)
  if (!missing.size) return rows
  try {
    // One bulk fallback for per-PID rusage denials/races, never one command per process.
    const resident = new Map((await sampleMacResident()).map(row => [row.pid, row]))
    rows = rows.map(row => {
      if (!missing.has(row.pid)) return row
      const fallback = resident.get(row.pid)
      if (!fallback || (row.startedAt && fallback.startedAt
        && Math.floor(row.startedAt / 1000) !== Math.floor(fallback.startedAt / 1000))) return row
      return { ...fallback, startedAt: row.startedAt || fallback.startedAt }
    })
    const present = new Set(rows.map(row => row.pid))
    for (const pid of roots) {
      const fallback = resident.get(pid)
      if (!present.has(pid) && fallback) rows.push(fallback)
    }
  } catch { /* Preserve valid native metadata and explicit nulls, not invented zero usage. */ }
  return rows
}

interface LinuxClock { bootMs: number; ticksPerSecond: number }
let linuxClock: Promise<LinuxClock | null> | undefined

function getLinuxClock(): Promise<LinuxClock | null> {
  if (!linuxClock) {
    linuxClock = (async () => {
      // AT_CLKTCK (17) avoids assuming USER_HZ=100 and does not spawn getconf.
      const [stat, auxv] = await Promise.all([
        readFile('/proc/stat', 'utf8'), readFile(`/proc/${process.pid}/auxv`)
      ])
      const boot = /^btime\s+(\d+)\s*$/m.exec(stat)
      const bootMs = boot ? nonnegativeInteger(Number(boot[1]) * 1000) : null
      const width = ['ia32', 'arm', 'mips', 'mipsel'].includes(process.arch) ? 4 : 8
      const little = endianness() === 'LE'
      const word = (offset: number): number => width === 4
        ? (little ? auxv.readUInt32LE(offset) : auxv.readUInt32BE(offset))
        : Number(little ? auxv.readBigUInt64LE(offset) : auxv.readBigUInt64BE(offset))
      for (let offset = 0; offset + width * 2 <= auxv.length; offset += width * 2) {
        const type = word(offset)
        if (type === 0) break
        if (type !== 17) continue
        const ticksPerSecond = word(offset + width)
        if (bootMs !== null && Number.isSafeInteger(ticksPerSecond) && ticksPerSecond > 0) {
          return { bootMs, ticksPerSecond }
        }
      }
      return null
    })().catch(() => null).then(clock => {
      if (!clock) linuxClock = undefined // Allow recovery if procfs was temporarily unavailable.
      return clock
    })
  }
  return linuxClock
}

interface LinuxIdentity { parentPid: number; startTicks: number }

function parseLinuxStat(text: string, pid: number): LinuxIdentity | null {
  // comm may contain spaces, closing parentheses and newlines; it is never returned.
  const end = text.lastIndexOf(')')
  if (!text.startsWith(`${pid} (`) || end < 0) return null
  const fields = text.slice(end + 1).trim().split(/\s+/)
  const parentPid = nonnegativeInteger(Number(fields[1]))
  const startTicks = nonnegativeInteger(Number(fields[19])) // stat field 22, after pid/comm.
  return parentPid !== null && parentPid <= 0xffffffff && startTicks !== null
    ? { parentPid, startTicks } : null
}

function linuxStartedAt(identity: LinuxIdentity, clock: LinuxClock | null): number {
  return clock ? nonnegativeInteger(Math.floor(clock.bootMs + identity.startTicks * 1000 / clock.ticksPerSecond)) ?? 0 : 0
}

async function eachProc<T>(items: T[], visit: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(PROC_CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]
      await visit(item)
    }
  }))
}

function linuxKiB(status: string, field: 'VmRSS' | 'VmSwap'): number | null {
  const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB\\s*$`, 'm').exec(status)
  return match ? nonnegativeInteger(Number(match[1]) * 1024) : null
}

async function sampleLinux(roots: number[]): Promise<ProcessMemorySample[]> {
  const clock = await getLinuxClock()
  const entries = await readdir('/proc', { withFileTypes: true })
  const pids = entries.filter(entry => entry.isDirectory() && /^[1-9]\d*$/.test(entry.name))
    .map(entry => Number(entry.name)).filter(isPid)
  const identities = new Map<number, LinuxIdentity>()
  const byPid = new Map<number, ProcessMemorySample>()
  await eachProc(pids, async pid => {
    try {
      const identity = parseLinuxStat(await readFile(`/proc/${pid}/stat`, 'utf8'), pid)
      if (!identity) { byPid.set(pid, unavailable(pid)); return }
      identities.set(pid, identity)
      byPid.set(pid, unavailable(pid, identity.parentPid, linuxStartedAt(identity, clock)))
    } catch { byPid.set(pid, unavailable(pid)) }
  })

  const selected = [...descendants([...byPid.values()], roots)].filter(pid => identities.has(pid))
  await eachProc(selected, async pid => {
    try {
      const status = await readFile(`/proc/${pid}/status`, 'utf8')
      const identity = parseLinuxStat(await readFile(`/proc/${pid}/stat`, 'utf8'), pid)
      // Do not combine one process's identity with a reused PID's memory.
      if (!identity) return
      const previous = identities.get(pid)!
      if (identity.startTicks !== previous.startTicks) {
        byPid.set(pid, unavailable(pid, identity.parentPid, linuxStartedAt(identity, clock)))
        return
      }
      const residentBytes = linuxKiB(status, 'VmRSS')
      const swapBytes = linuxKiB(status, 'VmSwap')
      const combined = residentBytes !== null && swapBytes !== null
        ? nonnegativeInteger(residentBytes + swapBytes) : null
      byPid.set(pid, {
        ...unavailable(pid, identity.parentPid, linuxStartedAt(identity, clock)),
        memoryBytes: combined ?? residentBytes, residentBytes,
        metric: combined !== null ? 'resident-swap' : residentBytes !== null ? 'resident' : 'unavailable'
      })
    } catch { /* Exited, hidden or denied: retain identity with null memory. */ }
  })
  return [...byPid.values()]
}

async function sampleWindows(): Promise<ProcessMemorySample[]> {
  // Resolve the existing Windows PowerShell, not a plugin-controlled executable on PATH.
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const text = await run(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', helperPath('process-memory-helper.ps1')
  ])
  return parseNativeRows(text, 'private')
}

/**
 * Intended for non-overlapping, five-second polling. Memory is sampled for roots and descendants.
 * Other rows contain only PID/PPID/start identity, allowing the caller to retain known descendants
 * after reparenting and include those PIDs as roots next time. Unknown/exited roots are explicit
 * unavailable rows; unsupported platforms/command failures never become zero-byte measurements.
 */
export async function sampleProcessMemory(pids: number[]): Promise<ProcessMemorySample[]> {
  const roots = [...new Set(pids.filter(isPid))]
  if (!roots.length) return []
  try {
    let rows: ProcessMemorySample[]
    switch (process.platform) {
      case 'darwin': rows = await sampleMac(roots); break
      case 'linux': rows = await sampleLinux(roots); break
      case 'win32': rows = await sampleWindows(); break
      default: return roots.map(pid => unavailable(pid))
    }
    const selected = descendants(rows, roots)
    const present = new Set(rows.map(row => row.pid))
    const result = rows.map(row => selected.has(row.pid)
      ? row : unavailable(row.pid, row.parentPid, row.startedAt))
    for (const pid of roots) if (!present.has(pid)) result.push(unavailable(pid))
    return result
  } catch {
    return roots.map(pid => unavailable(pid))
  }
}
