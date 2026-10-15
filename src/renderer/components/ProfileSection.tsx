import { useCallback, useEffect, useRef, useState } from 'react'
import { shellApi } from '@renderer/services/shellApi'
import { useI18n } from '@renderer/hooks/useI18n'
import type { AccountState } from '@shared/types/account'
import { notify } from '@renderer/services/notifyService'
import enestMark from '@renderer/assets/enest-mark.png'
import '@renderer/styles/account.css'

function ProviderIcon({ id }: { id: string }) {
  return id === 'github' ? <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M12 .8a11.4 11.4 0 0 0-3.6 22.2c.6.1.8-.2.8-.5v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.6-1.3-1.6-1.1-.7.1-.7.1-.7 1.1.1 1.7 1.2 1.7 1.2 1 1.7 2.6 1.2 3.3.9.1-.7.4-1.2.7-1.5-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.1 1.2a10.7 10.7 0 0 1 5.7 0c2.2-1.5 3.1-1.2 3.1-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.1v3.1c0 .3.2.7.8.5A11.4 11.4 0 0 0 12 .8Z" /></svg> : <span aria-hidden="true">↗</span>
}

/** Provider configuration lives in the host. This page only selects and observes login. */
export function ProfileSection() {
  const { t, locale } = useI18n()
  const [account, setAccount] = useState<AccountState | null>(null)
  const [busy, setBusy] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const mounted = useRef(false)
  const refreshId = useRef(0)
  const refresh = useCallback(async () => {
    const request = ++refreshId.current
    try {
      const state = await shellApi.getAccountState()
      if (mounted.current && request === refreshId.current) setAccount(state)
    } catch (error) {
      if (mounted.current && request === refreshId.current) setLoginError(error instanceof Error ? error.message : 'Failed to load account')
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const off = shellApi.onEvent?.(payload => {
      if (payload.type === 'profile-changed' || payload.type === 'account-login-status') {
        if (payload.type === 'account-login-status' && payload.phase === 'error') setLoginError(payload.message || t('settings.profile.loginFailed'))
        else if (payload.type === 'profile-changed' && payload.profile) setLoginError(null)
        void refresh()
      }
    })
    return () => { mounted.current = false; refreshId.current++; off?.() }
  }, [refresh, t])

  const run = async (action: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    setLoginError(null)
    try { await action(); await refresh() }
    catch (error) { if (mounted.current) setLoginError(error instanceof Error ? error.message : t('settings.profile.loginFailed')) }
    finally { if (mounted.current) setBusy(false) }
  }
  const user = account?.user
  const session = account?.session
  const pending = Boolean(account?.pendingProviderId)
  const providerName = account?.providers.find(p => p.id === (account.providerId || account.pendingProviderId))?.name || 'GitHub'
  const unavailable = account && !account.providers.some(p => p.available)

  return <section className="account-page" aria-label={t('settings.profile.title')}>
    <div className="account-card">
      <div className="account-brand"><img src={enestMark} alt="" draggable={false} /><span>eNest</span></div>
      {user ? <>
        <div className="account-avatar">{user.avatarDataUrl ? <img src={user.avatarDataUrl} alt="" /> : <span>{(user.name || user.login).slice(0, 1).toUpperCase()}</span>}</div>
        <h2>{user.name || user.login}</h2>
        <p className="account-description">@{user.login}</p>
        <div className="account-connected"><span />{t('settings.profile.connectedWith').replace('{provider}', providerName)}</div>
        <dl className="account-details"><div><dt>{t('settings.profile.connectedAt')}</dt><dd>{new Date(user.connectedAt).toLocaleDateString(locale)}</dd></div></dl>
        <button className="account-secondary" type="button" disabled={busy} onClick={() => void run(() => shellApi.logoutAccount(account.providerId || 'github'))}>{t('settings.profile.logout')}</button>
      </> : <>
        <h2>{pending ? t('settings.profile.waitingTitle') : t('settings.profile.welcome')}</h2>
        {pending && <p className="account-description">{t('settings.profile.webHint')}</p>}
        {pending ? <div className="account-pending" role="status">
          <span className="account-spinner" aria-hidden="true" />
          <p>{t('settings.profile.waiting')}</p>
          {session?.mode === 'device' && <div className="account-device"><p>{t('settings.profile.deviceHint')}</p><button type="button" onClick={() => void navigator.clipboard.writeText(session.userCode).then(() => notify.success(t('settings.profile.codeCopied'))).catch(() => setLoginError(t('settings.profile.copyFailed')))} title={t('settings.profile.copyCode')}><code>{session.userCode}</code><span>{t('settings.profile.copyCode')}</span></button></div>}
          <div className="account-pending-actions">{session && <a href={session.verificationUri} target="_blank" rel="noreferrer">{t('settings.profile.openAuthPage')}</a>}<button type="button" disabled={busy} onClick={() => void run(() => shellApi.cancelAccountLogin(account!.pendingProviderId!))}>{t('settings.profile.cancel')}</button></div>
        </div> : <div className="account-providers">
          {!account ? <p role="status">{t('settings.profile.loading')}</p> : account.providers.map(provider => <button className="account-provider" type="button" key={provider.id} disabled={busy} aria-busy={busy} onClick={() => void run(async () => {
            const result = await shellApi.loginAccount(provider.id)
            if (!result.ok) throw new Error(result.error)
          })}><ProviderIcon id={provider.id} /><span>{busy ? t('settings.profile.starting') : t('settings.profile.continueWith').replace('{provider}', provider.name)}</span><span aria-hidden="true">↗</span></button>)}
          {unavailable && <p className="account-availability">{t('settings.profile.unavailable')}</p>}
        </div>}
      </>}
      {loginError && <div className="account-error" role="alert">{loginError}{!account && <button type="button" onClick={() => void refresh()}>{t('settings.profile.retry')}</button>}</div>}
      <div className="account-footer"><span aria-hidden="true">↗</span>{t('settings.profile.browserNote')}</div>
    </div>
    <p className="account-local-note">{t('settings.profile.localNote')}</p>
  </section>
}
