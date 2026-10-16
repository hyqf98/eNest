import { useEffect, useRef, useState } from 'react'
import type { PluginShortcutBinding, PluginShortcutInput, PluginShortcutState, PluginShortcutsSnapshot } from '@shared/types/shortcuts'
import { shellApi } from '@renderer/services/shellApi'
import { notify } from '@renderer/services/notifyService'
import { useShellStore } from '@renderer/stores/shellStore'
import { ShortcutRecorder } from './ShortcutRecorder'
import { PluginIcon } from './PluginIcon'
import { formatAccelerator } from './shortcutCapture'
import { useShortcutProbe } from './useShortcutProbe'
import { ShortcutProbeFeedback, describeShortcutProbe } from './ShortcutProbeFeedback'
import { Switch } from '@renderer/components/ui/Switch'
import { Checkbox } from '@renderer/components/ui/Checkbox'
import { Segmented } from '@renderer/components/ui/Segmented'

const statusLabels: Record<PluginShortcutState['status'], string> = {
  registered: '已生效', disabled: '已关闭', 'plugin-disabled': '插件已禁用',
  'plugin-missing': '插件已移除', conflict: '未生效', suspended: '录制期间暂停', 'pending-system': '等待系统确认'
}

export function PluginShortcutSettings() {
  const plugins = useShellStore(state => state.plugins)
  const filter = useShellStore(state => state.shortcutPluginFilter)
  const setFilter = useShellStore(state => state.setShortcutPluginFilter)
  const [snapshot, setSnapshot] = useState<PluginShortcutsSnapshot>({ bindings: [], states: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<PluginShortcutInput | null>(null)
  const [draftError, setDraftError] = useState('')
  const [recording, setRecording] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const busy = useRef(false)
  const request = useRef(0)
  const groupRefs = useRef(new Map<string, HTMLElement>())
  const installed = plugins.filter(plugin => plugin.installed)
  const draftProbe = useShortcutProbe(draft?.accelerator ?? '', recording, 'plugin', draft?.id)
  const canSaveDraft = !!draft?.accelerator && !!draftProbe.probe && !draftProbe.checking
    && (draftProbe.probe.status === 'free' || (!draft.enabled && draftProbe.probe.status !== 'invalid'))

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
        const message = result.error || (result.probe && result.probe.status !== 'free' ? describeShortcutProbe(result.probe) : '保存失败')
        if (closeEditor) { setDraftError(message); draftProbe.recheck() }
        else if (result.probe && input.enabled) { setDraft({ ...input, overrideToken: undefined }); setDraftError(message) }
        else setError(message)
        return
      }
      if (closeEditor) setDraft(null)
      if (!result.snapshot) await refresh()
      const state = result.snapshot?.states.find(item => item.id === result.binding?.id)
      notify.success(state?.status === 'registered' ? '插件快捷键已生效' : '插件快捷键已保存')
    } catch (cause) {
      if (closeEditor) setDraftError((cause as Error).message); else setError((cause as Error).message)
    } finally { busy.current = false; setBusyId(null) }
  }
  const remove = async (id: string): Promise<void> => {
    if (busy.current) return
    busy.current = true; setBusyId(id); setError('')
    try {
      const result = await shellApi.removePluginShortcut(id)
      if (!result.ok) throw new Error(result.error || '删除失败')
      if (result.snapshot) setSnapshot(result.snapshot); else await refresh()
      if (draft?.id === id) setDraft(null)
      notify.success('快捷键绑定已删除')
    } catch (cause) { setError((cause as Error).message) }
    finally { busy.current = false; setBusyId(null) }
  }
  const launch = async (id: string, binding = true): Promise<void> => {
    if (busy.current) return
    busy.current = true; setBusyId(id); setError('')
    try {
      if (binding) {
        const result = await shellApi.launchPluginShortcut(id)
        if (!result.ok && !result.cancelled) setError(result.error || '启动失败')
      } else {
        await shellApi.openPlugin(id)
      }
    } catch (cause) { setError((cause as Error).message) }
    finally { busy.current = false; setBusyId(null) }
  }
  // A detail-page shortcut link locates its plugin without hiding the other installed plugins.
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
  const editor = draft && <form className="shortcut-editor" aria-label={draft.id ? '编辑插件快捷键' : '新增插件快捷键'} onSubmit={event => { event.preventDefault(); if (!recording && canSaveDraft) void save(draft, true) }}>
    <div className="shortcut-editor-fields">
      <div><span>组合键</span><ShortcutRecorder value={draft.accelerator} onChange={accelerator => { setDraftError(''); setDraft({ ...draft, accelerator }) }}
        disabled={!!busyId} label="插件快捷键组合" onRecordingChange={setRecording} /></div>
      <div><span>启动位置</span><Segmented className="shortcut-mode" role="radiogroup" ariaLabel="启动位置" value={draft.mode}
        disabled={!!busyId || recording} onChange={mode => setDraft({ ...draft, mode })}
        options={[{ value: 'quick' as const, label: '小窗口' }, { value: 'shell' as const, label: '主窗口' }]} /></div>
    </div>
    <div className="shortcut-editor-actions">
      <label className="shortcut-enabled-label"><Checkbox checked={draft.enabled} disabled={!!busyId || recording}
        onCheckedChange={enabled => setDraft({ ...draft, enabled: enabled === true })} />启用此绑定</label>
      <button type="button" className="btn btn-ghost" disabled={!!busyId} onClick={() => { setDraft(null); setDraftError('') }}>取消</button>
      <button type="submit" className="btn btn-primary" disabled={!!busyId || recording || !draft.pluginId || !canSaveDraft}>{busyId ? '保存中…' : '保存'}</button>
    </div>
    <ShortcutProbeFeedback {...draftProbe} inactive={!draft.enabled} disabled={!!busyId || recording}
      onRetry={draftProbe.recheck} onConfirm={overrideToken => void save({ ...draft, overrideToken }, true)} />
    {draftError && <p className="shortcut-error" role="alert">{draftError}</p>}
  </form>
  const states = new Map(snapshot.states.map(state => [state.id, state]))
  const renderRow = (binding: PluginShortcutBinding): JSX.Element => {
    const plugin = installed.find(item => item.id === binding.pluginId)
    const state = states.get(binding.id)
    const unavailable = !plugin || plugin.enabled === false
    return <li key={binding.id} className="shortcut-binding">
      <div className="shortcut-binding-main">
        <kbd className="shortcut-keys">{formatAccelerator(binding.accelerator)}</kbd>
        <span className="shortcut-binding-mode">{binding.mode === 'quick' ? '小窗口' : '主窗口'}</span>
        <div className="shortcut-binding-state" data-status={state?.status ?? 'conflict'}>
          <span>{state ? statusLabels[state.status] : '正在检查'}</span>{state?.error && <small title={state.error}>{state.error}</small>}
        </div>
        <Switch checked={binding.enabled} className="switch" aria-label={`${binding.enabled ? '关闭' : '启用'} ${plugin?.name ?? binding.pluginId} 的 ${formatAccelerator(binding.accelerator)}`}
          disabled={!!busyId || !!draft} onCheckedChange={() => void save({ ...binding, enabled: !binding.enabled })} />
      </div>
      <div className="shortcut-binding-actions">
        <button type="button" className="btn btn-ghost" disabled={!!busyId || !!draft || unavailable} onClick={() => void launch(binding.id)}>{busyId === binding.id ? '处理中…' : '立即启动'}</button>
        <button type="button" className="btn btn-ghost" disabled={!!busyId || !!draft || !plugin} onClick={() => { setDraft({ ...binding }); setDraftError('') }}>编辑</button>
        <button type="button" className="btn btn-ghost" disabled={!!busyId || !!draft} onClick={() => void remove(binding.id)}>删除</button>
      </div>
      {draft?.id === binding.id && editor}
    </li>
  }
  const missingIds = [...new Set(snapshot.bindings.filter(binding => !installed.some(plugin => plugin.id === binding.pluginId)).map(binding => binding.pluginId))]
  const groups = [...installed.map(plugin => ({ id: plugin.id, plugin })), ...missingIds.map(id => ({ id, plugin: undefined }))]
  return <section className="s-card" aria-label="插件快捷键">
    <div className="shortcut-section-head"><div><h2>插件快捷键 <span className="shortcut-count">{installed.length}</span></h2>
      <p className="hint">同一插件可分别设置小窗口和主窗口快捷键。</p></div>
    </div>
    {filter && <div className="shortcut-location">已定位到 {plugins.find(plugin => plugin.id === filter)?.name ?? filter}
      <button type="button" className="btn btn-ghost" onClick={() => setFilter(null)}>取消定位</button></div>}
    {error && <p className="shortcut-error" role="alert">{error} <button type="button" className="btn btn-ghost" disabled={!!busyId} onClick={() => void refresh()}>刷新状态</button></p>}
    {loading ? <p className="shortcut-empty" role="status">正在读取插件绑定…</p> : groups.length ? <div className="shortcut-plugin-groups">
      {groups.map(({ id, plugin }) => {
        const bindings = snapshot.bindings.filter(binding => binding.pluginId === id)
        return <section key={id} className={`shortcut-plugin-group${filter === id ? ' is-located' : ''}`} data-plugin-id={id}
          aria-label={`${plugin?.name ?? id} 快捷键`} ref={node => { if (node) groupRefs.current.set(id, node); else groupRefs.current.delete(id) }}>
          <header className="shortcut-plugin-head">
            <PluginIcon src={plugin?.icon} glyph={plugin?.glyph ?? '?'} size={36} />
            <div className="shortcut-plugin"><strong>{plugin?.name ?? id}</strong>
              <span>{!plugin ? '插件已移除 · 可删除保留的绑定' : plugin.enabled === false ? '插件已禁用' : bindings.length ? `${bindings.length} 组快捷键` : '未设置快捷键'}</span></div>
            <div className="shortcut-plugin-actions">
              <button type="button" className="btn btn-ghost" disabled={!!busyId || !!draft || !plugin || plugin.enabled === false}
                title="在主窗口启动" onClick={() => void launch(id, false)}>{busyId === id ? '启动中…' : '启动'}</button>
              {plugin && <button type="button" className="btn btn-ghost shortcut-add" disabled={!!busyId || !!draft}
                onClick={() => newBinding(id)}><span aria-hidden="true">＋</span> 添加快捷键</button>}
            </div>
          </header>
          {bindings.length > 0 && <ul className="shortcut-bindings">{bindings.map(renderRow)}</ul>}
          {draft?.pluginId === id && !draft.id && editor}
        </section>
      })}
    </div> : <div className="shortcut-empty"><strong>还没有安装插件</strong><p>安装后会自动出现在这里，随时添加快捷键。</p></div>}
  </section>
}
