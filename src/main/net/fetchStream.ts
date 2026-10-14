/** Bounded stream decoding shared by fetch and SSE. Never retain an unbounded line. */
export const FETCH_STREAM_MAX_BYTES = 32 * 1024 * 1024
export const SSE_LINE_MAX_BYTES = 2 * 1024 * 1024
export async function consumeFetchStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  sse: boolean,
  emit: (chunk: string) => void
): Promise<void> {
  let bytes = 0, events = 0, pending = ''
  const decoder = new TextDecoder()
  const publish = (chunk: string): void => {
    if (++events > 65536) throw new Error('response event budget exceeded')
    emit(chunk)
  }
  const line = (value: string): void => {
    if (Buffer.byteLength(value) > SSE_LINE_MAX_BYTES) throw new Error('SSE line too large')
    if (value.startsWith('data:')) publish(value.slice(5).replace(/^ /, '').replace(/\r$/, ''))
  }
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      bytes += result.value.byteLength
      if (bytes > FETCH_STREAM_MAX_BYTES) throw new Error('response body too large')
      if (!sse) { publish(Buffer.from(result.value).toString('base64')); continue }
      pending += decoder.decode(result.value, { stream: true })
      let boundary: number
      while ((boundary = pending.indexOf('\n')) >= 0) { line(pending.slice(0, boundary)); pending = pending.slice(boundary + 1) }
      if (Buffer.byteLength(pending) > SSE_LINE_MAX_BYTES) throw new Error('SSE line too large')
    }
    if (sse) { pending += decoder.decode(); if (pending) line(pending) }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
}
