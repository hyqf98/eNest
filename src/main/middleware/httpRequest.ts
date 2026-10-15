/** UtilityProcess 内 HTTP 客户端：node:http/https 直连（内网 http/自签 https 均可达），
 * 供 RabbitMQ Management / RocketMQ dashboard / EMQX 管理面适配器共用。
 * 与 enest.net.fetch（面向插件、仅 HTTPS）无关。 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_REDIRECTS = 5

export interface MwHttpOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  basicAuth?: { username: string; password: string }
  bearerToken?: string
  cookie?: string
  /** 内网自签证书（rmq mgmt TLS / dashboard）常见，默认关 */
  insecureTls?: boolean
}

export interface MwHttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

function once(
  url: URL,
  opts: MwHttpOptions,
  redirectsLeft: number
): Promise<MwHttpResponse> {
  const isHttps = url.protocol === 'https:'
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { accept: 'application/json', ...(opts.headers ?? {}) }
    if (opts.body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json'
    if (opts.basicAuth) headers.authorization = 'Basic ' + Buffer.from(`${opts.basicAuth.username}:${opts.basicAuth.password}`).toString('base64')
    else if (opts.bearerToken) headers.authorization = `Bearer ${opts.bearerToken}`
    if (opts.cookie) headers.cookie = opts.cookie
    const req = (isHttps ? httpsRequest : httpRequest)(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: opts.method ?? 'GET',
        headers,
        ...(isHttps ? { rejectUnauthorized: opts.insecureTls === true ? false : true } : {})
      },
      res => {
        const status = res.statusCode ?? 0
        const location = res.headers.location
        if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
          res.resume()
          const next = new URL(location, url)
          if (next.protocol !== 'http:' && next.protocol !== 'https:') return reject(new Error(`unsupported redirect: ${next.protocol}`))
          // 管理端点由连接配置明确指定。禁止跨源/HTTPS 降级跳转，避免认证头、
          // Cookie 及表单密码等 body 被发送到用户未选择的服务器。
          if (next.origin !== url.origin) return reject(new Error('middleware redirect must stay on the configured origin (HTTPS downgrade is not allowed)'))
          resolve(once(next, { ...opts, body: opts.method === 'GET' ? undefined : opts.body }, redirectsLeft - 1))
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_BODY_BYTES) {
            req.destroy(new Error('middleware http response exceeds 8 MiB'))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => resolve({
          status,
          headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')])),
          body: Buffer.concat(chunks).toString('utf8')
        }))
      }
    )
    req.setTimeout(opts.timeoutMs ?? 15000, () => req.destroy(new Error(`middleware http timeout after ${opts.timeoutMs ?? 15000}ms`)))
    req.on('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

export function mwHttp(url: string, opts: MwHttpOptions = {}): Promise<MwHttpResponse> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return Promise.reject(new Error('only http/https middleware endpoints are supported'))
  return once(parsed, opts, MAX_REDIRECTS)
}

/** JSON 请求：非 2xx 抛错并携带响应片段；200/201/204 均视为成功 */
export async function mwHttpJson<T = unknown>(url: string, opts: MwHttpOptions = {}): Promise<T> {
  const res = await mwHttp(url, opts)
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status} ${url}: ${res.body.slice(0, 300)}`)
  }
  if (!res.body || res.status === 204) return undefined as T
  try {
    return JSON.parse(res.body) as T
  } catch {
    throw new Error(`invalid JSON from ${url}: ${res.body.slice(0, 200)}`)
  }
}
