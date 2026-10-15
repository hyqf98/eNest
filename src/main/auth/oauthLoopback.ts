import { createServer, type ServerResponse } from 'node:http'

/** One-use local callback. Invalid requests never consume the outstanding login. */
export async function listenOAuthLoopback(expectedState: string) {
  let resolveResult!: (value: { code?: string; error?: string }) => void
  const result = new Promise<{ code?: string; error?: string }>(resolve => { resolveResult = resolve })
  let consumed = false
  let response: ServerResponse | null = null
  const page = (res: ServerResponse, ok: boolean, status = 200) => {
    if (res.writableEnded || res.destroyed) return
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    })
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>eNest · 登录</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#10151c;color:#edf2f7;font:16px/1.8 system-ui"><main style="text-align:center;padding:32px"><div style="font-size:22px;letter-spacing:4px;color:#89d5e8">eNest</div><h1 style="font-size:28px">${ok ? '已登录，可以回到 eNest 了' : '未能完成登录'}</h1><p style="color:#9cabbc">${ok ? '此页面可以关闭。' : '请返回 eNest 查看提示并重新发起登录。'}</p></main></body></html>`)
  }
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || (req.url?.length ?? 0) > 4096) { res.writeHead(405).end(); return }
    let url: URL
    try { url = new URL(req.url || '/', 'http://127.0.0.1') } catch { res.writeHead(400).end(); return }
    if (url.pathname !== '/callback') { res.writeHead(404).end(); return }
    if (url.searchParams.get('state') !== expectedState) { page(res, false, 400); return }
    if (consumed) { res.writeHead(409).end(); return }
    const code = url.searchParams.get('code')
    const denied = url.searchParams.has('error')
    if (!code && !denied) { page(res, false, 400); return }
    consumed = true
    response = res
    // Wait for token exchange and profile persistence before telling the browser it succeeded.
    resolveResult(denied ? { error: '已取消 GitHub 授权，请重新登录' } : { code: code! })
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  // Errors after listen are handled as a failed login, never an unhandled process event.
  server.on('error', () => resolveResult({ error: '本地回调连接失败' }))
  const address = server.address()
  if (!address || typeof address === 'string') { server.close(); throw new Error('无法分配登录回调端口') }
  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`, result,
    complete(ok: boolean) { if (response) page(response, ok) },
    close() {
      resolveResult({ error: '登录已取消' })
      if (response && !response.writableEnded) page(response, false)
      server.close()
      server.closeIdleConnections()
    },
  }
}
