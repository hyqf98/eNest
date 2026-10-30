import { useCallback, useEffect, useRef, useState } from 'react'
import { shellApi } from '@renderer/services/shellApi'
import { notify } from '@renderer/services/notifyService'
import type { ShellSettingsSection as PluginSettingsSection } from '@shared/types/shell'

/** Keep native snapshots, pending drafts and serialized writes in the same page lifetime. */
export function usePluginSettings() {
  /** 插件 settings.register 注入的 section 与持久化值 */
  const [pluginSections, setPluginSections] = useState<PluginSettingsSection[]>([])
  const [pluginSettings, setPluginSettings] = useState<Record<string, Record<string, unknown>>>({})
  const confirmedPluginSettings = useRef<Record<string, Record<string, unknown>>>({})
  const pendingPluginSettings = useRef(new Map<string, { revision: number; pluginId: string; key: string; value: unknown }>())
  const pluginSettingWriteRevision = useRef(0)
  const pluginSettingReadRevision = useRef(0)
  const pluginSettingWrites = useRef<Promise<void>>(Promise.resolve())
  const pluginSettingsMounted = useRef(false)
  const publishPluginSettings = useCallback(() => {
    if (!pluginSettingsMounted.current) return
    const next = { ...confirmedPluginSettings.current }
    for (const pending of pendingPluginSettings.current.values()) {
      next[pending.pluginId] = { ...next[pending.pluginId], [pending.key]: pending.value }
    }
    setPluginSettings(next)
  }, [])
  const refreshPluginSettings = useCallback(async () => {
    if (!pluginSettingsMounted.current) return
    const revision = ++pluginSettingReadRevision.current
    const settings = await shellApi.getSettings()
    if (!pluginSettingsMounted.current || revision !== pluginSettingReadRevision.current) return
    confirmedPluginSettings.current = settings.plugins ?? {}
    publishPluginSettings()
  }, [publishPluginSettings])

  /** Native snapshots update confirmed values without erasing an in-flight local edit. */
  useEffect(() => {
    let cancelled = false
    let sectionsRevision = 0
    pluginSettingsMounted.current = true
    const loadSections = async () => {
      const revision = ++sectionsRevision
      const sections = await shellApi.getSettingsSections?.()
      if (!cancelled && revision === sectionsRevision && sections) setPluginSections(sections)
    }
    const off = shellApi.onEvent?.((payload) => {
      if (payload.type === 'settings-sections') {
        sectionsRevision++
        setPluginSections(payload.sections ?? [])
      }
      if (payload.type === 'plugin-settings-changed' || payload.type === 'settings-sections' || payload.type === 'plugins-changed') {
        void refreshPluginSettings().catch(() => undefined)
      }
      if (payload.type === 'plugins-changed' || payload.type === 'contributions-changed' && payload.slot === 'settings') {
        void loadSections().catch(() => undefined)
      }
    })
    void refreshPluginSettings().catch(() => undefined)
    void loadSections().catch(() => undefined)
    return () => {
      cancelled = true
      pluginSettingsMounted.current = false
      pluginSettingReadRevision.current++
      off?.()
    }
  }, [refreshPluginSettings])

  /** 写入插件单项：优先 setPluginSetting（同步 Bridge），回落 setSettings.plugins */
  const handlePluginSetting = useCallback(
    (pluginId: string, key: string, value: unknown, continuous = false) => {
      const identity = JSON.stringify([pluginId, key]), revision = ++pluginSettingWriteRevision.current
      pendingPluginSettings.current.set(identity, { revision, pluginId, key, value })
      pluginSettingReadRevision.current++
      publishPluginSettings()
      // Keep rapid control changes ordered; a newer queued value supersedes one
      // that has not been sent yet, while acknowledged writes remain rollback-safe.
      const save = pluginSettingWrites.current.then(async () => {
        if (pendingPluginSettings.current.get(identity)?.revision !== revision) return
        if (continuous) {
          await new Promise(resolve => setTimeout(resolve, 120))
          if (pendingPluginSettings.current.get(identity)?.revision !== revision) return
        }
        try {
          if (shellApi.setPluginSetting) {
            await shellApi.setPluginSetting(pluginId, key, value)
          } else {
            const settings = await shellApi.getSettings()
            const bag = { ...(settings.plugins?.[pluginId] ?? {}), [key]: value }
            await shellApi.setSettings({
              plugins: { ...(settings.plugins ?? {}), [pluginId]: bag },
            })
          }
          confirmedPluginSettings.current = { ...confirmedPluginSettings.current,
            [pluginId]: { ...confirmedPluginSettings.current[pluginId], [key]: value } }
        } catch {
          if (pluginSettingsMounted.current) notify.error('插件设置未保存，已保留上次确认的值。')
        } finally {
          pluginSettingReadRevision.current++
          if (pendingPluginSettings.current.get(identity)?.revision === revision) pendingPluginSettings.current.delete(identity)
          publishPluginSettings()
          void refreshPluginSettings().catch(() => undefined)
        }
      })
      pluginSettingWrites.current = save.catch(() => undefined)
    },
    [publishPluginSettings, refreshPluginSettings],
  )

  return { pluginSections, pluginSettings, handlePluginSetting }
}
