import { net } from 'electron'
import { setTimeout as delay } from 'node:timers/promises'
import { boundedResponse } from '@main/net/boundedResponse'

interface GithubRequestOptions {
  timeoutMs: number
  limit: number
  graphQuery?: boolean
  grantErrorBody?: boolean
  check?: () => void
}

const MAX_RETRIES = 2
const MAX_WAIT_MS = 5000

function retryDelay(response: Response, backoff: number): number | null {
  const remaining = response.headers.get('x-ratelimit-remaining')
  const retryAfter = response.headers.get('retry-after')
  const limited = response.status === 429 || response.status === 403 && (remaining === '0' || retryAfter !== null)
  if (!limited && ![408, 500, 502, 503, 504].includes(response.status)) return null
  let wait = backoff
  if (retryAfter !== null) {
    const requested = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()
    wait = Math.max(wait, requested)
  }
  if (remaining === '0') {
    const reset = response.headers.get('x-ratelimit-reset')
    if (reset === null && retryAfter === null) return null
    if (reset !== null) wait = Math.max(wait, Number(reset) * 1000 - Date.now())
  } else if (limited && retryAfter === null) return null
  return Number.isFinite(wait) && wait <= MAX_WAIT_MS ? wait : null
}

function transientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'TimeoutError' || error instanceof TypeError && /^(fetch failed|failed to fetch|terminated)$/i.test(error.message)) return true
  return /\b(?:ERR_(?:NETWORK_CHANGED|TIMED_OUT|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|(?:PROXY_|TUNNEL_)?CONNECTION_(?:CLOSED|RESET|REFUSED|ABORTED|FAILED|TIMED_OUT))|ECONNRESET|ETIMEDOUT)\b/i.test(error.message)
}

export async function githubRequest(url: string, init: RequestInit, options: GithubRequestOptions) {
  const readOnly = (init.method ?? 'GET') === 'GET' || options.graphQuery === true
  for (let attempt = 0; ; attempt++) {
    init.signal?.throwIfAborted()
    options.check?.()
    const timeout = AbortSignal.timeout(options.timeoutMs)
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    const retry = readOnly && attempt < MAX_RETRIES
    let wait = 400 * 2 ** attempt
    try {
      const response = await net.fetch(url, { ...init, credentials: 'omit', redirect: 'error', signal })
      const next = retry && !response.ok ? retryDelay(response, wait) : null
      if (next === null) {
        const readError = options.grantErrorBody && response.status === 400
        const bytes = response.ok || readError ? await boundedResponse(response, readError ? 4096 : options.limit) : Buffer.alloc(0)
        if (!response.ok && !readError) await response.body?.cancel().catch(() => {})
        signal.throwIfAborted()
        return { ok: response.ok, status: response.status, headers: response.headers, bytes }
      }
      await response.body?.cancel().catch(() => {})
      wait = next
    } catch (error) {
      init.signal?.throwIfAborted()
      if (!retry || !timeout.aborted && !transientNetworkError(error)) throw error
    }
    await delay(wait, undefined, { signal: init.signal ?? undefined })
  }
}
