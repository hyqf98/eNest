import type { ShortcutProbeResult } from '@shared/types/shortcuts'
import { formatAccelerator } from './shortcutCapture'

export function describeShortcutProbe(probe: ShortcutProbeResult): string {
  const owner = probe.ownerLabel || probe.ownerPluginId
  if (probe.status === 'free') return probe.hint || '未发现快捷键冲突'
  if (probe.status === 'quick') return '此组合键已用于 Quick 呼出键。'
  if (probe.status === 'shortcut') return `此组合键已用于${owner ? `「${owner}」` : '另一条插件'}的快捷键。`
  if (probe.status === 'runtime') return `此组合键由插件${owner ? `「${owner}」` : ''}运行时使用，请换一个组合键。`
  return probe.hint || (probe.status === 'invalid' ? '组合键无效，请重新录制。' : '此组合键已被系统或其他应用占用，无法直接覆盖，请换一个组合键。')
}

export function ShortcutProbeFeedback({ probe, checking, error, inactive = false, disabled = false, onConfirm, onRetry }: {
  probe?: ShortcutProbeResult
  checking?: boolean
  error?: string
  inactive?: boolean
  disabled?: boolean
  onConfirm?(token: string): void
  onRetry?(): void
}) {
  if (checking) return <p className="shortcut-probe" role="status">正在检查快捷键占用…</p>
  if (error) return <div className="shortcut-probe is-conflict" role="alert">{error}{onRetry && <button type="button" className="btn btn-ghost" onClick={onRetry}>重新检查</button>}</div>
  if (!probe) return null
  if (probe.status === 'free') return <p className="shortcut-probe is-free" role="status">{probe.hint || '未发现快捷键冲突'}</p>
  return <div className="shortcut-probe is-conflict" role="alert">
    <div><strong>{formatAccelerator(probe.accelerator)} · {describeShortcutProbe(probe)}</strong>
      {probe.overrideToken && <p>{inactive ? '当前绑定已关闭，保存不会覆盖；启用时需重新确认。'
        : probe.status === 'quick' ? '确认后将关闭原 Quick 呼出键，并将此组合键用于当前设置。'
          : '确认后将停用原快捷键绑定，保留其配置，并将此组合键用于当前设置。'}</p>}</div>
    {!inactive && probe.overrideToken && onConfirm && <button type="button" className="btn btn-primary" disabled={disabled}
      onClick={() => onConfirm(probe.overrideToken!)}>确认覆盖并保存</button>}
  </div>
}
