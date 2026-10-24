import { ClipboardItem, clipboard, nativeImage } from 'electron'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { readNativeFiles, writeNativeFiles, nativeClipboardSource, isNativeClipboardBusy } from './nativeClipboard'
import { logWarn } from '@main/logs/logService'
import type { ClipboardNativeSnapshot } from '@shared/types/pluginBackground'

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_TEXT_BYTES = 8 * 1024 * 1024
const MAX_PIXELS = 16 * 1024 * 1024
const POLL_MS = 500
const MAX_CONSUMERS = 64
const MAX_DELIVERY_ITEMS = 8
const MAX_DELIVERY_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_DELIVERY_BYTES = 64 * 1024 * 1024
const MAX_DELIVERY_ATTEMPTS = 3
const MAX_WRITE_ITEMS = 16
const MAX_WRITE_BYTES = 64 * 1024 * 1024
const MAX_FILE_PATH_BYTES = 8 * 1024 * 1024
type Consumer = { current(): boolean; publish(snapshot: ClipboardNativeSnapshot): Promise<void> | void }
interface DeliveryItem { snapshot: ClipboardNativeSnapshot; bytes: number; attempts: number; retryAt: number }
interface Delivery {
  consumer: Consumer
  active: boolean
  waiting: DeliveryItem[]
  flight?: DeliveryItem
  bytes: number
  dropped: number
  lastWarningAt: number
}
const consumers = new Map<Consumer, Delivery>()
let deliveryBytes = 0
let timer: NodeJS.Timeout | null = null, polling = false, generation = 0, revision = 0
let previousFingerprint: string | null = null, writeRevision = 0, pendingWrites = 0
interface WriteReservation { bytes: number; released: boolean }
interface ClipboardWrite {
  operation?: () => Promise<void>
  hash: string
  reservation: WriteReservation
  signal?: AbortSignal
  resolve(): void
  reject(error: unknown): void
  detach(): void
}
const writes: ClipboardWrite[] = []
let writing: ClipboardWrite | undefined, writeBytes = 0

const fingerprint = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

function currentDelivery(delivery: Delivery): boolean {
  try { return delivery.active && consumers.get(delivery.consumer) === delivery && delivery.consumer.current() }
  catch { return false }
}
function releaseDelivery(delivery: Delivery, item: DeliveryItem): void {
  delivery.bytes -= item.bytes
  deliveryBytes -= item.bytes
}
function retireDelivery(delivery: Delivery): void {
  delivery.active = false
  if (consumers.get(delivery.consumer) === delivery) consumers.delete(delivery.consumer)
  for (const item of delivery.waiting.splice(0)) releaseDelivery(delivery, item)
  // An already-dispatched consumer may still retain its argument. Keep that reservation until ACK.
}
function droppedDelivery(delivery: Delivery, reason: 'queue-limit' | 'global-limit' | 'delivery-failed'): void {
  delivery.dropped++
  if (Date.now() - delivery.lastWarningAt < 60_000) return
  logWarn('clipboard-native', `delivery dropped reason=${reason} count=${delivery.dropped}`)
  delivery.lastWarningAt = Date.now()
  delivery.dropped = 0
}
function pumpDelivery(delivery: Delivery): void {
  if (!currentDelivery(delivery)) { retireDelivery(delivery); return }
  if (delivery.flight || !delivery.waiting.length || delivery.waiting[0].retryAt > Date.now()) return
  const item = delivery.waiting.shift()!
  delivery.flight = item
  item.attempts++
  const settled = (failed: boolean): void => {
    delivery.flight = undefined
    if (failed && currentDelivery(delivery) && item.attempts < MAX_DELIVERY_ATTEMPTS) {
      item.retryAt = Date.now() + POLL_MS
      delivery.waiting.unshift(item)
    } else {
      releaseDelivery(delivery, item)
      if (failed && currentDelivery(delivery)) droppedDelivery(delivery, 'delivery-failed')
    }
    pumpDelivery(delivery)
  }
  try { void Promise.resolve(delivery.consumer.publish(item.snapshot)).then(() => settled(false), () => settled(true)) }
  catch { settled(true) }
}
function snapshotBytes(snapshot: ClipboardNativeSnapshot): number {
  const bytes = (value?: string): number => value ? Buffer.byteLength(value) : 0
  return 256 + bytes(snapshot.text) + bytes(snapshot.dataUrl) + bytes(snapshot.sourceApp?.name) + bytes(snapshot.sourceApp?.id)
    + (snapshot.files?.reduce((sum, file) => sum + 64 + bytes(file.path) + bytes(file.name), 0) ?? 0)
}
function enqueueSnapshot(snapshot: ClipboardNativeSnapshot): void {
  const bytes = snapshotBytes(snapshot)
  for (const delivery of [...consumers.values()]) {
    if (!currentDelivery(delivery)) { retireDelivery(delivery); continue }
    if (bytes > MAX_DELIVERY_BYTES) { droppedDelivery(delivery, 'queue-limit'); continue }
    // Drop the oldest not-yet-dispatched event first; never overlap or cancel a consumer's in-flight call.
    while (delivery.waiting.length && (delivery.waiting.length + Number(!!delivery.flight) >= MAX_DELIVERY_ITEMS || delivery.bytes + bytes > MAX_DELIVERY_BYTES)) {
      releaseDelivery(delivery, delivery.waiting.shift()!)
      droppedDelivery(delivery, 'queue-limit')
    }
    if (delivery.bytes + bytes > MAX_DELIVERY_BYTES) { droppedDelivery(delivery, 'queue-limit'); continue }
    if (deliveryBytes + bytes > MAX_TOTAL_DELIVERY_BYTES) { droppedDelivery(delivery, 'global-limit'); continue }
    delivery.bytes += bytes
    deliveryBytes += bytes
    delivery.waiting.push({ snapshot, bytes, attempts: 0, retryAt: 0 })
    pumpDelivery(delivery)
  }
}

