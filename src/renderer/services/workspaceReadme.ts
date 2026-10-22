const MAX_README_BYTES = 1024 * 1024

/** Read only the current catalog item's public manifest slot, never a remote URL or raw path. */
export async function loadWorkspaceReadme(pluginId: string, url: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(pluginId) || url !== `enest-home://catalog/${encodeURIComponent(pluginId)}/readme`) {
    throw new Error('Unsupported Workspace README resource')
  }
  const response = await fetcher(url, { method: 'GET', credentials: 'omit', redirect: 'error', signal })
  if (!response.ok || response.url && response.url !== url) throw new Error('Workspace README is unavailable')
  const length = response.headers.get('content-length')
  if (length && Number(length) > MAX_README_BYTES) throw new Error('Workspace README is too large')
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_README_BYTES) {
        await reader.cancel()
        throw new Error('Workspace README is too large')
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join('').trim()
  } finally {
    reader.releaseLock()
  }
}
