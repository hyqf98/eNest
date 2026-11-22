import { useCallback, useEffect, useState } from 'react'
import type { ShortcutProbeResult } from '@shared/types/shortcuts'
import { useI18n } from '@renderer/hooks/useI18n'
import { shellApi } from '@renderer/services/shellApi'

/** A probe belongs to one completed chord; stale replies never authorize a different input. */
export function useShortcutProbe(value: string, recording: boolean, target: 'quick' | 'plugin', excludeId?: string) {
  const { t } = useI18n()
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<{ key: string; probe?: ShortcutProbeResult; error?: string }>({ key: '' })
  /** best-effort 外部占用者识别结果；label 为空表示已检查但无法识别 */
  const [ownerHint, setOwnerHint] = useState<{ accelerator: string; label: string; hint: string } | undefined>()
  const key = JSON.stringify([value, target, excludeId, revision])
  const recheck = useCallback(() => setRevision(current => current + 1), [])
  useEffect(() => shellApi.onEvent(payload => {
    if (payload.type === 'plugin-shortcuts-changed') recheck()
    else if (payload.type === 'system-hotkey-owner-identified') setOwnerHint(payload)
  }), [recheck])
  useEffect(() => { setOwnerHint(undefined) }, [value])
  useEffect(() => {
    if (recording || !value) return
    let cancelled = false
    void (async () => {
      try {
        let probe: ShortcutProbeResult
        if (target === 'quick') {
          if (!shellApi.quickProbeHotkey) throw new Error(t('settings.shortcutProbe.probeUnsupported'))
          const result = await shellApi.quickProbeHotkey(value)
          probe = result.conflict ?? { accelerator: result.acc, status: result.free ? 'free' : 'system', hint: result.hint }
        } else {
          probe = await shellApi.probePluginShortcut(value, excludeId)
        }
        if (!cancelled) setState({ key, probe })
      } catch (cause) {
        if (!cancelled) setState({ key, error: cause instanceof Error ? cause.message : t('settings.shortcutProbe.probeFailed') })
      }
    })()
    return () => { cancelled = true }
  }, [key, value, recording, target, excludeId, t])
  const current = !recording && value && state.key === key ? state : undefined
  const matched = ownerHint && current?.probe && current.probe.status === 'system'
    && ownerHint.accelerator === current.probe.accelerator ? ownerHint : undefined
  const identified = matched && matched.label ? matched : undefined
  return {
    probe: current?.probe ? (identified ? { ...current.probe, ownerLabel: identified.label, hint: identified.hint } : current.probe) : undefined,
    ownerIdentified: !!identified,
    /** 已尝试识别（无论是否识别出名称）；未完成时 UI 显示「正在识别」 */
    ownerChecked: !!matched,
    error: current?.error, checking: !!value && !recording && !current, recheck
  }
}
