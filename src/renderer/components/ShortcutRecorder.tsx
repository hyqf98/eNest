import { useEffect, useId, useRef, useState } from 'react'
import { IS_MAC, IS_WINDOWS } from '@shared/platform'
import { shellApi } from '@renderer/services/shellApi'
import { ShortcutCapture, formatAccelerator } from './shortcutCapture'

/** Clicking or focusing the field captures a chord; only key release commits the draft. */
export function ShortcutRecorder({ value, onChange, disabled = false, label = '快捷键', onRecordingChange }: {
  value: string
  onChange(value: string): void
  disabled?: boolean
  label?: string
  onRecordingChange?(active: boolean): void
}) {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'recording' | 'restoring'>('idle')
  const [preview, setPreview] = useState('')
  const [error, setError] = useState('')
  const hintId = useId()
  const callbacks = useRef({ onChange, onRecordingChange })
  callbacks.current = { onChange, onRecordingChange }
  const capture = useRef<ShortcutCapture>()
  useEffect(() => {
    const session = new ShortcutCapture({
      begin: () => shellApi.beginShortcutCapture(),
      end: token => shellApi.endShortcutCapture(token),
      onPhase: next => { setPhase(next); callbacks.current.onRecordingChange?.(next !== 'idle') },
      onPreview: setPreview,
      onValue: next => { setError(''); callbacks.current.onChange(next) },
      onError: cause => setError(cause instanceof Error ? cause.message : '录制失败，请重试'),
      platform: IS_MAC ? 'darwin' : IS_WINDOWS ? 'win32' : 'linux',
      target: window
    })
    capture.current = session
    return () => { session.dispose(); callbacks.current.onRecordingChange?.(false) }
  }, [])
  useEffect(() => { if (disabled) void capture.current?.stop() }, [disabled])
  const start = (): void => {
    if (disabled || phase === 'restoring') return
    setError('')
    void capture.current?.start()
  }
  const active = phase !== 'idle'
  return (
    <div className={`shortcut-recorder${active ? ' is-recording' : ''}`}>
      <div className="shortcut-recorder-input">
        <input aria-label={label} aria-describedby={hintId} aria-invalid={!!error} readOnly
          value={formatAccelerator(active ? preview : value)} disabled={disabled}
          placeholder={phase === 'starting' ? '正在准备…' : active ? '请按组合键…' : '点击输入框，按下组合键'}
          autoComplete="off" spellCheck={false} onFocus={start} onClick={start}
          onBlur={() => void capture.current?.stop()} />
        <span className="shortcut-recorder-indicator" aria-hidden="true">{active ? '●' : '⌨'}</span>
      </div>
      <p className="desc" id={hintId} role="status">{phase === 'restoring' ? '正在检查组合键…'
        : phase === 'starting' ? '正在准备录制…' : active ? '正在录制 · 松开主键完成 · Esc 取消'
          : '点击重新录制，需包含 Ctrl、Alt、Command 或 Super 等修饰键'}</p>
      {error && <p className="shortcut-error" role="alert">{error}</p>}
    </div>
  )
}
