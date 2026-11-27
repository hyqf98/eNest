export async function boundedResponse(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('响应为空')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    if (Number(response.headers.get('content-length')) > limit) throw new Error('响应超过大小限制')
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > limit) throw new Error('响应超过大小限制')
      chunks.push(part.value)
    }
    return Buffer.concat(chunks, length)
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
