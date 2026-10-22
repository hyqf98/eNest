import {
  CATALOG_IMAGE_LIMIT, CATALOG_README_LIMIT, catalogRedirectUrl, catalogResourceKey,
  catalogResourceMime, registeredCatalogUrl, validCatalogImage, type CatalogResource
} from './catalogResources'

type RemoteResource = Extract<CatalogResource, { source: 'remote' }>
export interface MarketResourceBody { body: Uint8Array<ArrayBuffer>; mime: string }
const TIMEOUT_MS = 10_000
const CACHE_BYTES = 32 * 1024 * 1024
const CACHE_ENTRIES = 64
const CACHE_TTL_MS = 5 * 60 * 1000
const MAX_PENDING = 128
const MAX_ACTIVE = 4
const MAX_REDIRECTS = 4

/** Node fetch uses proxyService's global undici dispatcher, not an Electron session or cookies. */
export class MarketResourceCache {
  private cache = new Map<string, MarketResourceBody & { expires: number }>()
  private pending = new Map<string, Promise<MarketResourceBody>>()
  private bytes = 0
  private active = 0
  private waiting: Array<() => void> = []

  constructor(private readonly fetcher: typeof fetch = (...args) => fetch(...args)) {}

  private prune(): void {
    for (const [key, value] of this.cache) {
      if (value.expires <= Date.now()) { this.cache.delete(key); this.bytes -= value.body.byteLength }
    }
    while (this.bytes > CACHE_BYTES || this.cache.size > CACHE_ENTRIES) {
      const key = this.cache.keys().next().value!
      this.bytes -= this.cache.get(key)!.body.byteLength
      this.cache.delete(key)
    }
  }

  get(resource: RemoteResource): Promise<MarketResourceBody> {
    if (!registeredCatalogUrl(resource.url, resource.pluginId, resource.version, resource.kind)) return Promise.reject(new Error('invalid catalog resource URL'))
    const key = catalogResourceKey(resource)
    this.prune()
    const cached = this.cache.get(key)
    if (cached) { this.cache.delete(key); this.cache.set(key, cached); return Promise.resolve(cached) }
    const pending = this.pending.get(key)
    if (pending) return pending
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new Error('catalog resource queue is full'))
    const task = this.load(resource).then(result => {
      this.cache.set(key, { ...result, expires: Date.now() + CACHE_TTL_MS })
      this.bytes += result.body.byteLength
      this.prune()
      return result
    }).finally(() => { this.pending.delete(key) })
    this.pending.set(key, task)
    return task
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.active < MAX_ACTIVE) { this.active++; return }
    await new Promise<void>((resolve, reject) => {
      const ready = (): void => { signal.removeEventListener('abort', abort); resolve() }
      const abort = (): void => {
        const index = this.waiting.indexOf(ready)
        if (index >= 0) this.waiting.splice(index, 1)
        reject(signal.reason)
      }
      this.waiting.push(ready)
      signal.addEventListener('abort', abort, { once: true })
    })
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next) next() // transfer the existing active slot
    else this.active--
  }

  private async load(resource: RemoteResource): Promise<MarketResourceBody> {
    const signal = AbortSignal.timeout(TIMEOUT_MS)
    await this.acquire(signal)
    let response: Response | undefined
    try {
      const initial = registeredCatalogUrl(resource.url, resource.pluginId, resource.version, resource.kind)!
      const mime = catalogResourceMime(initial.pathname, resource.kind)!
      let current = initial
      for (let hop = 0; ; hop++) {
        signal.throwIfAborted()
        response = await this.fetcher(current.href, {
          method: 'GET', redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', signal,
          headers: { Accept: resource.kind === 'image' ? mime : 'text/markdown, text/plain' }
        })
        if (![301, 302, 303, 307, 308].includes(response.status)) break
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (hop >= MAX_REDIRECTS || !location) throw new Error('invalid catalog resource redirect')
        const target = catalogRedirectUrl(new URL(location, current).href, resource)
        if (!target) throw new Error('forbidden catalog resource redirect')
        current = target
      }
      if (!response.ok || !response.body) throw new Error(`catalog resource unavailable: HTTP ${response.status}`)
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
      const allowed = resource.kind === 'readme' ? ['text/plain', 'text/markdown', 'text/x-markdown']
        : mime === 'image/svg+xml' ? [mime, 'text/plain'] // raw GitHub may label SVG as plain text; signature is still mandatory.
        : mime === 'image/x-icon' ? [mime, 'image/vnd.microsoft.icon'] : [mime]
      if (!type || !allowed.includes(type)) throw new Error('invalid catalog resource content type')
      const maximum = resource.kind === 'readme' ? CATALOG_README_LIMIT : CATALOG_IMAGE_LIMIT
      const length = response.headers.get('content-length')
      if (length && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximum)) throw new Error('catalog resource exceeds byte limit')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > maximum) throw new Error('catalog resource exceeds byte limit')
          chunks.push(value)
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      signal.throwIfAborted()
      const body = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
      if (resource.kind === 'image' && !validCatalogImage(body, mime)) throw new Error('invalid catalog image body')
      return { body, mime }
    } finally {
      // Cancel rejected/redirect bodies too; never leave a pooled proxy connection reading them.
      await response?.body?.cancel().catch(() => {})
      this.release()
    }
  }
}

const resources = new MarketResourceCache()
export function fetchMarketResource(resource: RemoteResource): Promise<MarketResourceBody> {
  return resources.get(resource)
}
