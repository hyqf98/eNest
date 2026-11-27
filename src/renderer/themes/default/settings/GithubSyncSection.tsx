import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@renderer/components/ui/Button'
import { Checkbox } from '@renderer/components/ui/Checkbox'
import { Input } from '@renderer/components/ui/Input'
import { Select } from '@renderer/components/ui/Select'
import { Switch } from '@renderer/components/ui/Switch'
import { useI18n } from '@renderer/hooks/useI18n'
import { confirmAction } from '@renderer/services/confirmAction'
import { shellApi } from '@renderer/services/shellApi'
import { useShellStore } from '@renderer/stores/shellStore'
import { formatBytes } from '@shared/formatBytes'
import { DEFAULT_SYNC_REPOSITORY, type GithubSyncState, type SyncConflict, type SyncDirection } from '@shared/types/githubSync'
import type { PluginDataUsage } from '@shared/types/plugin'
import { SettingsPluginRow } from './SettingsPluginRow'
import './githubSync.css'

function message(error: unknown) { return String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }

export function GithubSyncSection({ accountId, login }: { accountId?: number; login: string }) {
  const { locale, t } = useI18n()
  const label = (key: string, args?: Record<string, string | number>) => t(`settings.githubSync.${key}`, args)
  const plugins = useShellStore(state => state.plugins)
  const installed = useMemo(() => plugins.filter(item => item.installed), [plugins])
  const installedKey = installed.map(item => item.id).sort().join(',')
  const [usage, setUsage] = useState<PluginDataUsage | null>(null)
  const [sync, setSync] = useState<GithubSyncState | null>(null)
  const [name, setName] = useState(DEFAULT_SYNC_REPOSITORY)
  const [candidates, setCandidates] = useState<string[] | null>(null)
  const [chosen, choose] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true)
  const [error, setError] = useState(''), [localError, setLocalError] = useState(''), [cloudError, setCloudError] = useState('')
  const [failedTransfer, setFailedTransfer] = useState<{ direction: SyncDirection; ids: string[] } | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number; pluginId: string } | null>(null)
  const live = useRef(false), working = useRef(false), revision = useRef(0)
  const refresh = useCallback(async () => {
    const request = ++revision.current
    setLoading(true)
    const current = () => live.current && request === revision.current
    await Promise.all([
      shellApi.getPluginDataUsage?.().then(value => { if (current()) { setUsage(value); setLocalError('') } }).catch(reason => { if (current()) setLocalError(message(reason)) }),
      accountId && shellApi.getGithubSyncState(accountId).then(value => { if (current()) { setSync(value); setProgress(value.progress); setCloudError(value.error ?? '') } }).catch(reason => { if (current()) setCloudError(message(reason)) }),
    ])
    if (current()) setLoading(false)
  }, [accountId])
  useEffect(() => {
    live.current = true
    void refresh()
    const off = shellApi.onEvent(payload => {
      if (payload.type === 'github-sync-progress' && payload.accountId === accountId) setProgress(payload)
      if (payload.type === 'github-sync-finished' && payload.accountId === accountId) { setProgress(null); if (!working.current) void refresh() }
    })
    return () => { live.current = false; revision.current++; off() }
  }, [accountId, installedKey, refresh])

  const run = async (action: () => Promise<unknown>, reload = true) => {
    if (working.current) return
    working.current = true; setBusy(true); setError(''); setFailedTransfer(null)
    try { await action() } catch (reason) { if (live.current) setError(message(reason)) }
    finally {
      if (live.current && reload) await refresh()
      working.current = false
      if (live.current) setBusy(false)
    }
  }
  const repository = sync?.repository, target = `${login}/${repository?.name ?? name.trim()}`
  const localRows = new Map(usage?.plugins.map(item => [item.pluginId, item]))
  const catalog = new Map(installed.map(item => [item.id, item]))
  const cloud = new Map(sync?.cloud.map(item => [item.pluginId, item]))
  const rows = [...new Set([...catalog.keys(), ...localRows.keys(), ...cloud.keys()])].sort((left, right) => (catalog.get(left)?.name || left).localeCompare(catalog.get(right)?.name || right, locale))
  const local = rows.filter(id => localRows.has(id) || catalog.has(id)), selected = local.filter(id => chosen.has(id))
  const restorable = selected.filter(id => cloud.has(id)), disabled = busy || loading || !!progress
  const transfer = (direction: SyncDirection, ids: string[], resolve?: SyncConflict) => void run(async () => {
    if (!accountId || !repository || !ids.length) return
    const confirmLabel = label(resolve ? direction === 'upload' ? 'keepLocal' : 'keepCloud' : direction)
    const names = ids.slice(0, 5).map(id => catalog.get(id)?.name || id).join('、') + (ids.length > 5 ? '…' : '')
    if (!await confirmAction({ title: confirmLabel, message: label(resolve ? 'resolveConfirm' : direction === 'upload' ? 'uploadConfirm' : 'restoreConfirm', { target, count: ids.length, names }), confirmLabel, danger: !!resolve })) return
    try { await shellApi.syncGithubPlugins({ accountId, repositoryId: repository.id, direction, pluginIds: ids, resolve }) }
    catch (reason) { if (live.current) setFailedTransfer({ direction, ids }); throw reason }
  })
  const report = sync?.report, issues = report?.items.filter(item => !['done', 'unchanged'].includes(item.status)) ?? []
  const failedIds = issues.filter(item => item.status === 'error' && local.includes(item.pluginId)).map(item => item.pluginId)
  const retryAllRestore = report?.direction === 'restore' && issues.some(item => item.status === 'error' && !item.pluginId)
  const refreshList = () => { if (!failedTransfer) setError(''); void refresh() }

  return <section className="s-card github-sync" aria-labelledby="github-sync-title">
    <header className="sync-heading"><div><h2 id="github-sync-title">{label('title')}</h2><p>{label('intro')}</p></div><Button size="sm" variant="ghost" disabled={disabled} onClick={refreshList}>{label('refresh')}</Button></header>
    {!accountId ? <p className="sync-note">{label('reauth')}</p> : <div className="sync-repository">
      {repository ? <div className="sync-bound"><div><span className="sync-caption">{label('privateRepo')}</span><strong>{target}</strong></div><Button size="sm" variant="ghost" disabled={disabled} onClick={() => void run(async () => {
        if (!await confirmAction({ title: label('disconnect'), message: label('disconnectHint', { target }), confirmLabel: label('disconnect') })) return
        await shellApi.disconnectGithubRepository(accountId, repository.id); if (live.current) { setName(repository.name); choose(new Set()) }
      })}>{label('disconnect')}</Button></div> : <>
        <form className="sync-connect" onSubmit={event => { event.preventDefault(); if (!disabled && name.trim()) void run(() => shellApi.connectGithubRepository(accountId, name.trim())) }}>
          <label htmlFor="sync-repo-name" className="sync-repo-label">
            <span>{label('repoName')}</span><span className="sync-repo-owner" title={`@${login}`}>@{login}</span>
          </label>
          <Input id="sync-repo-name" aria-describedby="sync-repo-hint" value={name} onChange={event => setName(event.target.value)} maxLength={100} disabled={disabled} placeholder={DEFAULT_SYNC_REPOSITORY} autoComplete="off" spellCheck={false} required />
          <div className="sync-repo-actions">
            <Button variant="ghost" type="button" disabled={disabled} onClick={() => void run(async () => { const names = await shellApi.discoverGithubRepositories(accountId); if (live.current) setCandidates(names) }, false)}>{label('discover')}</Button>
            <Button variant="primary" type="submit" disabled={disabled || !name.trim()}>{label('connect')}</Button>
          </div>
        </form>
        {candidates && (candidates.length ? <Select value={candidates.includes(name) ? name : ''} options={candidates.map(value => ({ value, label: value }))} onChange={setName} ariaLabel={label('chooseRepo')} placeholder={label('chooseRepo')} disabled={disabled} /> : <p role="status">{label('noneFound')}</p>)}
      </>}
      <p>
        {!repository && <span id="sync-repo-hint">{label('repoHint')} </span>}
        {sync && <a className="sync-access" href={sync.installationUrl} target="_blank" rel="noreferrer">{label('install')} <span aria-hidden="true">↗</span></a>}
      </p>
    </div>}
    {repository && accountId && <div className="sync-auto"><div><label htmlFor="sync-auto">{label('automatic')}</label><p>{label('autoHint')}</p></div><Switch id="sync-auto" checked={sync.autoRestore} disabled={disabled} onCheckedChange={enabled => void run(async () => {
      if (enabled && !await confirmAction({ title: label('automatic'), message: label('autoConfirm', { target }), confirmLabel: label('enable') })) return
      await shellApi.setGithubAutoRestore(accountId, repository.id, enabled)
    })} /></div>}
    {(error || cloudError || localError) && <div className="sync-feedback"><p className="sync-error" role="alert">{[...new Set([error, cloudError, localError].filter(Boolean))].join(' · ')}</p>
      {failedTransfer && !cloudError ? <Button size="sm" variant="ghost" disabled={disabled} onClick={() => transfer(failedTransfer.direction, failedTransfer.ids)}>{label('retryTransfer')}</Button>
        : (cloudError || localError) && <Button size="sm" variant="ghost" disabled={disabled} onClick={refreshList}>{label('retryRead')}</Button>}
    </div>}
    <div className="sync-list-header"><div><h3>{label('plugins')}</h3><p>{label('sizeHint')}</p></div><label className="sync-select-all"><Checkbox disabled={disabled || !local.length} checked={selected.length === 0 ? false : selected.length === local.length ? true : 'indeterminate'} onCheckedChange={value => choose(value === true ? new Set(local) : new Set())} />{label('all')}</label></div>
    {rows.length ? <ul className="dev-plugin-list sync-plugins" data-scrollbar="auto-hide" aria-busy={loading}>{rows.map(id => {
      const plugin = catalog.get(id), item = localRows.get(id), entry = cloud.get(id), installedHere = !!plugin || !!item
      return <li key={id}><SettingsPluginRow as="label" plugin={plugin ?? { id, name: id }} detail={id} running={item?.running} unavailable={!installedHere}
        badges={!installedHere || item?.running ? <span className="tag">{label(installedHere ? 'running' : 'notInstalled')}</span> : undefined}
        leading={<Checkbox aria-label={plugin?.name ?? id} disabled={disabled || !installedHere} checked={installedHere && chosen.has(id)} onCheckedChange={value => choose(previous => { const next = new Set(previous); if (value === true) next.add(id); else next.delete(id); return next })} />}>
        <span className="sync-sizes"><span>{label('local')} {item ? formatBytes(Math.max(0, item.total - item.packageBytes), locale) : '—'}</span><small>{label('cloud')} {entry ? formatBytes(entry.bytes, locale) : '—'}</small></span>
      </SettingsPluginRow></li>
    })}</ul> : <p role="status" className="sync-note">{loading ? t('common.loading') : label('empty')}</p>}
    {repository && <div className="sync-actions"><span role="status">{progress ? label('progress', { current: progress.done + 1, total: progress.total, name: catalog.get(progress.pluginId)?.name || progress.pluginId }) : label('selected', { count: selected.length })}</span>
      {progress && accountId && <Button variant="ghost" size="sm" onClick={() => void shellApi.cancelGithubSync(accountId, repository.id).catch(reason => setError(message(reason)))}>{label('cancelRemaining')}</Button>}
      <Button variant="ghost" disabled={disabled || !restorable.length || !!cloudError} onClick={() => transfer('restore', restorable)}>{label('restore')}</Button>
      <Button variant="primary" disabled={disabled || !selected.length || !!cloudError} onClick={() => transfer('upload', selected)}>{label('upload')}</Button></div>}
    <p className="sync-note">{label('scope')}</p>
    {report && <div className="sync-report" aria-live="polite"><strong>{label('lastRun', { action: label(report.direction), time: new Date(report.completedAt).toLocaleString(locale) })}</strong>
      <p>{label('summary', { done: report.items.filter(item => item.status === 'done').length, same: report.items.filter(item => item.status === 'unchanged').length, issues: issues.length })}</p>
      {report.cancelled && <p>{label('cancelled')}</p>}
      {failedIds.length > 0 && <Button size="sm" variant="ghost" disabled={disabled || !!cloudError} onClick={() => transfer(report.direction, failedIds)}>{label('retryFailed', { count: failedIds.length })}</Button>}
      {retryAllRestore && <Button size="sm" variant="ghost" disabled={disabled || !!cloudError || !local.some(id => cloud.has(id))} onClick={() => transfer('restore', local.filter(id => cloud.has(id)))}>{label('retryTransfer')}</Button>}
      {issues.map(item => <div key={item.pluginId} className="sync-issue"><strong>{catalog.get(item.pluginId)?.name || item.pluginId}</strong><span>{item.message}</span>{item.status === 'conflict' && item.conflict && <div>
        <Button size="sm" variant="ghost" disabled={disabled || !!cloudError} onClick={() => transfer('upload', [item.pluginId], item.conflict)}>{label('keepLocal')}</Button>
        {item.conflict.remote && <Button size="sm" variant="ghost" disabled={disabled || !!cloudError} onClick={() => transfer('restore', [item.pluginId], item.conflict)}>{label('keepCloud')}</Button>}
      </div>}</div>)}
    </div>}
  </section>
}
