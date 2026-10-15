import { useCallback, useEffect, useRef, useState } from 'react'
import type { QuickHotkeyConfig } from '@shared/types/quick'
import { shellApi } from '@renderer/services/shellApi'
import { notify } from '@renderer/services/notifyService'
import { HotkeyPresetCards } from './HotkeyPresetCards'
import { PluginShortcutSettings } from './PluginShortcutSettings'
import './shortcutSettings.css'

export function QuickSettingsSection() {
  const [config, setConfig] = useState<QuickHotkeyConfig | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const busy = useRef(false)
  const request = useRef(0)
  const refresh = useCallback(async () => {
    const revision = ++request.current
    try {
      if (!shellApi.quickGetConfig) throw new Error('当前版本不支持 Quick 快捷键设置')
      const next = await shellApi.quickGetConfig()
      if (revision === request.current) { setConfig(next); setError('') }
    } catch (cause) {
      if (revision === request.current) setError((cause as Error).message)
    } finally {
      if (revision === request.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    void refresh()
    const off = shellApi.onEvent(payload => {
      if (payload.type === 'plugin-shortcuts-changed') void refresh()
    })
    return () => { request.current++; off() }
  }, [refresh])

  const apply = async (enabled: boolean, hotkeys: string[], activeHotkey: string): Promise<void> => {
    if (busy.current || !shellApi.quickSetHotkeys) return
    busy.current = true
    setSaving(true)
    setError('')
    try {
      const result = await shellApi.quickSetHotkeys({ enabled, hotkeys, activeHotkey })
      // The authoritative result may retain the old key when replacement failed.
      setConfig(current => ({ ...current!, enabled: result.enabled, hotkeys: result.hotkeys,
        activeHotkey: result.activeHotkey, registered: result.registered, error: result.error }))
      if (!result.ok) setError(result.error || `快捷键注册失败：${result.failed.join('、')}`)
      else if (!enabled) notify.success('Quick 呼出键已关闭，插件绑定仍可使用')
      else if (result.registered.length) notify.success(`Quick 呼出键已生效：${result.activeHotkey}`)
      else notify.info(result.error || '配置已保存，快捷键暂未生效')
    } catch (cause) { setError((cause as Error).message) }
    finally { busy.current = false; setSaving(false) }
  }

  return (
    <div className="shortcut-settings">
      <section className="s-card" aria-label="Quick 呼出键">
        <h2>Quick 呼出键</h2>
        <p className="hint">打开搜索小窗口，查找应用和插件。下方插件绑定可直接启动插件，无需搜索。</p>
        {loading ? <p className="hint" role="status">正在读取快捷键…</p> : config && <>
          <div className="field">
            <div><div className="label">启用 Quick 呼出键</div><p className="desc">仅控制搜索小窗口的呼出键，不影响插件快捷键</p></div>
            <button type="button" className={`switch${config.enabled ? ' on' : ''}`} aria-label="启用 Quick 呼出键"
              aria-pressed={config.enabled} disabled={saving}
              onClick={() => void apply(!config.enabled, config.hotkeys, config.activeHotkey ?? '')} />
          </div>
          <div className="quick-hotkey-block">
            <HotkeyPresetCards hotkeys={config.hotkeys} activeHotkey={config.activeHotkey ?? ''}
              registered={config.registered ?? []} disabled={saving}
              onChange={(keys, active) => void apply(config.enabled, keys, active)} />
          </div>
          {config.error && !error && <p className="shortcut-error" role="status">{config.error}</p>}
        </>}
        {error && <p className="shortcut-error" role="alert">{error} {!config && <button type="button" className="btn btn-ghost" onClick={() => void refresh()}>重试</button>}</p>}
      </section>
      <PluginShortcutSettings />
    </div>
  )
}