/** One OS observer shared by authorized consumers; it owns no history, filters, settings, or persistence. */
export function subscribeClipboardChanges(consumer: Consumer): () => void {
  if (consumers.has(consumer)) throw new Error('Clipboard consumer is already registered')
  if (consumers.size >= MAX_CONSUMERS) throw new Error('Clipboard consumer limit reached')
  const delivery: Delivery = { consumer, active: true, waiting: [], bytes: 0, dropped: 0, lastWarningAt: -Infinity }
  consumers.set(consumer, delivery)
  if (!timer) {
    generation++
    previousFingerprint = null
    timer = setInterval(() => { void pollClipboardChanges().catch(() => {}) }, POLL_MS)
    timer.unref()
    void pollClipboardChanges().catch(() => {})
  }
  return () => {
    retireDelivery(delivery)
    if (!consumers.size) stopClipboardChanges()
  }
}

export function stopClipboardChanges(): void {
  generation++
  if (timer) clearInterval(timer)
  timer = null
  for (const delivery of [...consumers.values()]) retireDelivery(delivery)
  previousFingerprint = null
}

/** Exposed for deterministic fixture checks, not a renderer API. */
export async function pollClipboardChanges(): Promise<void> {
  for (const delivery of [...consumers.values()]) pumpDelivery(delivery)
  if (!consumers.size) { if (timer) stopClipboardChanges(); return }
  if (polling || pendingWrites || isNativeClipboardBusy() || !consumers.size) return
  polling = true
  const epoch = generation, writeEpoch = writeRevision
  const current = (): boolean => epoch === generation && writeEpoch === writeRevision && pendingWrites === 0 && consumers.size > 0
  try {
    let value: Omit<ClipboardNativeSnapshot, 'revision' | 'capturedAt'> | null = null, hash = ''
    const files = await readNativeFiles()
    if (!current()) return
    if (files.length) {
      if (files.length > 10000) return
      value = { type: 'files', files: files.map(path => ({ path, name: basename(path) })) }
      hash = `files:${fingerprint(JSON.stringify(files))}`
    } else {
      let image: Buffer | null = null, imageType = ''
      try {
        for (const item of await clipboard.read()) {
          const type = item.types.find(type => type.startsWith('image/'))
          if (!type) continue
          const blob = await item.getType(type) as Blob
          if (blob.size > MAX_IMAGE_BYTES) return
          image = Buffer.from(await blob.arrayBuffer())
          imageType = type
          break
        }
      } catch { /* Clipboard formats may change while the OS read is pending. */ }
      if (!current()) return
      if (image) {
        hash = `image:${fingerprint(image)}`
        if (hash === previousFingerprint) return
        const native = nativeImage.createFromBuffer(image)
        if (native.isEmpty()) return
        const { width, height } = native.getSize()
        if (width * height > MAX_PIXELS) return
        const png = imageType === 'image/png' ? image : native.toPNG()
        if (png.length > MAX_IMAGE_BYTES) return
        value = { type: 'image', dataUrl: `data:image/png;base64,${png.toString('base64')}`, width, height }
      } else {
        const text = await clipboard.readText()
        if (!current()) return
        if (Buffer.byteLength(text) > MAX_TEXT_BYTES) return
        hash = `text:${fingerprint(text)}`
        if (text) value = { type: 'text', text }
      }
    }
    if (!current() || hash === previousFingerprint) return
    const baseline = previousFingerprint === null
    // A fresh observer aligns with the current clipboard instead of importing content from its disabled period.
    if (baseline || !value) { previousFingerprint = hash; return }
    const sourceApp = await nativeClipboardSource()
    if (!current()) return
    const snapshot: ClipboardNativeSnapshot = { ...value, revision: ++revision, capturedAt: Date.now(), ...(sourceApp ? { sourceApp } : {}) }
    enqueueSnapshot(snapshot)
    if (current()) previousFingerprint = hash
  } finally { polling = false }
}

