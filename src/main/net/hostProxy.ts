import type { Socket } from 'node:net'
import { getActiveProxy } from '@main/proxy/proxyService'
import { openSocketProxy } from './socketProxy'

/** Outbound host sockets follow shell proxy settings; unsupported rules never fall back to direct. */
export async function openHostProxy(
  target: { host: string; port: number },
  options: { signal: AbortSignal; timeoutMs: number; ownSocket: (socket: Socket) => void }
): Promise<Socket | null> {
  const proxy = getActiveProxy()
  const host = target.host.replace(/^\[|\]$/g, '')
  if (proxy.type === 'none' || ['localhost', '127.0.0.1', '::1'].includes(host)) return null
  const endpoint = proxy.type === 'custom' ? new URL(proxy.url!) : new URL(`${proxy.type}://${proxy.host?.includes(':') ? `[${proxy.host}]` : proxy.host}:${proxy.port}`)
  if (!['http:', 'socks:', 'socks5:'].includes(endpoint.protocol)) throw new Error('Host sockets support HTTP CONNECT or SOCKS5; this proxy scheme is unsupported')
  return openSocketProxy({ type: endpoint.protocol === 'http:' ? 'http-connect' : 'socks5', host: endpoint.hostname, port: Number(endpoint.port) || (endpoint.protocol === 'http:' ? 80 : 1080), username: decodeURIComponent(endpoint.username) }, { host, port: target.port }, decodeURIComponent(endpoint.password), options)
}
