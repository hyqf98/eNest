import { useEffect, useState } from 'react'
import { ShortcutRecorder } from './ShortcutRecorder'
import { formatAccelerator } from './shortcutCapture'

const PRESETS = ['Alt+Space', 'Control+Space']

/** Only persisted, successfully registered keys are marked active. */
export function HotkeyPresetCards({ hotkeys, activeHotkey, registered, disabled, onChange }: {
  hotkeys: string[]
  activeHotkey: string
  registered: string[]
  disabled: boolean
  onChange(hotkeys: string[], activeHotkey: string): void
}) {
  const custom = hotkeys.find(key => !PRESETS.includes(key)) ?? ''
  const [draft, setDraft] = useState(custom)
  const [recording, setRecording] = useState(false)
  useEffect(() => setDraft(custom), [custom])
  return (
    <>
      <div className="hotkey-cards">
        {[...PRESETS, ...(custom ? [custom] : [])].map((key, index) => (
          <button type="button" key={key} className={`hotkey-card${registered.includes(key) ? ' active' : ''}`}
            disabled={disabled || recording} aria-pressed={activeHotkey === key}
            onClick={() => onChange([...PRESETS, ...(custom ? [custom] : [])], key)}>
            <span className="hotkey-card-top"><span className="hotkey-card-slot">{index < 2 ? `预设 ${index === 0 ? 'A' : 'B'}` : '自定义'}</span>
              {registered.includes(key) && <span className="hotkey-card-badge">生效中</span>}</span>
            <span className="hotkey-card-acc">{formatAccelerator(key)}</span>
            <span className="hotkey-card-foot">{activeHotkey === key ? registered.includes(key) ? '当前生效' : '已选择 · 暂未生效' : '点击选择'}</span>
          </button>
        ))}
      </div>
      <div className="quick-custom-shortcut">
        <span className="label">自定义组合键</span>
        <ShortcutRecorder value={draft} onChange={setDraft} disabled={disabled} label="Quick 自定义快捷键" onRecordingChange={setRecording} />
        <button type="button" className="btn btn-ghost" disabled={disabled || recording || !draft.trim()}
          onClick={() => onChange([...PRESETS, ...(!PRESETS.includes(draft.trim()) ? [draft.trim()] : [])], draft.trim())}>保存并选择</button>
      </div>
    </>
  )
}
