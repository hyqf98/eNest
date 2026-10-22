/**
 * proxyService — 应用级网络代理
 * 职责：解析/校验代理配置，经 session.setProxy 即时作用于 webContents 与
 * electron net（electron-updater 默认走 defaultSession），并提供连通性测试。
 * 被 index.ts 启动时应用、shellHandlers 读写、PluginHost 新建 session 时注入。
 * 关键依赖：electron session/net、settingsStore、logService。
 */
import { Socket } from 'node:net'
import { session } from 'electron'
import { Agent, EnvHttpProxyAgent, ProxyAgent, setGlobalDispatcher } from 'undici'
import { SHELL_PARTITION, pluginPartition } from '@shared/constants'
import type { ProxyConfig, ProxyType } from '@shared/types/plugin'
import { logInfo, logWarn } from '@main/logs/logService'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { settingsStore } from '@main/settings/SettingsStore'

/** 缺省自动识别系统代理 */
export const DEFAULT_PROXY: ProxyConfig = { type: 'system' }

export type ProxyTestResult = {
  ok: boolean
  latencyMs?: number
  error?: string
}

const PROXY_TYPES: ProxyType[] = ['system', 'none', 'http']

/** 归一化任意入参为合法 ProxyConfig；非法回落自动识别 */
export function normalizeProxy(raw: unknown): ProxyConfig {
  const r = (raw ?? {}) as Partial<ProxyConfig> & { type?: string }
  const type = (PROXY_TYPES as string[]).includes(r.type ?? '') ? (r.type as ProxyType) : 'system'
  if (type === 'system' || type === 'none') return { type }
  const host = typeof r.host === 'string' ? r.host.trim() : ''
  const port = Number(r.port)
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { type: 'system' }
  }
  return { type, host, port }
}

/** 将配置序列化为 session.setProxy 配置；system 表示自动识别 */
export function buildProxyRules(config: ProxyConfig): string {
  const c = normalizeProxy(config)
  if (c.type === 'system') return 'system'
  return c.type === 'none' ? '' : buildProxyEnvUrl(c)
}

/** Node/子进程代理变量只接受单个代理 URL，不能传 Chromium 的分号规则串。 */
export function buildProxyEnvUrl(config: ProxyConfig): string {
  const c = normalizeProxy(config)
  if (c.type !== 'http') return ''
  const host = c.host!.includes(':') && !c.host!.startsWith('[') ? `[${c.host}]` : c.host
  return `${c.type}://${host}:${c.port}`
}

/** 从配置中解析可 TCP 探测的 host:port；自动模式交给系统解析 */
function resolveEndpoint(config: ProxyConfig): { host: string; port: number } | null {
  const c = normalizeProxy(config)
  return c.type === 'http' ? { host: c.host!, port: c.port! } : null
}

let current: ProxyConfig = DEFAULT_PROXY
let envSnapshot: { HTTP_PROXY?: string; HTTPS_PROXY?: string; ALL_PROXY?: string; NO_PROXY?: string } | null = null

export function getActiveProxy(): ProxyConfig {
  return { ...current }
}

function restoreEnv(): void {
  if (!envSnapshot) return
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'] as const) {
    const prev = envSnapshot[k]
    if (prev === undefined) delete process.env[k]
    else process.env[k] = prev
  }
  envSnapshot = null
}

function applyEnv(proxyUrl: string): void {
  if (!envSnapshot) {
    envSnapshot = {
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      ALL_PROXY: process.env.ALL_PROXY,
      NO_PROXY: process.env.NO_PROXY
    }
  }
  if (!proxyUrl) {
    restoreEnv()
    return
  }
  // Node 侧 undici / electron-updater 部分路径会读环境变量
  process.env.HTTP_PROXY = proxyUrl
  process.env.HTTPS_PROXY = proxyUrl
  process.env.ALL_PROXY = proxyUrl
  process.env.NO_PROXY = process.env.NO_PROXY ?? 'localhost,127.0.0.1'
}

/**
 * Node global fetch does not consume proxy environment variables by default.
 * Keep a normal system/direct dispatcher for those modes and install an explicit
 * undici proxy dispatcher for a configured HTTP endpoint.
 */
