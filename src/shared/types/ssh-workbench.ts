/** SSH workbench capabilities. Remote resources stay owned by the caller's session. */
export type SshRemotePlatform = 'linux' | 'darwin' | 'win32'
export interface SshProcessInfo {
  pid: number
  name: string
  user?: string
  cpuPercent?: number
  memoryBytes?: number
  startTime: string
}
export interface SshPortInfo {
  protocol: string
  address: string
  port: number
  pid?: number
  process?: string
}
export interface SshSystemSnapshot {
  platform: SshRemotePlatform
  ts: number
  cpuPercent?: number
  memTotal?: number
  memUsed?: number
  memPercent?: number
  load1?: number
  uptimeSec?: number
  disks: Array<{ mount: string; usedPercent: number; used?: number; total?: number }>
  net: Array<{ iface: string; rxKbps: number; txKbps: number }>
}
export interface SshFileInfo {
  name: string
  path: string
  type: 'file' | 'dir' | 'link' | 'other'
  size: number
  mtime: number
  mode: number
  uid?: number
  gid?: number
}
export interface SshTransferTask {
  id: string
  sessionId: string
  direction: 'upload' | 'download' | 'copy' | 'move'
  source: string
  destination: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  transferred: number
  total: number
  startedAt: number
  error?: string
  resumable?: boolean
  canRetry?: boolean
}
export interface SshWorkbenchRequest {
  action: string
  sessionId?: string
  sourceSessionId?: string
  path?: string
  paths?: string[]
  destination?: string
  content?: string
  expectedMtime?: number
  pid?: number
  startTime?: string
  signal?: 'TERM' | 'KILL'
  name?: string
  operation?: string
  confirmed?: boolean
  entries?: Array<{ path: string; name: string }>
  id?: string
  localPort?: number
  remoteHost?: string
  remotePort?: number
  direction?: 'local' | 'remote'
  overwrite?: boolean
  localHandleId?: string
  expectedHash?: string
  answers?: string[]
}
