import { useCallback, useEffect, useRef, useState } from 'react'
import type { QuickHotkeyConfig } from '@shared/types/quick'
import type { ShortcutProbeResult } from '@shared/types/shortcuts'
import { shellApi } from '@renderer/services/shellApi'
import { notify } from '@renderer/services/notifyService'
import { useI18n } from '@renderer/hooks/useI18n'
import { HotkeyPresetCards, QUICK_PRESET_HOTKEYS } from './HotkeyPresetCards'
import { PluginShortcutSettings } from './PluginShortcutSettings'
import { ShortcutProbeFeedback } from './ShortcutProbeFeedback'
import { Switch } from '@renderer/components/ui/Switch'
import './shortcutSettings.css'

export function QuickSettingsSection() {
  const { t } = useI18n()
  const [config, setConfig] = useState<QuickHotkeyConfig | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [pending, setPending] = useState<{ enabled: boolean; hotkeys: string[]; activeHotkey: string; probe: ShortcutProbeResult } | null>(null)
  const busy = useRef(false)
  const request = useRef(0)
  const refresh = useCallback(async (clearError = false) => {
    const revision = ++request.current
    try {
      if (!shellApi.quickGetConfig) throw new Error(t('settings.quickHotkey.unsupported'))
      const next = await shellApi.quickGetConfig()
      if (revision === request.current) { setConfig(next); if (clearError) setError('') }
    } catch (cause) {
      if (revision === request.current) setError((cause as Error).message)
    } finally {
      if (revision === request.current) setLoading(false)
    }
  }, [t])
  useEffect(() => {
    void refresh(true)
    const off = shellApi.onEvent(payload => {
      if (payload.type === 'plugin-shortcuts-changed' || payload.type === 'quick-config-changed') void refresh()
    })
    return () => { request.current++; off() }
  }, [refresh])

  const apply = async (enabled: boolean, hotkeys: string[], activeHotkey: string, overrideToken?: string, force?: boolean, reset?: boolean): Promise<void> => {
    if (busy.current || !shellApi.quickSetHotkeys) return
    busy.current = true
    setSaving(true)
    setError('')
    setPending(null)
    try {
      const result = await shellApi.quickSetHotkeys({ enabled, hotkeys, activeHotkey, overrideToken, force, reset })
      // The authoritative result may retain the old key when replacement failed.
      setConfig(current => ({ ...current!, enabled: result.enabled, hotkeys: result.hotkeys,
        activeHotkey: result.activeHotkey, registered: result.registered, error: result.error,
        forced: result.forced ?? [],
        systemConfirmationRequired: result.systemConfirmationRequired }))
      if (!result.ok) {
        setError(result.error || t('settings.quickHotkey.registerFailed', { keys: result.failed.join('、') }))
        if (result.probe?.overrideToken || (result.probe?.status === 'system' && result.probe.forceable)) {
          setPending({ enabled, hotkeys, activeHotkey, probe: result.probe })
        }
      }
      else if (!enabled) notify.success(t('settings.quickHotkey.disabledNotify'))
      else if (result.systemConfirmationRequired) notify.info(t('settings.quickHotkey.systemPending'))
      else if (reset) notify.success(t('settings.quickHotkey.resetDone', { key: result.activeHotkey ?? '' }))
      else if (result.forced?.length) notify.success(t('settings.quickHotkey.forcedDone', { key: result.activeHotkey ?? '' }))
      else if (result.registered.length) notify.success(t('settings.quickHotkey.applied', { key: result.activeHotkey ?? '' }))
      else notify.info(result.error || t('settings.quickHotkey.savedNotActive'))
    } catch (cause) { setError((cause as Error).message) }
    finally { busy.current = false; setSaving(false) }
  }

  return (
    <div className="shortcut-settings">
      <section className="s-card" aria-label={t('settings.quickHotkey.cardAria')}>
        <div className="quick-section-head">
          <h2>{t('settings.quickHotkey.title')}</h2>
          {config && <button type="button" className="btn btn-ghost quick-reset-btn" disabled={saving}
            title={t('settings.quickHotkey.resetTitle')}
            onClick={() => void apply(config.enabled, [...QUICK_PRESET_HOTKEYS], QUICK_PRESET_HOTKEYS[0], undefined, false, true)}>{t('settings.quickHotkey.reset')}</button>}
        </div>
        {loading ? <p className="hint" role="status">{t('settings.quickHotkey.loading')}</p> : config && <>
          <div className="field">
            <div><div className="label">{t('settings.quickHotkey.enable')}</div><p className="desc">{t('settings.quickHotkey.enableDesc')}</p></div>
            <Switch checked={config.enabled} aria-label={t('settings.quickHotkey.enable')} disabled={saving}
              onCheckedChange={() => void apply(!config.enabled, config.hotkeys, config.activeHotkey ?? '')} />
          </div>
          <div className="quick-hotkey-block">
            <HotkeyPresetCards hotkeys={config.hotkeys} activeHotkey={config.activeHotkey ?? ''}
              registered={config.registered ?? []} forced={config.forced ?? []} disabled={saving} enabled={config.enabled}
              systemConfirmationRequired={config.systemConfirmationRequired}
              onChange={(keys, active, token, force) => void apply(config.enabled, keys, active, token, force)} />
          </div>
          {config.error && !error && !pending && <p className="shortcut-error" role="status">{config.error}</p>}
        </>}
        {pending && <div className="shortcut-pending-confirmation">
          <ShortcutProbeFeedback probe={pending.probe} disabled={saving} ownerChecked
            onConfirm={token => void apply(pending.enabled, pending.hotkeys, pending.activeHotkey, token)}
            onForce={() => void apply(pending.enabled, pending.hotkeys, pending.activeHotkey, undefined, true)} />
          <button type="button" className="btn btn-ghost" disabled={saving} onClick={() => setPending(null)}>{t('settings.quickHotkey.cancelKeep')}</button>
        </div>}
        {error && <p className="shortcut-error" role="alert">{error} {!config && <button type="button" className="btn btn-ghost" onClick={() => void refresh(true)}>{t('settings.quickHotkey.retry')}</button>}</p>}
      </section>
      <PluginShortcutSettings />
    </div>
  )
}
