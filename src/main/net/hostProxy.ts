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
  if (proxy.type !== 'http' || ['localhost', '127.0.0.1', '::1'].includes(host)) return null
  return openSocketProxy({ type: 'http-connect', host: proxy.host!, port: proxy.port! }, { host, port: target.port }, '', options)
}
