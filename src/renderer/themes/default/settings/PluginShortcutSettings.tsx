import { useEffect, useRef, useState } from 'react'
import type { PluginShortcutBinding, PluginShortcutInput, PluginShortcutState, PluginShortcutsSnapshot } from '@shared/types/shortcuts'
import { shellApi } from '@renderer/services/shellApi'
import { notify } from '@renderer/services/notifyService'
import { useShellStore } from '@renderer/stores/shellStore'
import { useI18n } from '@renderer/hooks/useI18n'
import { ShortcutRecorder } from './ShortcutRecorder'
import { PluginIcon } from '@renderer/components/PluginIcon'
import { formatAccelerator } from './shortcutCapture'
import { useShortcutProbe } from './useShortcutProbe'
import { ShortcutProbeFeedback, useDescribeShortcutProbe } from './ShortcutProbeFeedback'
import { Switch } from '@renderer/components/ui/Switch'
import { Checkbox } from '@renderer/components/ui/Checkbox'
import { Segmented } from '@renderer/components/ui/Segmented'
import { Select } from '@renderer/components/ui/Select'

/** `forced` is a host-granted authorization and never travels back from the page. */
function toInput(binding: PluginShortcutBinding): PluginShortcutInput {
  const { forced: _granted, ...input } = binding
  return input
}

function toggleEnabled(binding: PluginShortcutBinding, enabled: boolean): PluginShortcutInput {
  return { ...toInput(binding), enabled }
}

