import { useCallback, useEffect, useRef, useState } from 'react'
import type { QuickHotkeyConfig } from '@shared/types/quick'
import type { ShortcutProbeResult } from '@shared/types/shortcuts'
import { shellApi } from '@renderer/services/shellApi'
import { notify } from '@renderer/services/notifyService'
import { HotkeyPresetCards } from './HotkeyPresetCards'
import { PluginShortcutSettings } from './PluginShortcutSettings'
import { ShortcutProbeFeedback } from './ShortcutProbeFeedback'
import { Switch } from '@renderer/components/ui/Switch'
import './shortcutSettings.css'

export function QuickSettingsSection() {
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
      if (!shellApi.quickGetConfig) throw new Error('当前版本不支持 Quick 快捷键设置')
      const next = await shellApi.quickGetConfig()
      if (revision === request.current) { setConfig(next); if (clearError) setError('') }
    } catch (cause) {
      if (revision === request.current) setError((cause as Error).message)
    } finally {
      if (revision === request.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    void refresh(true)
    const off = shellApi.onEvent(payload => {
      if (payload.type === 'plugin-shortcuts-changed') void refresh()
    })
    return () => { request.current++; off() }
  }, [refresh])

  const apply = async (enabled: boolean, hotkeys: string[], activeHotkey: string, overrideToken?: string): Promise<void> => {
    if (busy.current || !shellApi.quickSetHotkeys) return
    busy.current = true
    setSaving(true)
    setError('')
    setPending(null)
    try {
      const result = await shellApi.quickSetHotkeys({ enabled, hotkeys, activeHotkey, overrideToken })
      // The authoritative result may retain the old key when replacement failed.
      setConfig(current => ({ ...current!, enabled: result.enabled, hotkeys: result.hotkeys,
        activeHotkey: result.activeHotkey, registered: result.registered, error: result.error,
        systemConfirmationRequired: result.systemConfirmationRequired }))
      if (!result.ok) {
        setError(result.error || `快捷键注册失败：${result.failed.join('、')}`)
        if (result.probe?.overrideToken) setPending({ enabled, hotkeys, activeHotkey, probe: result.probe })
      }
      else if (!enabled) notify.success('Quick 呼出键已关闭，插件绑定仍可使用')
      else if (result.systemConfirmationRequired) notify.info('已提交系统，请完成系统授权后测试快捷键')
      else if (result.registered.length) notify.success(`Quick 呼出键已生效：${result.activeHotkey}`)
      else notify.info(result.error || '配置已保存，快捷键暂未生效')
    } catch (cause) { setError((cause as Error).message) }
    finally { busy.current = false; setSaving(false) }
  }

  return (
    <div className="shortcut-settings">
      <section className="s-card" aria-label="Quick 呼出键">
        <h2>Quick 呼出键</h2>
        {loading ? <p className="hint" role="status">正在读取快捷键…</p> : config && <>
          <div className="field">
            <div><div className="label">启用 Quick 呼出键</div><p className="desc">仅控制搜索小窗口的呼出键，不影响插件快捷键</p></div>
            <Switch checked={config.enabled} aria-label="启用 Quick 呼出键" disabled={saving}
              onCheckedChange={() => void apply(!config.enabled, config.hotkeys, config.activeHotkey ?? '')} />
          </div>
          <div className="quick-hotkey-block">
            <HotkeyPresetCards hotkeys={config.hotkeys} activeHotkey={config.activeHotkey ?? ''}
              registered={config.registered ?? []} disabled={saving} enabled={config.enabled}
              systemConfirmationRequired={config.systemConfirmationRequired}
              onChange={(keys, active, token) => void apply(config.enabled, keys, active, token)} />
          </div>
          {config.error && !error && !pending && <p className="shortcut-error" role="status">{config.error}</p>}
        </>}
        {pending && <div className="shortcut-pending-confirmation">
          <ShortcutProbeFeedback probe={pending.probe} disabled={saving}
            onConfirm={token => void apply(pending.enabled, pending.hotkeys, pending.activeHotkey, token)} />
          <button type="button" className="btn btn-ghost" disabled={saving} onClick={() => setPending(null)}>取消，保留原设置</button>
        </div>}
        {error && <p className="shortcut-error" role="alert">{error} {!config && <button type="button" className="btn btn-ghost" onClick={() => void refresh(true)}>重试</button>}</p>}
      </section>
      <PluginShortcutSettings />
    </div>
  )
}
