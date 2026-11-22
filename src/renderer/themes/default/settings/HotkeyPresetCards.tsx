import { useEffect, useState } from 'react'
import { ShortcutRecorder } from './ShortcutRecorder'
import { formatAccelerator } from './shortcutCapture'
import { useShortcutProbe } from './useShortcutProbe'
import { ShortcutProbeFeedback } from './ShortcutProbeFeedback'

const PRESETS = ['Alt+Space', 'Control+Space']
/** 预设快捷键列表；设置页「恢复默认」也使用这一份。 */
export const QUICK_PRESET_HOTKEYS: readonly string[] = PRESETS

/** Only persisted, successfully registered keys are marked active. */
export function HotkeyPresetCards({ hotkeys, activeHotkey, registered, forced = [], disabled, enabled, systemConfirmationRequired, onChange }: {
  hotkeys: string[]
  activeHotkey: string
  registered: string[]
  /** 通过低级键盘钩子强制接管的键（Windows） */
  forced?: string[]
  disabled: boolean
  enabled: boolean
  systemConfirmationRequired?: boolean
  onChange(hotkeys: string[], activeHotkey: string, overrideToken?: string, force?: boolean): void
}) {
  const custom = hotkeys.find(key => !PRESETS.includes(key)) ?? ''
  const [draft, setDraft] = useState(custom)
  const [recording, setRecording] = useState(false)
  const [editing, setEditing] = useState(false)
  const draftProbe = useShortcutProbe(draft !== custom ? draft : '', recording, 'quick')
  const save = (overrideToken?: string, force?: boolean): void => {
    onChange([...PRESETS, ...(!PRESETS.includes(draft) ? [draft] : [])], draft, overrideToken, force)
  }
  useEffect(() => setDraft(custom), [custom])
  // 录制完成后草稿即新组合键；探测空闲直接自动保存（冲突时在卡片下方确认或强制覆盖）。
  useEffect(() => {
    if (recording || !draft || draft === custom) return
    if (draftProbe.probe?.status === 'free') save()
  }, [recording, draft, custom, draftProbe.probe?.status])
  const cardState = (key: string) => ({
    active: activeHotkey === key,
    forced: forced.includes(key),
    badge: systemConfirmationRequired && activeHotkey === key ? '待确认'
      : registered.includes(key) ? (forced.includes(key) ? '强制生效' : '生效中') : undefined
  })
  return (
    <>
      <div className="hotkey-cards">
        {PRESETS.map((key, index) => {
          const state = cardState(key)
          return (
            <button type="button" key={key}
              className={`hotkey-card${state.active ? ' active' : ''}${state.forced ? ' is-forced' : ''}`}
              disabled={disabled || recording} aria-pressed={state.active}
              onClick={() => onChange([...PRESETS, ...(custom ? [custom] : [])], key)}>
              <span className="hotkey-card-top">
                <span className="hotkey-card-slot">预设 {index === 0 ? 'A' : 'B'}</span>
                {state.badge && <span className="hotkey-card-badge">{state.badge}</span>}
              </span>
              <span className="hotkey-card-acc">{formatAccelerator(key)}</span>
              <span className="hotkey-card-foot">{state.active
                ? systemConfirmationRequired ? '请在系统中确认'
                  : registered.includes(key) ? '当前生效' : '已选择 · 尚未生效'
                : '点击切换'}</span>
            </button>
          )
        })}
        {/* 自定义卡片：默认与预设卡同样式；点击原位切换为录制，实时显示按下的组合键。 */}
        {editing || recording ? (
          <div className={`hotkey-card hotkey-card-custom is-recording${cardState(custom).active ? ' active' : ''}`}>
            <span className="hotkey-card-top"><span className="hotkey-card-slot">自定义</span>
              {cardState(custom).badge && <span className="hotkey-card-badge">{cardState(custom).badge}</span>}</span>
            <ShortcutRecorder value={draft} onChange={setDraft} disabled={disabled} label="小窗口自定义快捷键" autoStart
              onRecordingChange={active => { setRecording(active); if (!active) setEditing(false) }} compact />
            <span className="hotkey-card-foot">{recording ? '正在录制 · 松开主键完成 · Esc 取消' : '请按下组合键…'}</span>
          </div>
        ) : (
          <button type="button"
            className={`hotkey-card hotkey-card-custom${cardState(custom).active ? ' active' : ''}${cardState(custom).forced ? ' is-forced' : ''}`}
            disabled={disabled} aria-pressed={cardState(custom).active && !!custom}
            onClick={() => { setDraft(custom); setEditing(true) }}>
            <span className="hotkey-card-top"><span className="hotkey-card-slot">自定义</span>
              {cardState(custom).badge && <span className="hotkey-card-badge">{cardState(custom).badge}</span>}</span>
            <span className="hotkey-card-acc">{custom ? formatAccelerator(custom) : '自定义组合键'}</span>
            <span className="hotkey-card-foot">{custom
              ? cardState(custom).active ? '当前生效 · 点击修改' : '点击修改'
              : '点击设置组合键'}</span>
          </button>
        )}
      </div>
      {!recording && !editing && custom && draft && draft !== custom && <ShortcutProbeFeedback {...draftProbe}
        inactive={!enabled} disabled={disabled} onRetry={draftProbe.recheck} onConfirm={token => save(token)}
        onForce={() => save(undefined, true)} />}
    </>
  )
}