function reserveWrite(bytes: number, signal?: AbortSignal): WriteReservation {
  signal?.throwIfAborted()
  if (pendingWrites >= MAX_WRITE_ITEMS || writeBytes + bytes > MAX_WRITE_BYTES) throw new Error('Clipboard write queue limit reached')
  pendingWrites++
  writeBytes += bytes
  writeRevision++
  return { bytes, released: false }
}
function releaseWrite(reservation: WriteReservation): void {
  if (reservation.released) return
  reservation.released = true
  pendingWrites--
  writeBytes -= reservation.bytes
  writeRevision++
}
function pumpWrites(): void {
  if (writing || !writes.length) return
  const job = writes.shift()!, operation = job.operation!
  job.operation = undefined
  writing = job
  void Promise.resolve().then(async () => {
    job.signal?.throwIfAborted()
    await operation()
    // A native write can succeed after cancellation; it is still our own clipboard change.
    previousFingerprint = job.hash
    job.resolve()
  }).catch(error => job.reject(error)).finally(() => {
    job.detach()
    releaseWrite(job.reservation)
    writing = undefined
    pumpWrites()
  })
}
/** Reservations precede conversion. Cancelling a queued write releases its payload without waiting for another consumer. */
function writeClipboard(operation: (() => Promise<void>) | undefined, hash: string, reservation: WriteReservation, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const job: ClipboardWrite = { operation, hash, reservation, signal, resolve, reject, detach: () => {} }
    operation = undefined
    const cancel = (): void => {
      if (writing !== job) {
        const index = writes.indexOf(job)
        if (index >= 0) writes.splice(index, 1)
        job.operation = undefined
        job.detach()
        releaseWrite(reservation)
      }
      // Keep an in-flight native operation reserved until it really settles; do not overlap another write.
      reject(signal?.reason ?? new Error('Clipboard write cancelled'))
    }
    job.detach = () => signal?.removeEventListener('abort', cancel)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) { cancel(); return }
    writes.push(job)
    pumpWrites()
  })
}

export function writeClipboardText(text: string, _options: { excludeFromHistory?: boolean } = {}, signal?: AbortSignal): Promise<void> {
  let reservation: WriteReservation | undefined
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new Error('Clipboard text exceeds 8 MiB')
    reservation = reserveWrite(Buffer.byteLength(text), signal)
    return writeClipboard(() => clipboard.writeText(text), `text:${fingerprint(text)}`, reservation, signal)
  } catch (error) { if (reservation) releaseWrite(reservation); return Promise.reject(error) }
}

export function writeClipboardImage(dataUrl: string, signal?: AbortSignal): Promise<void> {
  let reservation: WriteReservation | undefined
  try {
    if (typeof dataUrl !== 'string' || dataUrl.length > 12 * 1024 * 1024) throw new Error('Clipboard image exceeds 8 MiB')
    reservation = reserveWrite(Buffer.byteLength(dataUrl) + MAX_IMAGE_BYTES, signal)
    const image = nativeImage.createFromDataURL(dataUrl)
    if (image.isEmpty()) throw new Error('Invalid clipboard image')
    const { width, height } = image.getSize()
    if (width * height > MAX_PIXELS) throw new Error('Clipboard image dimensions exceed limit')
    const png = image.toPNG()
    if (png.length > MAX_IMAGE_BYTES) throw new Error('Clipboard image exceeds 8 MiB')
    writeBytes -= reservation.bytes - png.length
    reservation.bytes = png.length
    return writeClipboard(() => clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]), `image:${fingerprint(png)}`, reservation, signal)
  } catch (error) { if (reservation) releaseWrite(reservation); return Promise.reject(error) }
}

export function writeClipboardFiles(paths: string[], signal?: AbortSignal): Promise<void> {
  let reservation: WriteReservation | undefined
  try {
    if (!Array.isArray(paths) || !paths.length || paths.length > 10000) throw new Error('Invalid clipboard file paths')
    let bytes = 0
    for (const path of paths) {
      if (typeof path !== 'string' || !path || path.includes('\0')) throw new Error('Invalid clipboard file paths')
      bytes += Buffer.byteLength(path) + 16
      if (bytes > MAX_FILE_PATH_BYTES) throw new Error('Clipboard file paths exceed 8 MiB')
    }
    reservation = reserveWrite(bytes, signal)
    return writeClipboard(() => writeNativeFiles(paths, signal), `files:${fingerprint(JSON.stringify(paths))}`, reservation, signal)
  } catch (error) { if (reservation) releaseWrite(reservation); return Promise.reject(error) }
}
