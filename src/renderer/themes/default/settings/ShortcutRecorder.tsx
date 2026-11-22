import { useEffect, useId, useRef, useState } from 'react'
import { IS_MAC, IS_WINDOWS } from '@shared/platform'
import { useI18n } from '@renderer/hooks/useI18n'
import { shellApi } from '@renderer/services/shellApi'
import { ShortcutCapture, formatAccelerator } from './shortcutCapture'

/** Clicking or focusing the field captures a chord; only key release commits the draft. */
export function ShortcutRecorder({ value, onChange, disabled = false, label, compact = false, autoStart = false, onRecordingChange }: {
  value: string
  onChange(value: string): void
  disabled?: boolean
  label?: string
  /** 内联在卡片里时收窄间距、隐藏说明行（卡片自带脚注） */
  compact?: boolean
  /** 挂载即开始录制（点击卡片进入录制态的入口） */
  autoStart?: boolean
  onRecordingChange?(active: boolean): void
}) {
  const { t } = useI18n()
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
      onError: cause => setError(cause instanceof Error ? cause.message : t('settings.shortcutRecorder.recordFailed')),
      platform: IS_MAC ? 'darwin' : IS_WINDOWS ? 'win32' : 'linux',
      target: window
    })
    capture.current = session
    return () => { session.dispose(); callbacks.current.onRecordingChange?.(false) }
    // t 随 locale 变化但录制错误文案无需响应语言切换，此处不重建录制会话。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => { if (disabled) void capture.current?.stop() }, [disabled])
  // 卡片点击进入录制：挂载后由用户手势直接开始，无需再点输入框。
  useEffect(() => { if (autoStart && !disabled) void capture.current?.start() }, [autoStart, disabled])
  const start = (): void => {
    if (disabled || phase === 'restoring') return
    setError('')
    void capture.current?.start()
  }
  const active = phase !== 'idle'
  return (
    <div className={`shortcut-recorder${active ? ' is-recording' : ''}${compact ? ' is-compact' : ''}`}>
      <div className="shortcut-recorder-input">
        <input aria-label={label} aria-describedby={compact ? undefined : hintId} aria-invalid={!!error} readOnly
          value={formatAccelerator(active ? preview : value)} disabled={disabled}
          placeholder={phase === 'starting' ? t('settings.shortcutRecorder.preparing') : active ? t('settings.shortcutRecorder.pressKeys') : t('settings.shortcutRecorder.clickToRecord')}
          autoComplete="off" spellCheck={false} onFocus={start} onClick={start}
          onBlur={() => void capture.current?.stop()} />
        <span className="shortcut-recorder-indicator" aria-hidden="true">{active ? '●' : '⌨'}</span>
      </div>
      {!compact && <p className="desc" id={hintId} role="status">{phase === 'restoring' ? t('settings.shortcutRecorder.restoring')
        : phase === 'starting' ? t('settings.shortcutRecorder.preparingRecord') : active ? t('settings.shortcutRecorder.recording')
          : t('settings.shortcutRecorder.idleHint')}</p>}
      {error && <p className="shortcut-error" role="alert">{error}</p>}
    </div>
  )
}
