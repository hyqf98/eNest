/** Publisher-side example. Run behind HTTPS; never distribute the secret with eNest. */
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

export function createGithubExchangeServer({ clientId, clientSecret, fetchImpl = fetch }) {
  if (!clientId || !clientSecret) throw new Error('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required on the server')
  const requests = new Map()
  return createServer(async (request, response) => {
    const reply = (status, body) => {
      if (response.destroyed || response.writableEnded) return
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      response.end(JSON.stringify(body))
    }
    if (request.method !== 'POST' || request.url !== '/oauth/github/exchange') { reply(404, { error: 'not_found' }); return }
    if (!request.headers['content-type']?.startsWith('application/json')) { reply(415, { error: 'json_required' }); return }
    const now = Date.now(), ip = request.socket.remoteAddress
    for (const [key, entry] of requests) if (entry.expires < now) requests.delete(key)
    const rate = requests.get(ip) || { count: 0, expires: now + 60_000 }
    if (++rate.count > 30 || requests.size > 10_000) { reply(429, { error: 'try_later' }); return }
    requests.set(ip, rate)
    try {
      let bytes = 0
      const chunks = []
      for await (const chunk of request) {
        bytes += chunk.length
        if (bytes > 4096) { reply(413, { error: 'too_large' }); return }
        chunks.push(chunk)
      }
      const { code, code_verifier, redirect_uri } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(code) || typeof code_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(code_verifier)) { reply(400, { error: 'invalid_request' }); return }
      const callback = new URL(redirect_uri)
      if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || callback.pathname !== '/callback' || !callback.port || callback.username || callback.password || callback.search || callback.hash) { reply(400, { error: 'invalid_redirect' }); return }
      const upstream = await fetchImpl('https://github.com/login/oauth/access_token', {
        method: 'POST', signal: AbortSignal.timeout(15_000), redirect: 'error',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, code_verifier, redirect_uri }),
      })
      if (!upstream.ok) { reply(502, { error: 'provider_unavailable' }); return }
      const data = await upstream.json()
      if (typeof data.access_token !== 'string' || !data.access_token) { reply(400, { error: 'authorization_failed' }); return }
      reply(200, { access_token: data.access_token })
    } catch { reply(400, { error: 'authorization_failed' }) }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createGithubExchangeServer({ clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET })
  server.requestTimeout = 20_000
  server.headersTimeout = 10_000
  server.listen(Number(process.env.PORT || 8787), '127.0.0.1', () => console.log('GitHub exchange listening on loopback; expose through HTTPS reverse proxy'))
}
