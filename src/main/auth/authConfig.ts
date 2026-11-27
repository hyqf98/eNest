import { app } from 'electron'
import { clientId as officialClientId, slug as officialSlug } from './officialGithubApp.json'

declare const __ENEST_AUTH__: { githubClientId: string; githubTokenExchangeUrl: string; githubDeviceFlow: boolean; githubAppSlug?: string } | undefined

/** Public release configuration only. OAuth client secrets never enter the desktop build. */
export function getGithubAuthConfig() {
  const bundled = typeof __ENEST_AUTH__ === 'undefined' ? undefined : __ENEST_AUTH__
  const clientId = (process.env.ENEST_GITHUB_CLIENT_ID || bundled?.githubClientId || '').trim()
  const sameApp = clientId === bundled?.githubClientId
  const official = clientId === officialClientId
  const rawUrl = official ? '' : (process.env.ENEST_GITHUB_TOKEN_EXCHANGE_URL || (sameApp && bundled?.githubTokenExchangeUrl) || '').trim()
  const slug = official ? officialSlug : (process.env.ENEST_GITHUB_APP_SLUG || (sameApp && bundled?.githubAppSlug) || '').trim()
  const hasSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
  const deviceOverride = process.env.ENEST_GITHUB_DEVICE_FLOW?.trim()
  const deviceFlow = official || (deviceOverride ? deviceOverride === '1' : sameApp && bundled?.githubDeviceFlow === true || !rawUrl && hasSlug)
  const installationUrl = hasSlug ? `https://github.com/apps/${slug}/installations/new` : 'https://github.com/settings/installations'
  let exchangeUrl = ''
  if (rawUrl) {
    try {
      const url = new URL(rawUrl)
      const local = !app.isPackaged && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
      if ((url.protocol === 'https:' || local) && !url.username && !url.password && !url.hash && !url.search) exchangeUrl = url.href
    } catch { /* An invalid release endpoint is unavailable, never sent to the browser. */ }
  }
  const availabilityError = !clientId
    ? '此版本尚未配置 GitHub 登录应用，请联系发布方完成登录配置。'
    : !exchangeUrl && !deviceFlow
      ? rawUrl
        ? '此版本的 GitHub 登录服务地址无效，请联系发布方修复登录配置。'
        : '此版本尚未配置 GitHub 授权服务，请联系发布方完成登录配置。'
      : undefined
  return { clientId, exchangeUrl, deviceFlow, installationUrl, available: !availabilityError, availabilityError }
}
