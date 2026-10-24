import { useCallback, useEffect, useState } from 'react'
import type { ShortcutProbeResult } from '@shared/types/shortcuts'
import { shellApi } from '@renderer/services/shellApi'

/** A probe belongs to one completed chord; stale replies never authorize a different input. */
export function useShortcutProbe(value: string, recording: boolean, target: 'quick' | 'plugin', excludeId?: string) {
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<{ key: string; probe?: ShortcutProbeResult; error?: string }>({ key: '' })
  const key = JSON.stringify([value, target, excludeId, revision])
  const recheck = useCallback(() => setRevision(current => current + 1), [])
  useEffect(() => shellApi.onEvent(payload => {
    if (payload.type === 'plugin-shortcuts-changed') recheck()
  }), [recheck])
  useEffect(() => {
    if (recording || !value) return
    let cancelled = false
    void (async () => {
      try {
        let probe: ShortcutProbeResult
        if (target === 'quick') {
          if (!shellApi.quickProbeHotkey) throw new Error('当前版本不支持快捷键检查')
          const result = await shellApi.quickProbeHotkey(value)
          probe = result.conflict ?? { accelerator: result.acc, status: result.free ? 'free' : 'system', hint: result.hint }
        } else {
          probe = await shellApi.probePluginShortcut(value, excludeId)
        }
        if (!cancelled) setState({ key, probe })
      } catch (cause) {
        if (!cancelled) setState({ key, error: cause instanceof Error ? cause.message : '检查失败，请重试' })
      }
    })()
    return () => { cancelled = true }
  }, [key, value, recording, target, excludeId])
  const current = !recording && value && state.key === key ? state : undefined
  return { probe: current?.probe, error: current?.error, checking: !!value && !recording && !current, recheck }
}
