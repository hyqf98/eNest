import { app } from 'electron'

declare const __ENEST_AUTH__: { githubClientId: string; githubTokenExchangeUrl: string; githubDeviceFlow: boolean } | undefined

/** Public release configuration only. OAuth client secrets never enter the desktop build. */
export function getGithubAuthConfig() {
  const bundled = typeof __ENEST_AUTH__ === 'undefined' ? undefined : __ENEST_AUTH__
  const clientId = (process.env.ENEST_GITHUB_CLIENT_ID || bundled?.githubClientId || '').trim()
  const rawUrl = (process.env.ENEST_GITHUB_TOKEN_EXCHANGE_URL || bundled?.githubTokenExchangeUrl || '').trim()
  const deviceFlow = process.env.ENEST_GITHUB_DEVICE_FLOW === '1' || bundled?.githubDeviceFlow === true
  let exchangeUrl = ''
  if (rawUrl) {
    try {
      const url = new URL(rawUrl)
      const local = !app.isPackaged && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
      if ((url.protocol === 'https:' || local) && !url.username && !url.password && !url.hash && !url.search) exchangeUrl = url.href
    } catch { /* An invalid release endpoint is unavailable, never sent to the browser. */ }
  }
  return { clientId, exchangeUrl, deviceFlow, available: Boolean(clientId && (exchangeUrl || deviceFlow)) }
}
