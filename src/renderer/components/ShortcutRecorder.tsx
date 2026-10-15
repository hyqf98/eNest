import { useEffect, useRef, useState } from 'react'
import { IS_MAC, IS_WINDOWS } from '@shared/platform'
import { shellApi } from '@renderer/services/shellApi'
import { ShortcutCapture } from './shortcutCapture'

/** Shared by Quick and plugin bindings; typing only updates the unsaved draft. */
export function ShortcutRecorder({ value, onChange, disabled = false, label = '快捷键', onRecordingChange }: {
  value: string
  onChange(value: string): void
  disabled?: boolean
  label?: string
  onRecordingChange?(active: boolean): void
}) {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'recording' | 'restoring'>('idle')
  const [error, setError] = useState('')
  const callbacks = useRef({ onChange, onRecordingChange })
  callbacks.current = { onChange, onRecordingChange }
  const capture = useRef<ShortcutCapture>()
  useEffect(() => {
    const session = new ShortcutCapture({
      begin: () => shellApi.beginShortcutCapture(),
      end: token => shellApi.endShortcutCapture(token),
      onPhase: next => { setPhase(next); callbacks.current.onRecordingChange?.(next !== 'idle') },
      onValue: next => { setError(''); callbacks.current.onChange(next) },
      onError: cause => setError(cause instanceof Error ? cause.message : '录制失败，请重试'),
      platform: IS_MAC ? 'darwin' : IS_WINDOWS ? 'win32' : 'linux',
      target: window
    })
    capture.current = session
    return () => { session.dispose(); callbacks.current.onRecordingChange?.(false) }
  }, [])
  useEffect(() => { if (disabled) void capture.current?.stop() }, [disabled])
  return (
    <div className="shortcut-recorder">
      <div className="shortcut-recorder-input">
        <input aria-label={label} value={value} disabled={disabled || phase !== 'idle'}
          placeholder="例如 Control+Shift+K" autoComplete="off" spellCheck={false}
          onChange={event => { setError(''); onChange(event.target.value) }} />
        <button type="button" className="btn btn-ghost" disabled={disabled || phase === 'starting' || phase === 'restoring'}
          onClick={() => { setError(''); if (phase === 'recording') void capture.current?.stop(); else void capture.current?.start() }}>
          {phase === 'restoring' ? '正在恢复…' : phase === 'starting' ? '准备录制…' : phase === 'recording' ? '取消录制' : '录制'}
        </button>
      </div>
      {phase !== 'idle' && <p className="desc" role="status">{phase === 'restoring' ? '正在恢复快捷键…' : phase === 'starting' ? '正在准备…' : '请按组合键 · Esc 取消 · 30 秒内有效'}</p>}
      {error && <p className="shortcut-error" role="alert">{error}</p>}
    </div>
  )
}
