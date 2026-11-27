/** Default-theme settings navigation; tab state and subscriptions share the page lifetime. */
import { lazy, Suspense, useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'
import { useShellStore } from '@renderer/stores/shellStore'
import { useI18n } from '@renderer/hooks/useI18n'
import { SettingsTabs } from './SettingsTabs'
import { GeneralSettingsSection } from './GeneralSettingsSection'
import { PluginSettingsSection } from './PluginSettingsSection'
import { useGeneralSettings } from './useGeneralSettings'
import { usePluginSettings } from './usePluginSettings'
import { useSettingsUpdates } from './useSettingsUpdates'
import { PluginIcon } from '@renderer/components/PluginIcon'
import { SettingsIcon, UserIcon, PaletteIcon, KeyboardIcon, TerminalIcon, DatabaseIcon } from '@renderer/components/icons'
import './pluginSettings.css'
import './settings.css'

const ProfileSection = lazy(() => import('./ProfileSection').then(module => ({ default: module.ProfileSection })))
const AppearanceSettingsSection = lazy(() => import('./AppearanceSettingsSection').then(module => ({ default: module.AppearanceSettingsSection })))
const DevConsoleSection = lazy(() => import('./DevConsoleSection').then(module => ({ default: module.DevConsoleSection })))
const PluginDataSection = lazy(() => import('./PluginDataSection').then(module => ({ default: module.PluginDataSection })))
const McpServiceSection = lazy(() => import('./McpServiceSection').then(module => ({ default: module.McpServiceSection })))
const QuickSettingsSection = lazy(() => import('./QuickSettingsSection').then(module => ({ default: module.QuickSettingsSection })))
const PluginMemorySection = lazy(() => import('./PluginMemorySection').then(module => ({ default: module.PluginMemorySection })))
const DefaultAppsSection = lazy(() => import('./DefaultAppsSection').then(module => ({ default: module.DefaultAppsSection })))

export function DefaultSettingsPage() {
  const settingsTab = useShellStore((s) => s.settingsTab)
  const setSettingsTab = useShellStore((s) => s.setSettingsTab)
  const plugins = useShellStore((s) => s.plugins)
  const { t } = useI18n()
  const installed = plugins.filter((p) => p.installed)

  const general = useGeneralSettings()
  const { pluginSections, pluginSettings, handlePluginSetting } = usePluginSettings()
  const updates = useSettingsUpdates()

  /**
   * Only plugins that actually contribute settings get a tab: a manifest
   * `contributes.settings` declaration or a runtime `settings.register` section.
   * Installed-but-silent plugins no longer add an empty settings entry.
   */
  const pluginsWithSettings = useMemo(() => new Set(pluginSections.map(section => section.pluginId)), [pluginSections])
  const settingsPlugins = useMemo(
    () => installed.filter(plugin => (plugin.contributes?.settings?.length ?? 0) > 0 || pluginsWithSettings.has(plugin.id)),
    [installed, pluginsWithSettings],
  )

  /** Drop the tab when the plugin is uninstalled or stops contributing settings. */
  useEffect(() => {
    if (
      settingsTab.startsWith('p:') &&
      !settingsPlugins.some((p) => `p:${p.id}` === settingsTab)
    ) {
      setSettingsTab('general')
    }
  }, [settingsTab, settingsPlugins, setSettingsTab])

  const TABS = [
    { id: 'general', label: t('settings.tabs.general'), icon: <SettingsIcon size={14} strokeWidth={1.7} /> },
    { id: 'profile', label: t('settings.tabs.profile'), icon: <UserIcon size={14} strokeWidth={1.7} /> },
    { id: 'appearance', label: t('settings.tabs.appearance'), icon: <PaletteIcon size={14} strokeWidth={1.7} /> },
    { id: 'quick', label: t('settings.tabs.quick'), icon: <KeyboardIcon size={14} strokeWidth={1.7} /> },
    { id: 'dev', label: t('settings.tabs.dev'), icon: <TerminalIcon size={14} strokeWidth={1.7} /> },
    { id: 'plugin-data', label: t('settings.tabs.pluginData'), icon: <DatabaseIcon size={14} strokeWidth={1.7} /> },
  ] as const

  const allTabs = [
    ...TABS.map((x) => ({ id: x.id as string, label: x.label, icon: x.icon as ReactNode })),
    ...settingsPlugins.map((p) => ({
      id: `p:${p.id}`,
      label: p.name,
      icon: <PluginIcon className="settings-tab-plugin-icon" slot="tab" size={16} src={p.icon ?? undefined} glyph={p.glyph} style={{ background: p.color }} />,
    })),
  ]
  const selectedPlugin = settingsTab.startsWith('p:')
    ? installed.find(plugin => plugin.id === settingsTab.slice(2)) : undefined

  return (
    <section className="page page-settings" data-scrollbar="auto-hide">
      <div className="settings-shell">
        <div className="settings-header">
          <h1>{t('settings.title')}</h1>
        </div>
        <SettingsTabs
          tabs={allTabs}
          active={settingsTab}
          moreLabel={t('settings.tabs.more')}
          collapseLabel={t('settings.tabs.collapse')}
          onChange={setSettingsTab}
        />

        {/* 懒加载区块的占位只画空壳：首进「通用」要等三个 chunk，短暂空白无感，
            一闪而过的「加载中」文字才会被眼睛捕获。 */}
        <Suspense fallback={<div className="settings-section-loading" role="status" aria-busy="true" />}>
        {settingsTab === 'profile' && <ProfileSection />}
        {settingsTab === 'general' && <GeneralSettingsSection settings={general} updates={updates} />}

        {settingsTab === 'general' && <DefaultAppsSection />}

        {settingsTab === 'general' && <McpServiceSection />}

        {settingsTab === 'general' && <PluginMemorySection />}

        {settingsTab === 'appearance' && <AppearanceSettingsSection />}

        {settingsTab === 'quick' && <QuickSettingsSection />}

        {settingsTab === 'dev' && <DevConsoleSection />}

        {settingsTab === 'plugin-data' && <PluginDataSection />}

        {selectedPlugin && <PluginSettingsSection
          key={selectedPlugin.id}
          pluginId={selectedPlugin.id}
          title={selectedPlugin.name}
          sections={pluginSections.filter(section => section.pluginId === selectedPlugin.id)}
          values={pluginSettings[selectedPlugin.id] ?? {}}
          onCommit={handlePluginSetting}
        />}
        </Suspense>
      </div>
    </section>
  )
}
