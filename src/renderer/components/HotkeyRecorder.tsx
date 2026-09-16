/**
 * HotkeyRecorder — 全局快捷键录制控件
 * 点击进入录制；将 KeyboardEvent.code 映射为 Electron accelerator。
 * 至少一个非修饰键；Esc 取消。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const CODE_TO_KEY: Record<string, string> = {
  Space: 'Space',
  Enter: 'Return',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/'
}

function isModifier(code: string): boolean {
  return /^(Meta|Control|Alt|Shift)(Left|Right)?$/.test(code)
}

function eventToAccelerator(e: KeyboardEvent, platform: string): string | null {
  if (isModifier(e.code)) return null
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Control')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push(platform === 'darwin' ? 'Command' : 'Super')

  let key = CODE_TO_KEY[e.code]
  if (!key) {
    if (/^Key([A-Z])$/.test(e.code)) key = e.code.slice(3)
    else if (/^Digit(\d)$/.test(e.code)) key = e.code.slice(5)
    else if (/^Numpad(\d)$/.test(e.code)) key = `num${e.code.slice(6)}`
    else if (/^F\d{1,2}$/.test(e.code)) key = e.code
    else return null
  }
  return [...mods, key].join('+')
}

export function HotkeyRecorder({
  value,
  onChange,
  platform = 'darwin'
}: {
  value: string[]
  onChange: (hotkeys: string[]) => void
  platform?: string
}) {
  const [recording, setRecording] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const stop = useCallback(() => setRecording(false), [])

  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        stop()
        return
      }
      const acc = eventToAccelerator(e, platform)
      if (!acc) return
      onChange([...new Set([...value, acc])])
      stop()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, onChange, platform, value, stop])

  return (
    <div className="hotkey-recorder" ref={containerRef}>
      <div className="hotkey-list">
        {value.length === 0 ? (
          <span className="hotkey-empty">未设置</span>
        ) : (
          value.map((acc) => (
            <span key={acc} className="hotkey-chip">
              <code>{acc}</code>
              <button
                type="button"
                className="hotkey-remove"
                onClick={() => onChange(value.filter((h) => h !== acc))}
                aria-label={`移除 ${acc}`}
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>
      <button
        type="button"
        className={`btn btn-ghost${recording ? ' recording' : ''}`}
        onClick={() => setRecording((r) => !r)}
      >
        {recording ? '按下快捷键… (Esc 取消)' : '录制'}
      </button>
    </div>
  )
}
