import { useEffect, useRef, useState } from 'react'
import type { PluginShortcutBinding, PluginShortcutInput, PluginShortcutState, PluginShortcutsSnapshot, ShortcutProbeResult } from '@shared/types/shortcuts'
import { shellApi } from '@renderer/services/shellApi'
import { notify } from '@renderer/services/notifyService'
import { useShellStore } from '@renderer/stores/shellStore'
import { ShortcutRecorder } from './ShortcutRecorder'
import { formatAccelerator } from './shortcutCapture'

const statusLabels: Record<PluginShortcutState['status'], string> = {
  registered: '已生效', disabled: '已关闭', 'plugin-disabled': '插件已禁用',
  'plugin-missing': '插件已移除', conflict: '未生效', suspended: '录制期间暂停'
}

function describeProbe(probe: ShortcutProbeResult): string {
  const owner = probe.ownerLabel || probe.ownerPluginId
  if (probe.status === 'quick') return '已被 Quick 呼出键占用，请换一个组合键。'
  if (probe.status === 'shortcut') return `已被${owner ? `「${owner}」的` : '另一条'}插件绑定占用，请换一个组合键。`
  if (probe.status === 'runtime') return `已被插件${owner ? `「${owner}」` : ''}运行时快捷键占用，请换一个组合键。`
  return probe.hint || (probe.status === 'invalid' ? '组合键格式无效，请重新输入或录制。' : '已被系统或其他应用占用，请换一个组合键。')
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
  const installed = plugins.filter(plugin => plugin.installed)

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
    void useShellStore.getState().refreshPlugins()
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
        const message = result.probe ? describeProbe(result.probe) : result.error || '保存失败'
        if (closeEditor) setDraftError(message); else setError(message)
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
  const launch = async (id: string): Promise<void> => {
    if (busy.current) return
    busy.current = true; setBusyId(id); setError('')
    try {
      const result = await shellApi.launchPluginShortcut(id)
      if (!result.ok && !result.cancelled) setError(result.error || '启动失败')
    } catch (cause) { setError((cause as Error).message) }
    finally { busy.current = false; setBusyId(null) }
  }
  const newBinding = (): void => {
    setDraftError('')
    setDraft({ pluginId: installed.some(plugin => plugin.id === filter) ? filter! : installed[0]?.id ?? '', accelerator: '', mode: 'quick', enabled: true })
  }
  const editor = draft && <form className="shortcut-editor" aria-label={draft.id ? '编辑插件快捷键' : '新增插件快捷键'} onSubmit={event => { event.preventDefault(); if (!recording) void save(draft, true) }}>
    <div className="shortcut-editor-fields">
      <label><span>插件</span><select aria-label="绑定插件" value={draft.pluginId} disabled={!!busyId || recording}
        onChange={event => { setDraftError(''); setDraft({ ...draft, pluginId: event.target.value }) }}>
        <option value="" disabled>选择已安装的插件</option>
        {draft.pluginId && !installed.some(plugin => plugin.id === draft.pluginId) && <option value={draft.pluginId}>已移除 · {draft.pluginId}</option>}
        {installed.map(plugin => <option key={plugin.id} value={plugin.id}>{plugin.name}{plugin.enabled === false ? '（已禁用）' : ''}</option>)}
      </select></label>
      <div><span>组合键</span><ShortcutRecorder value={draft.accelerator} onChange={accelerator => { setDraftError(''); setDraft({ ...draft, accelerator }) }}
        disabled={!!busyId} label="插件快捷键组合" onRecordingChange={setRecording} /></div>
      <label><span>启动位置</span><select aria-label="启动位置" value={draft.mode} disabled={!!busyId || recording} onChange={event => setDraft({ ...draft, mode: event.target.value as 'quick' | 'shell' })}>
        <option value="quick">小窗口</option><option value="shell">主窗口</option>
      </select></label>
    </div>
    <div className="shortcut-editor-actions">
      <label className="shortcut-enabled-label"><input type="checkbox" checked={draft.enabled} disabled={!!busyId || recording}
        onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />启用此绑定</label>
      <button type="button" className="btn btn-ghost" disabled={!!busyId} onClick={() => { setDraft(null); setDraftError('') }}>取消</button>
      <button type="submit" className="btn btn-primary" disabled={!!busyId || recording || !draft.pluginId || !draft.accelerator.trim()}>{busyId ? '保存中…' : '保存'}</button>
    </div>
    {draftError && <p className="shortcut-error" role="alert">{draftError}</p>}
  </form>
  const visible = snapshot.bindings.filter(binding => !filter || binding.pluginId === filter)
  const states = new Map(snapshot.states.map(state => [state.id, state]))
  const renderRow = (binding: PluginShortcutBinding): JSX.Element => {
    const plugin = plugins.find(item => item.id === binding.pluginId && item.installed)
    const state = states.get(binding.id)
    const unavailable = !plugin || plugin.enabled === false
    return <li key={binding.id} className="shortcut-binding">
      <div className="shortcut-binding-main">
        <div className="shortcut-plugin"><strong>{plugin?.name ?? binding.pluginId}</strong><span>{binding.mode === 'quick' ? '小窗口' : '主窗口'}</span></div>
        <kbd className="shortcut-keys">{formatAccelerator(binding.accelerator)}</kbd>
        <div className="shortcut-binding-state" data-status={state?.status ?? 'conflict'}>
          <span>{state ? statusLabels[state.status] : '正在检查'}</span>{state?.error && <small title={state.error}>{state.error}</small>}
        </div>
        <button type="button" className={`switch${binding.enabled ? ' on' : ''}`} aria-label={`${binding.enabled ? '关闭' : '启用'} ${plugin?.name ?? binding.pluginId} 的 ${formatAccelerator(binding.accelerator)}`}
          aria-pressed={binding.enabled} disabled={!!busyId || !!draft} onClick={() => void save({ ...binding, enabled: !binding.enabled })} />
      </div>
      <div className="shortcut-binding-actions">
        <button type="button" className="btn btn-ghost" disabled={!!busyId || !!draft || unavailable} onClick={() => void launch(binding.id)}>{busyId === binding.id ? '处理中…' : '立即启动'}</button>
        <button type="button" className="btn btn-ghost" disabled={!!busyId || !!draft} onClick={() => { setDraft({ ...binding }); setDraftError('') }}>编辑</button>
        <button type="button" className="btn btn-ghost" disabled={!!busyId || !!draft} onClick={() => void remove(binding.id)}>删除</button>
      </div>
      {draft?.id === binding.id && editor}
    </li>
  }
  return <section className="s-card" aria-label="插件快捷键">
    <div className="shortcut-section-head"><div><h2>插件快捷键</h2><p className="hint">一次组合键直接进入插件。同一插件可分别绑定小窗口和主窗口；eNest 在托盘运行时仍可使用。</p></div>
      <button type="button" className="btn btn-primary" disabled={loading || !!draft || !!busyId || !installed.length} onClick={newBinding}>新增绑定</button>
    </div>
    <div className="shortcut-filter"><label htmlFor="shortcut-filter">筛选插件</label><select id="shortcut-filter" value={filter ?? ''} disabled={!!draft}
      onChange={event => setFilter(event.target.value || null)}>
      <option value="">全部插件</option>
      {filter && !installed.some(plugin => plugin.id === filter) && <option value={filter}>已移除 · {filter}</option>}
      {installed.map(plugin => <option key={plugin.id} value={plugin.id}>{plugin.name}</option>)}
    </select>{filter && <button type="button" className="btn btn-ghost" disabled={!!draft} onClick={() => setFilter(null)}>显示全部</button>}</div>
    {!window.enestShell && <p className="hint">浏览器预览仅保存配置并检查应用内冲突，系统快捷键和窗口启动需在 eNest 中验证。</p>}
    {error && <p className="shortcut-error" role="alert">{error} <button type="button" className="btn btn-ghost" disabled={!!busyId} onClick={() => void refresh()}>刷新状态</button></p>}
    {draft && !draft.id && editor}
    {loading ? <p className="shortcut-empty" role="status">正在读取插件绑定…</p> : visible.length ? <ul className="shortcut-bindings">{visible.map(renderRow)}</ul> : !draft &&
      <div className="shortcut-empty"><strong>{filter ? '此插件还没有快捷键' : '还没有插件快捷键'}</strong><p>{installed.length ? '新增绑定，选择插件和启动位置。保存后即可直接启动。' : '安装插件后即可为它绑定快捷键。'}</p></div>}
  </section>
}
