import type { ShortcutProbeResult } from '@shared/types/shortcuts'
import { useI18n } from '@renderer/hooks/useI18n'
import { formatAccelerator } from './shortcutCapture'

export function useDescribeShortcutProbe(): (probe: ShortcutProbeResult) => string {
  const { t } = useI18n()
  return (probe: ShortcutProbeResult) => {
    const owner = probe.ownerLabel || probe.ownerPluginId
    const ownerText = owner ? `「${owner}」` : ''
    if (probe.status === 'free') return probe.hint || t('settings.shortcutProbe.free')
    if (probe.status === 'quick') return t('settings.shortcutProbe.occupiedByQuick')
    if (probe.status === 'shortcut') return owner
      ? t('settings.shortcutProbe.occupiedByPlugin', { owner: ownerText })
      : t('settings.shortcutProbe.occupiedByPluginUnnamed')
    if (probe.status === 'runtime') return owner
      ? t('settings.shortcutProbe.occupiedByRuntime', { owner: ownerText })
      : t('settings.shortcutProbe.occupiedByRuntimeUnnamed')
    // system：forceable 时提示可强制接管；识别出占用者时给出具体指引。
    if (owner) return t('settings.shortcutProbe.systemOwnerKnown', { owner: ownerText, hint: probe.hint ?? '' })
    return probe.hint || (probe.status === 'invalid'
      ? t('settings.shortcutProbe.invalidKeys')
      : t('settings.shortcutProbe.systemOccupied'))
  }
}

export function ShortcutProbeFeedback({ probe, checking, error, inactive = false, disabled = false, ownerIdentified = false, ownerChecked = false, onConfirm, onForce, onRetry }: {
  probe?: ShortcutProbeResult
  checking?: boolean
  error?: string
  inactive?: boolean
  disabled?: boolean
  /** system 占用者已被 best-effort 识别（显示具体指引而非通用文案） */
  ownerIdentified?: boolean
  /** 已尝试识别（无论成功与否）；未完成时显示「正在识别」 */
  ownerChecked?: boolean
  onConfirm?(token: string): void
  /** 强制接管被外部占用的组合键（Windows 低级键盘钩子） */
  onForce?(): void
  onRetry?(): void
}) {
  const { t } = useI18n()
  const describe = useDescribeShortcutProbe()
  if (checking) return <p className="shortcut-probe" role="status">{t('settings.shortcutProbe.checking')}</p>
  if (error) return <div className="shortcut-probe is-conflict" role="alert">{error}{onRetry && <button type="button" className="btn btn-ghost" onClick={onRetry}>{t('settings.shortcutProbe.recheck')}</button>}</div>
  if (!probe) return null
  if (probe.status === 'free') return <p className="shortcut-probe is-free" role="status">{probe.hint || t('settings.shortcutProbe.free')}</p>
  const isSystem = probe.status === 'system'
  const canForce = isSystem && !!probe.forceable && !!onForce && !disabled
  return <div className="shortcut-probe is-conflict" role="alert">
    <div><strong>{formatAccelerator(probe.accelerator)} · {describe(probe)}</strong>
      {isSystem && !ownerIdentified && !ownerChecked && <p>{t('settings.shortcutProbe.identifyingOwner')}{onRetry && <button type="button" className="btn btn-ghost" onClick={onRetry}>{t('settings.shortcutProbe.recheck')}</button>}</p>}
      {isSystem && !ownerIdentified && ownerChecked && <p>{t('settings.shortcutProbe.ownerUnknown', {
        suffix: canForce ? t('settings.shortcutProbe.ownerUnknownForceSuffix') : t('settings.shortcutProbe.ownerUnknownEnd')
      })}{onRetry && <button type="button" className="btn btn-ghost" onClick={onRetry}>{t('settings.shortcutProbe.recheck')}</button>}</p>}
      {isSystem && ownerIdentified && !probe.forceable && <p>{t('settings.shortcutProbe.closeOwnerHint')}{onRetry && <button type="button" className="btn btn-ghost" onClick={onRetry}>{t('settings.shortcutProbe.recheck')}</button>}</p>}
      {canForce && <p>{t('settings.shortcutProbe.forceExplain')}</p>}
      {probe.overrideToken && <p>{inactive ? t('settings.shortcutProbe.confirmInactive')
        : probe.status === 'quick' ? t('settings.shortcutProbe.confirmQuick')
          : t('settings.shortcutProbe.confirmPlugin')}</p>}</div>
    {canForce && <button type="button" className="btn btn-primary" onClick={onForce}>{t('settings.shortcutProbe.forceOverride')}</button>}
    {!inactive && probe.overrideToken && onConfirm && <button type="button" className="btn btn-primary" disabled={disabled}
      onClick={() => onConfirm(probe.overrideToken!)}>{t('settings.shortcutProbe.confirmOverride')}</button>}
  </div>
}
