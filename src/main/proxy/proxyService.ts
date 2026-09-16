/**
 * proxyService — 应用级网络代理
 * 职责：解析/校验代理配置，经 session.setProxy 即时作用于 webContents 与
 * electron net（electron-updater 默认走 defaultSession），并提供连通性测试。
 * 被 index.ts 启动时应用、shellHandlers 读写、PluginHost 新建 session 时注入。
 * 关键依赖：electron session/net、settingsStore、logService。
 */
import { Socket } from 'node:net'
import { session } from 'electron'
import { SHELL_PARTITION, pluginPartition } from '@shared/constants'
import type { ProxyConfig, ProxyType } from '@shared/types/plugin'
import { logInfo, logWarn } from '@main/logs/logService'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { settingsStore } from '@main/settings/SettingsStore'

/** 空配置 = 直连 */
export const DEFAULT_PROXY: ProxyConfig = { type: 'none' }

export type ProxyTestResult = {
  ok: boolean
  latencyMs?: number
  error?: string
}

const PROXY_TYPES: ProxyType[] = ['none', 'http', 'socks5', 'custom']

/** 归一化任意入参为合法 ProxyConfig；非法回落直连 */
export function normalizeProxy(raw: unknown): ProxyConfig {
  const r = (raw ?? {}) as Partial<ProxyConfig> & { type?: string }
  const type = (PROXY_TYPES as string[]).includes(r.type ?? '') ? (r.type as ProxyType) : 'none'
  if (type === 'none') return { type: 'none' }
  const host = typeof r.host === 'string' ? r.host.trim() : ''
  const port = Number(r.port)
  const url = typeof r.url === 'string' ? r.url.trim() : ''
  if (type === 'custom') {
    return url ? { type, url } : { type: 'none' }
  }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { type: 'none' }
  }
  return { type, host, port }
}

/** 将配置序列化为 Chromium proxyRules 字符串；直连返回空串 */
export function buildProxyRules(config: ProxyConfig): string {
  const c = normalizeProxy(config)
  if (c.type === 'none') return ''
  if (c.type === 'http') return `http://${c.host}:${c.port};https://${c.host}:${c.port}`
  if (c.type === 'socks5') return `socks5://${c.host}:${c.port}`
  // custom：用户填完整 URL（http:// / https:// / socks5:// / socks://）
  return c.url ?? ''
}

/** 从配置中解析可 TCP 探测的 host:port（custom 支持 scheme://[user:pass@]host:port） */
function resolveEndpoint(config: ProxyConfig): { host: string; port: number } | null {
  const c = normalizeProxy(config)
  if (c.type === 'http' || c.type === 'socks5') {
    return { host: c.host!, port: c.port! }
  }
  if (c.type === 'custom' && c.url) {
    try {
      const u = new URL(c.url)
      const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : u.protocol.startsWith('socks') ? 1080 : 80
      if (!u.hostname || !Number.isInteger(port)) return null
      return { host: u.hostname, port }
    } catch {
      // 允许裸 host:port
      const m = c.url.match(/^([^:/]+):(\d{1,5})$/)
      if (m) return { host: m[1], port: Number(m[2]) }
      return null
    }
  }
  return null
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

function applyEnv(rules: string): void {
  if (!envSnapshot) {
    envSnapshot = {
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      ALL_PROXY: process.env.ALL_PROXY,
      NO_PROXY: process.env.NO_PROXY
    }
  }
  if (!rules) {
    restoreEnv()
    return
  }
  // Node 侧 undici / electron-updater 部分路径会读环境变量
  process.env.HTTP_PROXY = rules
  process.env.HTTPS_PROXY = rules
  process.env.ALL_PROXY = rules
  process.env.NO_PROXY = process.env.NO_PROXY ?? 'localhost,127.0.0.1'
}

/** 将当前代理应用到指定 session（webContents / net） */
export async function applyProxyToSession(
  ses: Electron.Session,
  config: ProxyConfig = current
): Promise<void> {
  const rules = buildProxyRules(config)
  await ses.setProxy(
    rules
      ? { proxyRules: rules, proxyBypassRules: '<local>;localhost;127.0.0.1' }
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
  applyEnv(rules)

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
  logInfo('proxy', rules ? `applied rules=${rules}` : 'cleared (direct)')
  return next
}

/** 启动时从 settings 读取并应用；无配置则保持直连 */
export async function applyProxyFromSettings(): Promise<void> {
  try {
    const general = settingsStore.getAll().general as { proxy?: unknown }
    const config = normalizeProxy(general.proxy)
    if (config.type === 'none') {
      current = DEFAULT_PROXY
      return
    }
    await applyProxy(config)
  } catch (err) {
    logWarn('proxy', `apply from settings failed: ${(err as Error).message}`)
  }
}

/**
 * 连通性测试：对代理 host:port 做 TCP 握手（HTTP/SOCKS5/自定义均可）。
 * 未配置代理时返回 ok=true（直连视为可用）。
 */
export async function testProxyConnectivity(config?: ProxyConfig): Promise<ProxyTestResult> {
  const target = normalizeProxy(config ?? current)
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
  if (current.type === 'none') return
  try {
    await applyProxyToSession(session.fromPartition(pluginPartition(pluginId)), current)
  } catch (err) {
    logWarn('proxy', `plugin partition apply failed: ${(err as Error).message}`)
  }
}
