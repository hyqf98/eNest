/**
 * Dev server 自动拉起与进程回收。
 * resolveDevPluginEntry 在「声明的开发服务未运行」时调用 ensureDevServer：
 * 按 devCommandResolver 解析出的命令（包管理器/脚本/enest.dev.command 均来自插件
 * package.json）spawn 并轮询就绪，就绪后走 devUrl + 框架自带 HMR。
 * 忘记插件 / 应用退出时只回收自己拉起的进程树；用户手动启动的服务只复用、不接管。
 */
import { createServer } from 'node:net'
import type { ChildProcess } from 'node:child_process'
import { net } from 'electron'
import { sendShellEvent } from '@main/window/createShellWindow'
import { logInfo } from '@main/logs/logService'
import type { DevCommandSpec, PluginManifest } from '@shared/types/plugin'
import { buildSpawnCandidates, formatPortArgs, killTree, pipeOutput, spawnCommand } from './devSpawn'

const READY_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 500
/** 拉起失败后的冷却期：避免 watcher 触发的每次重载都重新等待一次就绪超时 */
const RETRY_COOLDOWN_MS = 60_000
/** 声明端口被占时向上尝试的端口数（插件仓 dev 脚本普遍硬编码 5173，多插件并行开发必冲突） */
const PORT_SCAN_RANGE = 32

interface ManagedServer {
  url: string
  child: ChildProcess
}

const managed = new Map<string, ManagedServer>()
const pending = new Map<string, Promise<string | null>>()
const lastFailedAt = new Map<string, number>()

/** A listening port alone does not identify a plugin development server. */
export async function matchesDevelopmentServer(url: string, pluginId: string): Promise<boolean> {
  try {
    const response = await net.fetch(new URL('plugin.json', url).href, { signal: AbortSignal.timeout(1200), redirect: 'error', credentials: 'omit' })
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 65536) return false
    const reader = response.body?.getReader()
    if (!reader) return false
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        length += part.value.length
        if (length > 65536) return false
        chunks.push(part.value)
      }
    } finally { await reader.cancel().catch(() => undefined) }
    const manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Partial<PluginManifest>
    return manifest.id === pluginId && manifest.main === 'index.html'
  } catch { return false }
}

function emitLog(pluginId: string, level: 'info' | 'warn', message: string): void {
  sendShellEvent({ type: 'plugin-log', pluginId, level, message: message.slice(0, 2000) })
}

async function launchAndWait(pluginId: string, sourcePath: string, declaredUrl: string, start: DevCommandSpec): Promise<string | null> {
  // 声明端口被其它进程占用时（dev 脚本普遍硬编码同一端口，多插件并行必冲突），
  // 让服务改用空闲端口，并把实际地址用作 devUrl；strictPort 下原端口必然启动失败。
  let targetUrl = declaredUrl
  let extraArgs: string[] = []
  const declared = new URL(declaredUrl)
  const declaredPort = Number(declared.port || (declared.protocol === 'https:' ? 443 : 80))
  let targetPort = declaredPort
  if (!await canListen(declaredPort)) {
    const port = await pickFreePort(declaredPort)
    if (port === null) {
      emitLog(pluginId, 'warn', `端口 ${declaredPort} 被占用且附近无空闲端口，已回退`)
      lastFailedAt.set(pluginId, Date.now())
      return null
    }
    declared.port = String(port)
    targetUrl = declared.toString()
    targetPort = port
    // script 型经 portArgs 模板传参；raw 型命令中的 {port} 占位符替换
    extraArgs = start.kind === 'script' ? formatPortArgs(start.portArgs, port) : []
    if (start.kind === 'raw') start = { ...start, command: start.command.replaceAll('{port}', String(port)) }
    emitLog(pluginId, 'info', `声明端口 ${declaredPort} 被其它进程占用，改用 ${port}`)
  }
  emitLog(pluginId, 'info', `开发服务未运行，正在启动 ${start.label} …`)
  // 端口始终经环境变量兜底透出，供任意工具链的启动脚本读取
  const env = { ...process.env, ...start.env, ENEST_DEV_PORT: String(targetPort) }
  const child = await spawnCommand(sourcePath, buildSpawnCandidates(start, extraArgs), env, warn => emitLog(pluginId, 'warn', warn))
  if (!child) {
    lastFailedAt.set(pluginId, Date.now())
    return null
  }
  pipeOutput(child, (level, text) => emitLog(pluginId, level, text))
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    if (child.exitCode !== null) {
      emitLog(pluginId, 'warn', '开发服务进程已退出（端口被占用或依赖未安装？），详见日志')
      lastFailedAt.set(pluginId, Date.now())
      return null
    }
    if (await matchesDevelopmentServer(targetUrl, pluginId)) {
      managed.set(pluginId, { url: targetUrl, child })
      lastFailedAt.delete(pluginId)
      logInfo('dev', `${pluginId}: dev server started pid=${child.pid} url=${targetUrl}`)
      emitLog(pluginId, 'info', `开发服务已就绪 ${targetUrl}，框架 HMR 生效`)
      return targetUrl
    }
  }
  emitLog(pluginId, 'warn', `开发服务 ${READY_TIMEOUT_MS / 1000}s 内未就绪，已停止并回退；${RETRY_COOLDOWN_MS / 1000}s 内不再自动重试`)
  killTree(child)
  lastFailedAt.set(pluginId, Date.now())
  return null
}

/** 端口当前无监听者即可绑定（插件 dev 脚本固定 --host 127.0.0.1）。 */
function canListen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

async function pickFreePort(base: number): Promise<number | null> {
  for (let port = base + 1; port <= base + PORT_SCAN_RANGE; port++) {
    if (await canListen(port)) return port
  }
  return null
}

/**
 * 确保插件声明的开发服务在线；在线（含用户自启）直接复用，否则按解析出的
 * 启动命令（start）拉起并等待就绪，返回实际 devUrl。
 */
export async function ensureDevServer(pluginId: string, sourcePath: string, url: string, start: DevCommandSpec): Promise<string | null> {
  if (await matchesDevelopmentServer(url, pluginId)) return url
  const failedAt = lastFailedAt.get(pluginId)
  if (failedAt !== undefined && Date.now() - failedAt < RETRY_COOLDOWN_MS) return null
  const running = pending.get(pluginId)
  if (running) return running
  const task = launchAndWait(pluginId, sourcePath, url, start).finally(() => pending.delete(pluginId))
  pending.set(pluginId, task)
  return task
}

export function stopDevServer(pluginId: string): void {
  const server = managed.get(pluginId)
  if (!server) {
    lastFailedAt.delete(pluginId)
    return
  }
  managed.delete(pluginId)
  lastFailedAt.delete(pluginId)
  killTree(server.child)
  logInfo('dev', `${pluginId}: dev server stopped`)
}

export function stopAllDevServers(): void {
  for (const pluginId of [...managed.keys()]) stopDevServer(pluginId)
}