async function applyNodeDispatcher(config: ProxyConfig): Promise<void> {
  const c = normalizeProxy(config)
  if (c.type === 'http') {
    const proxyUrl = buildProxyEnvUrl(c)
    setGlobalDispatcher(new ProxyAgent({ uri: proxyUrl }))
    return
  }
  if (c.type === 'system') {
    setGlobalDispatcher(new EnvHttpProxyAgent())
    return
  }
  setGlobalDispatcher(new Agent())
}

/** 将当前代理应用到指定 session（webContents / net） */
export async function applyProxyToSession(
  ses: Electron.Session,
  config: ProxyConfig = current
): Promise<void> {
  const rules = buildProxyRules(config)
  await ses.setProxy(
    rules
      ? rules === 'system'
        ? { mode: 'system' }
        : { proxyRules: rules, proxyBypassRules: '<local>;localhost;127.0.0.1' }
      : { proxyRules: '', proxyBypassRules: '' }
  )
}

/**
 * 应用代理到 default + shell + 已知插件 partition。
 * 新建插件 session 时由 PluginHost 再调 applyProxyToSession 补一次。
 */
export async function applyProxy(config: ProxyConfig): Promise<ProxyConfig> {
  const next = normalizeProxy(config)
  current = next
  const rules = buildProxyRules(next)
  // 自动模式保留宿主/系统代理环境；直连恢复继承值；指定代理只接受 HTTP。
  applyEnv(next.type === 'http' ? buildProxyEnvUrl(next) : '')
  await applyNodeDispatcher(next)

  const targets: Electron.Session[] = [session.defaultSession, session.fromPartition(SHELL_PARTITION)]
  // 已安装插件 partition（含尚未创建 session 的，fromPartition 会惰性创建）
  try {
    for (const p of pluginRegistry.list()) {
      targets.push(session.fromPartition(pluginPartition(p.id)))
    }
  } catch {
    // registry 尚未 scan 完成时忽略
  }

  await Promise.all(targets.map((ses) => applyProxyToSession(ses, next)))
  logInfo('proxy', next.type === 'system' ? 'applied mode=system' : rules ? `applied rules=${rules}` : 'cleared (direct)')
  return next
}

/** 启动时从 settings 读取并应用；缺省自动识别系统代理 */
export async function applyProxyFromSettings(): Promise<void> {
  try {
    const general = settingsStore.getAll().general as { proxy?: unknown }
    const config = normalizeProxy(general.proxy)
    await applyProxy(config)
  } catch (err) {
    logWarn('proxy', `apply from settings failed: ${(err as Error).message}`)
  }
}

/**
 * 连通性测试：指定代理对 host:port 做 TCP 握手。
 * 自动模式由系统代理决定，无法单独探测；直连视为可用。
 */
export async function testProxyConnectivity(config?: ProxyConfig): Promise<ProxyTestResult> {
  const target = normalizeProxy(config ?? current)
  if (target.type === 'system') {
    return { ok: true, latencyMs: 0 }
  }
  if (target.type === 'none') {
    return { ok: true, latencyMs: 0 }
  }
  const endpoint = resolveEndpoint(target)
  if (!endpoint) {
    return { ok: false, error: 'invalid proxy address' }
  }
  const started = Date.now()
  return new Promise<ProxyTestResult>((resolve) => {
    const sock = new Socket()
    const done = (result: ProxyTestResult): void => {
      sock.destroy()
      resolve(result)
    }
    sock.setTimeout(5000)
    sock.once('connect', () => done({ ok: true, latencyMs: Date.now() - started }))
    sock.once('timeout', () => done({ ok: false, error: 'timeout (5s)' }))
    sock.once('error', (err: Error) => done({ ok: false, error: err.message }))
    try {
      sock.connect(endpoint.port, endpoint.host)
    } catch (err) {
      done({ ok: false, error: (err as Error).message })
    }
  })
}

/** 插件 partition：由 PluginHost 在 session.fromPartition 后调用 */
export async function applyProxyToPluginPartition(pluginId: string): Promise<void> {
  if (current.type === 'system') return
  try {
    await applyProxyToSession(session.fromPartition(pluginPartition(pluginId)), current)
  } catch (err) {
    logWarn('proxy', `plugin partition apply failed: ${(err as Error).message}`)
  }
}