export function PluginShortcutSettings() {
  const { t } = useI18n()
  const describeShortcutProbe = useDescribeShortcutProbe()
  const plugins = useShellStore(state => state.plugins)
  const filter = useShellStore(state => state.shortcutPluginFilter)
  const setFilter = useShellStore(state => state.setShortcutPluginFilter)
  const [snapshot, setSnapshot] = useState<PluginShortcutsSnapshot>({ bindings: [], states: [], runtime: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<PluginShortcutInput | null>(null)
  const [draftError, setDraftError] = useState('')
  const [recording, setRecording] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // 受控且恒为空：Radix Select 选中后值会停在该项，清空才能连续选同一个插件。
  const [picker, setPicker] = useState('')
  const busy = useRef(false)
  const request = useRef(0)
  const groupRefs = useRef(new Map<string, HTMLElement>())
  const installed = plugins.filter(plugin => plugin.installed)
  const draftProbe = useShortcutProbe(draft?.accelerator ?? '', recording, 'plugin', draft?.id)
  const canSaveDraft = !!draft?.accelerator && !!draftProbe.probe && !draftProbe.checking
    && (draftProbe.probe.status === 'free' || (!draft.enabled && draftProbe.probe.status !== 'invalid'))

  const statusLabels: Record<PluginShortcutState['status'], string> = {
    registered: t('settings.pluginShortcut.statusRegistered'), disabled: t('settings.pluginShortcut.statusDisabled'),
    'plugin-disabled': t('settings.pluginShortcut.statusPluginDisabled'), 'plugin-missing': t('settings.pluginShortcut.statusPluginMissing'),
    conflict: t('settings.pluginShortcut.statusConflict'), suspended: t('settings.pluginShortcut.statusSuspended'),
    'pending-system': t('settings.pluginShortcut.statusPendingSystem'), forced: t('settings.pluginShortcut.statusForced')
  }

  const refresh = async (): Promise<void> => {
    const revision = ++request.current
    try {
      const next = await shellApi.getPluginShortcuts()
      if (revision === request.current) { setSnapshot(next); setError('') }
    } catch (cause) { if (revision === request.current) setError((cause as Error).message) }
    finally { if (revision === request.current) setLoading(false) }
  }
  useEffect(() => {
    void refresh()
    void useShellStore.getState().refreshPlugins().catch(cause => setError((cause as Error).message))
    const off = shellApi.onEvent(payload => {
      if (payload.type === 'plugin-shortcuts-changed') { request.current++; setSnapshot(payload.snapshot); setLoading(false) }
    })
    return () => { request.current++; off() }
  }, [])

  const save = async (input: PluginShortcutInput, closeEditor = false): Promise<void> => {
    if (busy.current) return
    busy.current = true
    setBusyId(input.id ?? 'new')
    setDraftError('')
    setError('')
    try {
      const result = await shellApi.savePluginShortcut(input)
      if (result.snapshot) setSnapshot(result.snapshot)
      if (!result.ok) {
        const message = result.error || (result.probe && result.probe.status !== 'free' ? describeShortcutProbe(result.probe) : t('settings.pluginShortcut.saveFailed'))
        if (closeEditor) { setDraftError(message); draftProbe.recheck() }
        else if (result.probe && input.enabled) { setDraft({ ...input, overrideToken: undefined }); setDraftError(message) }
        else setError(message)
        return
      }
      if (closeEditor) setDraft(null)
      if (!result.snapshot) await refresh()
      const state = result.snapshot?.states.find(item => item.id === result.binding?.id)
      notify.success(state?.status === 'forced' ? t('settings.pluginShortcut.savedForced')
        : state?.status === 'registered' ? t('settings.pluginShortcut.savedActive') : t('settings.pluginShortcut.savedInactive'))
    } catch (cause) {
      if (closeEditor) setDraftError((cause as Error).message); else setError((cause as Error).message)
    } finally { busy.current = false; setBusyId(null) }
  }
  const remove = async (id: string): Promise<void> => {
    if (busy.current) return
    busy.current = true; setBusyId(id); setError('')
    try {
      const result = await shellApi.removePluginShortcut(id)
      if (!result.ok) throw new Error(result.error || t('settings.pluginShortcut.removeFailed'))
      if (result.snapshot) setSnapshot(result.snapshot); else await refresh()
      if (draft?.id === id) setDraft(null)
      notify.success(t('settings.pluginShortcut.removed'))
    } catch (cause) { setError((cause as Error).message) }
    finally { busy.current = false; setBusyId(null) }
  }
  // A detail-page shortcut link locates its plugin without hiding the other installed plugins.
  // 定位要能看见目标，所以清掉搜索词（否则目标可能被过滤掉，滚动也找不到）。
  useEffect(() => {
    if (filter) setQuery('')
  }, [filter])
  useEffect(() => {
    if (!loading && filter) groupRefs.current.get(filter)?.scrollIntoView({ block: 'nearest' })
  }, [filter, loading, plugins])
  useEffect(() => {
    if (draft && (!installed.some(plugin => plugin.id === draft.pluginId)
      || (draft.id && !snapshot.bindings.some(binding => binding.id === draft.id)))) {
      setDraft(null)
      setDraftError('')
    }
  }, [plugins, snapshot, draft])

  const newBinding = (pluginId: string): void => {
    setDraftError('')
    setDraft({ pluginId, accelerator: '', mode: 'quick', enabled: true })
  }
  const editor = draft && <form className="shortcut-editor" aria-label={draft.id ? t('settings.pluginShortcut.editorEditAria') : t('settings.pluginShortcut.editorNewAria')} onSubmit={event => { event.preventDefault(); if (!recording && canSaveDraft) void save(draft, true) }}>
    <div className="shortcut-editor-fields">
      <div><span>{t('settings.pluginShortcut.editorKeys')}</span><ShortcutRecorder value={draft.accelerator} onChange={accelerator => { setDraftError(''); setDraft({ ...draft, accelerator }) }}
        disabled={!!busyId} label={t('settings.pluginShortcut.editorKeysAria')} onRecordingChange={setRecording} /></div>
      <div><span>{t('settings.pluginShortcut.editorMode')}</span><Segmented className="shortcut-mode" role="radiogroup" ariaLabel={t('settings.pluginShortcut.editorMode')} value={draft.mode}
        disabled={!!busyId || recording} onChange={mode => setDraft({ ...draft, mode })}
        options={[{ value: 'quick' as const, label: t('settings.pluginShortcut.editorModeQuick') }, { value: 'shell' as const, label: t('settings.pluginShortcut.editorModeShell') }]} /></div>
    </div>
    <div className="shortcut-editor-actions">
      <label className="shortcut-enabled-label"><Checkbox checked={draft.enabled} disabled={!!busyId || recording}
        onCheckedChange={enabled => setDraft({ ...draft, enabled: enabled === true })} />{t('settings.pluginShortcut.editorEnable')}</label>
      <button type="button" className="btn btn-ghost" disabled={!!busyId} onClick={() => { setDraft(null); setDraftError('') }}>{t('settings.pluginShortcut.editorCancel')}</button>
      <button type="submit" className="btn btn-primary" disabled={!!busyId || recording || !draft.pluginId || !canSaveDraft}>{busyId ? t('settings.pluginShortcut.editorSaving') : t('settings.pluginShortcut.editorSave')}</button>
    </div>
    <ShortcutProbeFeedback {...draftProbe} inactive={!draft.enabled} disabled={!!busyId || recording}
      forceExplain={t('settings.pluginShortcut.forceExplain')}
      onRetry={draftProbe.recheck} onConfirm={overrideToken => void save({ ...draft, overrideToken }, true)}
      onForce={() => void save({ ...draft, force: true }, true)} />
    {draftError && <p className="shortcut-error" role="alert">{draftError}</p>}
  </form>
  const states = new Map(snapshot.states.map(state => [state.id, state]))
  const renderRow = (binding: PluginShortcutBinding): JSX.Element => {
    const plugin = installed.find(item => item.id === binding.pluginId)
    const state = states.get(binding.id)
    const keys = formatAccelerator(binding.accelerator)
    // The amber tag mirrors the Quick card: this chord is being intercepted, not registered normally.
    // Only the host's own status counts; an authorization alone says nothing about what is held.
    const forced = state?.status === 'forced'
    return <li key={binding.id} className={`shortcut-binding${forced ? ' is-forced' : ''}`}>
      <div className="shortcut-binding-main">
        <span className="shortcut-binding-keys">
          <kbd className="shortcut-keys">{keys}</kbd>
          {forced && <span className="shortcut-badge" title={t('settings.pluginShortcut.forcedTagTitle')}>{t('settings.hotkeyCards.badgeForced')}</span>}
        </span>
        <span className="shortcut-binding-mode">{binding.mode === 'quick' ? t('settings.pluginShortcut.modeQuick') : t('settings.pluginShortcut.modeShell')}</span>
        <div className="shortcut-binding-state" data-status={state?.status ?? 'conflict'}>
          <span>{state ? statusLabels[state.status] : t('settings.pluginShortcut.statusChecking')}</span>{state?.error && <small title={state.error}>{state.error}</small>}
        </div>
        <Switch checked={binding.enabled} className="switch" aria-label={t(binding.enabled ? 'settings.pluginShortcut.toggleOffAria' : 'settings.pluginShortcut.toggleOnAria', { name: plugin?.name ?? binding.pluginId, keys })}
          disabled={!!busyId || !!draft} onCheckedChange={() => void save(toggleEnabled(binding, !binding.enabled))} />
      </div>
      <div className="shortcut-binding-actions">
        <button type="button" className="btn btn-ghost" disabled={!!busyId || !!draft || !plugin} onClick={() => { setDraft({ ...toInput(binding) }); setDraftError('') }}>{t('settings.pluginShortcut.edit')}</button>
        <button type="button" className="btn btn-ghost" disabled={!!busyId || !!draft} onClick={() => void remove(binding.id)}>{t('settings.pluginShortcut.remove')}</button>
      </div>
      {draft?.id === binding.id && editor}
    </li>
  }
  const missingIds = [...new Set(snapshot.bindings.filter(binding => !installed.some(plugin => plugin.id === binding.pluginId)).map(binding => binding.pluginId))]
  const missing = missingIds.map(id => ({ id, plugin: undefined as (typeof installed)[number] | undefined }))
  /*
   * 列表只列出已有绑定的插件；其余插件收进顶部「新增」选择器，不再把几十个
   * 没设快捷键的插件逐个平铺。搜索仍按插件名、插件 ID 和已设组合键三路匹配：
   * 改过的键位也常是找人的入口，组合键用原始 accelerator 匹配，避免按显示格式搜不到。
   */
  const needle = query.trim().toLowerCase()
  const hasBindings = (id: string): boolean => snapshot.bindings.some(binding => binding.pluginId === id)
  const runtimeOf = (id: string) => (snapshot.runtime ?? []).filter(entry => entry.pluginId === id)
  const matches = ({ id, plugin }: { id: string; plugin?: (typeof installed)[number] }): boolean => {
    if (!needle) return true
    if ((plugin?.name ?? '').toLowerCase().includes(needle) || id.toLowerCase().includes(needle)) return true
    if (snapshot.bindings.some(binding => binding.pluginId === id && binding.accelerator.toLowerCase().includes(needle))) return true
    return runtimeOf(id).some(entry => entry.accelerator.toLowerCase().includes(needle) || (entry.label ?? '').toLowerCase().includes(needle))
  }
  // 有搜索词时把"搜得到但还没绑定"的插件也列出来，否则搜一个没设快捷键的插件会得到空结果。
  const listed = ({ id, plugin }: { id: string; plugin?: (typeof installed)[number] }): boolean =>
    hasBindings(id) || runtimeOf(id).length > 0 || (needle && Boolean(plugin)) || draft?.pluginId === id
  const groups = [...installed.map(plugin => ({ id: plugin.id, plugin })), ...missing].filter(group => matches(group) && listed(group))
  // 选择器只提供还没有任何绑定的插件；已有的在分组头部用「＋」追加。
  const candidates = installed.filter(plugin => !hasBindings(plugin.id))
  const pick = (pluginId: string): void => {
    setPicker('')
    if (pluginId) newBinding(pluginId)
  }
  return <section className="s-card" aria-label={t('settings.pluginShortcut.cardAria')}>
    <div className="shortcut-section-head"><div><h2>{t('settings.pluginShortcut.title')} <span className="shortcut-count">{snapshot.bindings.length}</span></h2>
      <p className="hint">{t('settings.pluginShortcut.hint')}</p></div>
    </div>
    {filter && <div className="shortcut-location">{t('settings.pluginShortcut.located', { name: plugins.find(plugin => plugin.id === filter)?.name ?? filter })}
      <button type="button" className="btn btn-ghost" onClick={() => setFilter(null)}>{t('settings.pluginShortcut.cancelLocate')}</button></div>}
    {error && <p className="shortcut-error" role="alert">{error} <button type="button" className="btn btn-ghost" disabled={!!busyId} onClick={() => void refresh()}>{t('settings.pluginShortcut.refreshState')}</button></p>}
    {loading ? <p className="shortcut-empty" role="status">{t('settings.pluginShortcut.loading')}</p> : <>
      {/* 新增与搜索固定在滚动区外面：列表滚到哪儿都能改关键词。 */}
      <div className="shortcut-toolbar">
        <Select className="shortcut-picker" ariaLabel={t('settings.pluginShortcut.pickerAria')} value={picker} onChange={pick}
          disabled={!!busyId || !!draft || !candidates.length}
          placeholder={!installed.length ? t('settings.pluginShortcut.emptyInstalledTitle') : candidates.length ? t('settings.pluginShortcut.pickerPlaceholder') : t('settings.pluginShortcut.pickerExhausted')}
          options={candidates.map(plugin => ({ value: plugin.id, label: plugin.name }))} />
        <input
          type="search"
          className="shortcut-search-input"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder={t('settings.pluginShortcut.searchPlaceholder')}
          aria-label={t('settings.pluginShortcut.searchAria')}
        />
      </div>
      {groups.length ? <div className="shortcut-plugin-groups" data-scrollbar="auto-hide">
      {groups.map(({ id, plugin }) => {
        const bindings = snapshot.bindings.filter(binding => binding.pluginId === id)
        const runtime = runtimeOf(id)
        return <section key={id} className={`shortcut-plugin-group${filter === id ? ' is-located' : ''}`} data-plugin-id={id}
          aria-label={t('settings.pluginShortcut.groupAria', { name: plugin?.name ?? id })} ref={node => { if (node) groupRefs.current.set(id, node); else groupRefs.current.delete(id) }}>
          <header className="shortcut-plugin-head">
            <PluginIcon src={plugin?.icon} glyph={plugin?.glyph ?? '?'} size={36} />
            <div className="shortcut-plugin"><strong>{plugin?.name ?? id}</strong>
              <span>{!plugin ? t('settings.pluginShortcut.pluginRemoved') : plugin.enabled === false ? t('settings.pluginShortcut.pluginDisabled') : bindings.length ? t('settings.pluginShortcut.bindingsCount', { count: String(bindings.length) }) : runtime.length ? t('settings.pluginShortcut.runtimeCount', { count: String(runtime.length) }) : t('settings.pluginShortcut.noShortcut')}</span></div>
            <div className="shortcut-plugin-actions">
              {plugin && <button type="button" className="btn btn-ghost shortcut-add" disabled={!!busyId || !!draft}
                onClick={() => newBinding(id)}><span aria-hidden="true">＋</span> {t('settings.pluginShortcut.addShortcut')}</button>}
            </div>
          </header>
          {bindings.length > 0 && <ul className="shortcut-bindings">{bindings.map(renderRow)}</ul>}
          {runtime.length > 0 && <ul className="shortcut-bindings shortcut-bindings-runtime" aria-label={t('settings.pluginShortcut.runtimeAria')}>
            {runtime.map(entry => <li key={entry.accelerator} className="shortcut-binding shortcut-binding-runtime" data-source="runtime">
              <div className="shortcut-binding-main">
                <kbd className="shortcut-keys">{formatAccelerator(entry.accelerator)}</kbd>
                <span className="shortcut-binding-mode">{t('settings.pluginShortcut.runtimeSource')}</span>
                <div className="shortcut-binding-state" data-status="runtime">
                  <span>{entry.label ?? t('settings.pluginShortcut.runtimeUnlabeled')}</span>
                  <small>{t('settings.pluginShortcut.runtimeHint')}</small>
                </div>
              </div>
            </li>)}
          </ul>}
          {draft?.pluginId === id && !draft.id && editor}
        </section>
      })}
    </div> : (() => {
      // 三种空态各有准确说法：没装插件 / 搜索无命中 / 装了但还没绑定。
      const [title, desc] = !installed.length
        ? [t('settings.pluginShortcut.emptyInstalledTitle'), t('settings.pluginShortcut.emptyInstalledDesc')]
        : needle
          ? [t('settings.pluginShortcut.emptySearchTitle'), t('settings.pluginShortcut.emptySearchDesc')]
          : [t('settings.pluginShortcut.emptyTitle'), t('settings.pluginShortcut.emptyDesc')]
      return <div className="shortcut-empty"><strong>{title}</strong><p>{desc}</p></div>
    })()}
    </>}
  </section>
}
