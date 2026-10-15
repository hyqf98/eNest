import { useEffect, useState } from 'react'
import { ShortcutRecorder } from './ShortcutRecorder'
import { formatAccelerator } from './shortcutCapture'
import { useShortcutProbe } from './useShortcutProbe'
import { ShortcutProbeFeedback } from './ShortcutProbeFeedback'

const PRESETS = ['Alt+Space', 'Control+Space']

/** Only persisted, successfully registered keys are marked active. */
export function HotkeyPresetCards({ hotkeys, activeHotkey, registered, disabled, enabled, systemConfirmationRequired, onChange }: {
  hotkeys: string[]
  activeHotkey: string
  registered: string[]
  disabled: boolean
  enabled: boolean
  systemConfirmationRequired?: boolean
  onChange(hotkeys: string[], activeHotkey: string, overrideToken?: string): void
}) {
  const custom = hotkeys.find(key => !PRESETS.includes(key)) ?? ''
  const [draft, setDraft] = useState(custom)
  const [recording, setRecording] = useState(false)
  const [editing, setEditing] = useState(false)
  const draftProbe = useShortcutProbe(editing ? draft : '', recording, 'quick')
  const canSave = !!draft && !!draftProbe.probe && !draftProbe.checking
    && (draftProbe.probe.status === 'free' || (!enabled && draftProbe.probe.status !== 'invalid'))
  const save = (overrideToken?: string): void => onChange([...PRESETS, ...(!PRESETS.includes(draft) ? [draft] : [])], draft, overrideToken)
  useEffect(() => setDraft(custom), [custom])
  return (
    <>
      <div className="hotkey-cards">
        {PRESETS.map((key, index) => (
          <button type="button" key={key} className={`hotkey-card${registered.includes(key) ? ' active' : ''}`}
            disabled={disabled || recording} aria-pressed={activeHotkey === key}
            onClick={() => onChange([...PRESETS, ...(custom ? [custom] : [])], key)}>
            <span className="hotkey-card-top"><span className="hotkey-card-slot">预设 {index === 0 ? 'A' : 'B'}</span>
              {(registered.includes(key) || (systemConfirmationRequired && activeHotkey === key)) && <span className="hotkey-card-badge">{systemConfirmationRequired ? '待确认' : '生效中'}</span>}</span>
            <span className="hotkey-card-acc">{formatAccelerator(key)}</span>
            <span className="hotkey-card-foot">{activeHotkey === key ? systemConfirmationRequired ? '请在系统中确认' : registered.includes(key) ? '当前生效' : '已选择 · 暂未生效' : '点击选择'}</span>
          </button>
        ))}
        <button type="button" className={`hotkey-card${custom && registered.includes(custom) ? ' active' : ''}`}
          disabled={disabled || recording} aria-expanded={editing} aria-controls="quick-custom-editor"
          onClick={() => { setDraft(custom); setEditing(true) }}>
          <span className="hotkey-card-top"><span className="hotkey-card-slot">自定义</span>
            {custom && (registered.includes(custom) || (systemConfirmationRequired && activeHotkey === custom)) && <span className="hotkey-card-badge">{systemConfirmationRequired ? '待确认' : '生效中'}</span>}</span>
          <span className="hotkey-card-acc">{custom ? formatAccelerator(custom) : '自定义组合键'}</span>
          <span className="hotkey-card-foot">{custom ? '点击选择或修改' : '点击设置组合键'}</span>
        </button>
      </div>
      {editing && <div className="quick-custom-shortcut" id="quick-custom-editor">
        <div className="quick-custom-shortcut-head"><span className="label">自定义组合键</span>
          <button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => setEditing(false)}>收起</button></div>
        <div className="quick-custom-shortcut-fields">
          <ShortcutRecorder value={draft} onChange={setDraft} disabled={disabled} label="Quick 自定义快捷键" onRecordingChange={setRecording} />
          <button type="button" className="btn btn-primary" disabled={disabled || recording || !canSave}
            onClick={() => save()}>保存并选择</button>
        </div>
        <ShortcutProbeFeedback {...draftProbe} inactive={!enabled} disabled={disabled || recording}
          onRetry={draftProbe.recheck} onConfirm={save} />
      </div>}
    </>
  )
}
