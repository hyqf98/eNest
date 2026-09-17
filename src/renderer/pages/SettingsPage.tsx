/**
 * SettingsPage — 设置页
 * 左侧标签（通用/主题/开发者 + 已安装插件动态分组），右侧渲染对应卡片。
 * 通用：语言分段、硬件加速开关、数据目录（只读+打开/复制）、关闭行为、代理、Tab 样式、检查更新。
 * 主题面板挂载 ThemeSettingsSection（模式/主题包/背景/Token）；插件列表来自 shellStore.plugins。
 * 依赖：shellStore、ThemeSettingsSection、useI18n、shellApi。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useShellStore } from '@renderer/stores/shellStore'
import { ThemeSettingsSection } from '@renderer/components/ThemeSettingsSection'
import { FontSettingsSection } from '@renderer/components/FontSettingsSection'
import { AnimationSettingsSection } from '@renderer/components/AnimationSettingsSection'
import { DevConsoleSection } from '@renderer/components/DevConsoleSection'
import { QuickSettingsSection } from '@renderer/components/QuickSettingsSection'
import { LanguageSelect } from '@renderer/components/LanguageSelect'
import { useI18n } from '@renderer/hooks/useI18n'
import type { Locale } from '@renderer/i18n'
import { shellApi } from '@renderer/services/shellApi'
import { toastStore } from '@renderer/hooks/useToast'
import type { ProxyConfig, ProxyType } from '@shared/types/plugin'
import type { UpdateStatePayload } from '@shared/types/ipc'

type CloseBehavior = 'minimize-tray' | 'quit'

/** 插件注册的设置 section（来自 settings-sections 事件 / getSettingsSections） */
interface PluginSettingsItem {
  key: string
  type: string
  label: string
  default?: unknown
  options?: Array<{ label: string; value: unknown }>
}

interface PluginSettingsSection {
  id: string
  title: string
  pluginId: string
  items: PluginSettingsItem[]
}

/** 历史 mock 值 'tray' 归一到共享契约 'minimize-tray' */
function normalizeCloseBehavior(v: unknown): CloseBehavior {
  return v === 'quit' ? 'quit' : 'minimize-tray'
}

function Switch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return <button type="button" className={`switch${on ? ' on' : ''}`} onClick={onToggle} aria-pressed={on} />
}

function Field({
  label,
  desc,
  children,
}: {
  label: string
  desc?: string
  children: React.ReactNode
}) {
  return (
    <div className="field">
      <div>
        <div className="label">{label}</div>
        {desc ? <p className="desc">{desc}</p> : null}
      </div>
      {children}
    </div>
  )
}

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="s-card">
      <h2>{title}</h2>
      {hint ? <p className="hint">{hint}</p> : null}
      {children}
    </div>
  )
}

/** 从 settings 响应中取出 general（兼容扁平 mock / 嵌套主进程两种形状） */
function pickGeneral(settings: Awaited<ReturnType<typeof shellApi.getSettings>>) {
  const g = settings.general ?? {}
  return {
    locale: (g.locale as Locale | undefined) ?? undefined,
    hardwareAcceleration: g.hardwareAcceleration,
    dataRoot: g.dataRoot,
    closeBehavior: normalizeCloseBehavior(g.closeBehavior ?? settings.closeBehavior),
    proxy: (g.proxy as ProxyConfig | undefined) ?? undefined,
  }
}

/** 校验并归一化表单为可写入的 ProxyConfig；不完整返回 null */
function normalizeProxyForm(
  type: ProxyType,
  host: string,
  port: string,
  url: string
): ProxyConfig | null {
  if (type === 'none') return { type: 'none' }
  if (type === 'custom') {
    const u = url.trim()
    if (!u) return null
    try {
      // 允许 socks5:// / http:// 等；URL 构造失败视为非法
      new URL(u)
    } catch {
      return null
    }
    return { type, url: u }
  }
  const h = host.trim()
  const p = Number(port)
  if (!h || !Number.isInteger(p) || p < 1 || p > 65535) return null
  return { type, host: h, port: p }
}

export function SettingsPage() {
  const settingsTab = useShellStore((s) => s.settingsTab)
  const setSettingsTab = useShellStore((s) => s.setSettingsTab)
  const plugins = useShellStore((s) => s.plugins)
  const tabStyle = useShellStore((s) => s.tabStyle)
  const setTabStyle = useShellStore((s) => s.setTabStyle)
  const { t, locale, setLocale } = useI18n()

  const installed = plugins.filter((p) => p.installed)

  const [hwAccel, setHwAccel] = useState(true)
  const [dataRoot, setDataRoot] = useState('')
  const [closeBehavior, setCloseBehavior] = useState<CloseBehavior>('minimize-tray')
  const [loadingGeneral, setLoadingGeneral] = useState(true)
  const [updateState, setUpdateState] = useState<UpdateStatePayload | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const updateBusy = useRef(false)
  const checkingRef = useRef(false)

  const [proxyType, setProxyType] = useState<ProxyType>('none')
  const [proxyHost, setProxyHost] = useState('')
  const [proxyPort, setProxyPort] = useState('')
  const [proxyUrl, setProxyUrl] = useState('')
  const [testingProxy, setTestingProxy] = useState(false)

  /** 插件 settings.register 注入的 section 与持久化值 */
  const [pluginSections, setPluginSections] = useState<PluginSettingsSection[]>([])
  const [pluginSettings, setPluginSettings] = useState<Record<string, Record<string, unknown>>>({})

  /** 读取通用设置 + 硬件加速 + 数据根路径 */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoadingGeneral(true)
      try {
        const settings = await shellApi.getSettings()
        if (cancelled) return
        const general = pickGeneral(settings)
        setCloseBehavior(general.closeBehavior)
        // 代理：优先专用 getProxy，回落 settings.general.proxy
        try {
          const proxy = shellApi.getProxy
            ? await shellApi.getProxy()
            : general.proxy ?? { type: 'none' as const }
          if (!cancelled && proxy) {
            setProxyType(proxy.type ?? 'none')
            setProxyHost(proxy.host ?? '')
            setProxyPort(proxy.port != null ? String(proxy.port) : '')
            setProxyUrl(proxy.url ?? '')
          }
        } catch {
          /* 保持默认直连 */
        }
        if (shellApi.getHardwareAcceleration) {
          const state = await shellApi.getHardwareAcceleration()
          if (!cancelled) setHwAccel(state.enabled !== false)
        } else {
          setHwAccel(general.hardwareAcceleration !== false)
        }
        if (shellApi.getPaths) {
          const paths = await shellApi.getPaths()
          if (!cancelled) setDataRoot(paths.root)
        } else {
          setDataRoot(general.dataRoot ?? '')
        }
      } catch {
        /* 保持本地默认 */
      } finally {
        if (!cancelled) setLoadingGeneral(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /** 插件设置 section + 已持久化值；订阅 settings-sections 实时刷新 */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const settings = await shellApi.getSettings()
        if (!cancelled && settings.plugins) {
          setPluginSettings(settings.plugins as Record<string, Record<string, unknown>>)
        }
      } catch {
        /* ignore */
      }
      if (shellApi.getSettingsSections) {
        try {
          const sections = await shellApi.getSettingsSections()
          if (!cancelled) setPluginSections(sections as PluginSettingsSection[])
        } catch {
          /* ignore */
        }
      }
    })()
    if (!shellApi.onEvent) {
      return () => {
        cancelled = true
      }
    }
    const off = shellApi.onEvent((payload) => {
      if (payload.type === 'settings-sections') {
        setPluginSections((payload.sections as PluginSettingsSection[]) ?? [])
      }
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])

  /** 写入插件单项：优先 setPluginSetting（同步 Bridge），回落 setSettings.plugins */
  const handlePluginSetting = useCallback(
    (pluginId: string, key: string, value: unknown) => {
      setPluginSettings((prev) => ({
        ...prev,
        [pluginId]: { ...(prev[pluginId] ?? {}), [key]: value },
      }))
      void (async () => {
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
        } catch {
          /* 乐观更新；写入失败下次 hydrate 会纠正 */
        }
      })()
    },
    [],
  )

  /** 订阅主进程 update-status 推送，并拉取一次当前状态 */
  useEffect(() => {
    let cancelled = false
    if (shellApi.getUpdateState) {
      void shellApi.getUpdateState().then((s) => {
        if (!cancelled && s) setUpdateState(s)
      })
    }
    if (!shellApi.onEvent) return () => undefined
    const off = shellApi.onEvent((payload) => {
      if (payload.type === 'update-status' && payload.state) {
        setUpdateState(payload.state)
        const st = payload.state.status
        // 通知只在事件侧提示一次，避免与 handleCheckUpdate 结果回调重复
        if (st === 'available') {
          toastStore.getState().push(
            t('toasts.updateAvailable', { version: payload.state.latestVersion ?? '' })
          )
          if (shellApi.downloadUpdate && !updateBusy.current) {
            updateBusy.current = true
            void shellApi.downloadUpdate().finally(() => {
              updateBusy.current = false
            })
          }
        } else if (st === 'not-available' && checkingRef.current) {
          toastStore.getState().push(t('toasts.updateNone'))
          checkingRef.current = false
        } else if (st === 'downloaded') {
          toastStore.getState().push(t('toasts.updateReady'))
        } else if (st === 'error' && payload.state.error) {
          toastStore.getState().push(t('toasts.updateError'))
        }
      }
    })
    return () => {
      cancelled = true
      off()
    }
  }, [t])

  const handleCheckUpdate = useCallback(() => {
    const check = shellApi.checkForUpdates
    if (!check) return
    checkingRef.current = true
    setCheckingUpdate(true)
    void (async () => {
      try {
        const result = await check()
        if (result) setUpdateState(result)
        // 无 IPC 事件时（浏览器 mock）才在此补提示；Electron 由 update-status 事件统一提示
        if (!shellApi.onEvent) {
          if (result?.status === 'not-available') {
            toastStore.getState().push(t('toasts.updateNone'))
          } else if (result?.status === 'error') {
            toastStore.getState().push(t('toasts.updateError'))
          }
        }
      } catch {
        toastStore.getState().push(t('toasts.updateError'))
      } finally {
        checkingRef.current = false
        setCheckingUpdate(false)
      }
    })()
  }, [t])

  const handleInstallUpdate = useCallback(() => {
    if (!shellApi.installUpdate) return
    void shellApi.installUpdate()
  }, [])

  const handleLocale = useCallback(
    (next: Locale) => {
      void setLocale(next)
      toastStore.getState().push(t('toasts.localeChanged'))
    },
    [setLocale, t],
  )

  const handleHwAccel = useCallback(() => {
    const next = !hwAccel
    setHwAccel(next)
    void (async () => {
      try {
        if (shellApi.setHardwareAcceleration) {
          await shellApi.setHardwareAcceleration(next)
        } else {
          await shellApi.setSettings({ general: { hardwareAcceleration: next } })
        }
      } catch {
        /* 忽略写入失败，UI 已乐观更新 */
      }
      toastStore.getState().push(next ? t('toasts.hardwareEnabled') : t('toasts.needRestart'))
    })()
  }, [hwAccel, t])

  const handleCloseBehavior = useCallback(
    (value: CloseBehavior) => {
      setCloseBehavior(value)
      // 契约路径：settings.general.closeBehavior（主进程 SettingsStore 只持久化 general）
      void shellApi.setSettings({
        general: { closeBehavior: value },
      })
    },
    [],
  )

  /** 持久化 + 即时 setProxy；表单不完整时仅提示不落盘 */
  const persistProxy = useCallback(
    (config: ProxyConfig | null, silentIncomplete = false) => {
      if (!config) {
        if (!silentIncomplete) toastStore.getState().push(t('settings.general.proxyInvalid'))
        return
      }
      void (async () => {
        try {
          if (shellApi.setProxy) {
            await shellApi.setProxy(config)
          } else {
            await shellApi.setSettings({ general: { proxy: config } })
          }
          toastStore.getState().push(
            config.type === 'none' ? t('settings.general.proxyCleared') : t('settings.general.proxyApplied')
          )
        } catch {
          toastStore.getState().push(t('settings.general.proxyInvalid'))
        }
      })()
    },
    [t],
  )

  const handleProxyType = useCallback(
    (value: ProxyType) => {
      setProxyType(value)
      if (value === 'none') {
        persistProxy({ type: 'none' })
        return
      }
      // 切到有配置的类型时，若表单已完整则立刻保存；否则等 blur 补齐
      persistProxy(normalizeProxyForm(value, proxyHost, proxyPort, proxyUrl), true)
    },
    [persistProxy, proxyHost, proxyPort, proxyUrl],
  )

  const handleProxyFieldBlur = useCallback(() => {
    if (proxyType === 'none') return
    persistProxy(normalizeProxyForm(proxyType, proxyHost, proxyPort, proxyUrl))
  }, [persistProxy, proxyHost, proxyPort, proxyType, proxyUrl])

  const handleTestProxy = useCallback(() => {
    if (!shellApi.testProxy) return
    const config = normalizeProxyForm(proxyType, proxyHost, proxyPort, proxyUrl)
    if (!config) {
      toastStore.getState().push(t('settings.general.proxyInvalid'))
      return
    }
    setTestingProxy(true)
    void (async () => {
      try {
        const result = await shellApi.testProxy!(config)
        if (result.ok) {
          if (config.type === 'none') {
            toastStore.getState().push(t('settings.general.proxyTestOkDirect'))
          } else {
            toastStore.getState().push(
              t('settings.general.proxyTestOk', { ms: String(result.latencyMs ?? 0) })
            )
          }
        } else {
          toastStore.getState().push(
            t('settings.general.proxyTestFail', { error: result.error ?? 'unknown' })
          )
        }
      } catch (err) {
        toastStore.getState().push(
          t('settings.general.proxyTestFail', { error: (err as Error).message })
        )
      } finally {
        setTestingProxy(false)
      }
    })()
  }, [proxyHost, proxyPort, proxyType, proxyUrl, t])

  /** 优先 openPath；不可用则复制到剪贴板 */
  const handleOpenDataRoot = useCallback(() => {
    if (!dataRoot) return
    void (async () => {
      if (shellApi.openPath) {
        try {
          await shellApi.openPath(dataRoot)
          return
        } catch {
          /* fallthrough 复制 */
        }
      }
      try {
        await navigator.clipboard.writeText(dataRoot)
        toastStore.getState().push(t('toasts.pathCopied'))
      } catch {
        toastStore.getState().push(t('toasts.pathCopied'))
      }
    })()
  }, [dataRoot, t])

  const TABS = [
    { id: 'general', label: t('settings.tabs.general') },
    { id: 'appearance', label: t('settings.tabs.appearance') },
    { id: 'quick', label: '快捷启动' },
    { id: 'dev', label: t('settings.tabs.dev') },
  ] as const

  return (
    <section className="page">
      <div className="settings-shell">
        <div className="settings-header">
          <h1>{t('settings.title')}</h1>
          <p>{t('settings.subtitle')}</p>
        </div>
        <div className="settings-tabs">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={settingsTab === tab.id ? 'active' : ''}
              onClick={() => setSettingsTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
          {installed.map((p) => (
            <button
              key={p.id}
              type="button"
              className={settingsTab === `p:${p.id}` ? 'active' : ''}
              onClick={() => setSettingsTab(`p:${p.id}`)}
            >
              {p.name}
            </button>
          ))}
        </div>

        {settingsTab === 'general' && (
          <Card title={t('settings.general.title')} hint={t('settings.general.hint')}>
            <Field label={t('settings.general.language')} desc={t('settings.general.languageDesc')}>
              <LanguageSelect value={locale} onChange={handleLocale} />
            </Field>
            <Field label={t('settings.general.hardwareAccel')} desc={t('settings.general.hardwareAccelDesc')}>
              <Switch on={hwAccel} onToggle={handleHwAccel} />
            </Field>
            <Field label={t('settings.general.dataRoot')} desc={t('settings.general.dataRootDesc')}>
              <div className="path-actions">
                <code className="path-text" title={dataRoot}>
                  {loadingGeneral ? t('common.loading') : dataRoot || '—'}
                </code>
                <button
                  className="btn btn-ghost btn-sm"
                  type="button"
                  onClick={handleOpenDataRoot}
                  disabled={!dataRoot}
                >
                  {t('settings.general.openFolder')}
                </button>
              </div>
            </Field>
            <Field label={t('settings.general.closeBehavior')} desc={t('settings.general.closeBehaviorDesc')}>
              <select
                value={closeBehavior}
                onChange={(e) => handleCloseBehavior(e.target.value as CloseBehavior)}
              >
                <option value="minimize-tray">{t('settings.general.minimizeToTray')}</option>
                <option value="quit">{t('settings.general.quitApp')}</option>
              </select>
            </Field>
            <Field label={t('settings.general.proxy')} desc={t('settings.general.proxyDesc')}>
              <div className="proxy-row">
                <select
                  value={proxyType}
                  onChange={(e) => handleProxyType(e.target.value as ProxyType)}
                  aria-label={t('settings.general.proxyType')}
                >
                  <option value="none">{t('settings.general.proxyNone')}</option>
                  <option value="http">{t('settings.general.proxyHttp')}</option>
                  <option value="socks5">{t('settings.general.proxySocks5')}</option>
                  <option value="custom">{t('settings.general.proxyCustom')}</option>
                </select>
                {proxyType === 'http' || proxyType === 'socks5' ? (
                  <>
                    <input
                      type="text"
                      className="proxy-host"
                      value={proxyHost}
                      placeholder={t('settings.general.proxyHostPlaceholder')}
                      aria-label={t('settings.general.proxyHost')}
                      onChange={(e) => setProxyHost(e.target.value)}
                      onBlur={handleProxyFieldBlur}
                    />
                    <input
                      type="text"
                      className="proxy-port"
                      value={proxyPort}
                      placeholder={t('settings.general.proxyPortPlaceholder')}
                      aria-label={t('settings.general.proxyPort')}
                      inputMode="numeric"
                      onChange={(e) => setProxyPort(e.target.value.replace(/[^\d]/g, ''))}
                      onBlur={handleProxyFieldBlur}
                    />
                  </>
                ) : null}
                {proxyType === 'custom' ? (
                  <input
                    type="text"
                    className="proxy-url"
                    value={proxyUrl}
                    placeholder={t('settings.general.proxyUrlPlaceholder')}
                    aria-label={t('settings.general.proxyUrl')}
                    onChange={(e) => setProxyUrl(e.target.value)}
                    onBlur={handleProxyFieldBlur}
                  />
                ) : null}
                <button
                  className="btn btn-ghost btn-sm"
                  type="button"
                  onClick={handleTestProxy}
                  disabled={testingProxy || proxyType === 'none'}
                >
                  {testingProxy ? t('settings.general.proxyTesting') : t('settings.general.proxyTest')}
                </button>
              </div>
            </Field>
            <Field label={t('settings.general.tabStyle')} desc={t('settings.general.tabStyleDesc')}>
              <div className="segmented tab-style-seg" role="group" aria-label={t('settings.general.tabStyle')}>
                <button
                  type="button"
                  className={tabStyle === 'classic' ? 'active' : ''}
                  onClick={() => setTabStyle('classic')}
                >
                  <span className="tab-style-icon classic-icon" aria-hidden="true">
                    <i />
                    <i />
                  </span>
                  {t('settings.general.tabStyleClassic')}
                </button>
                <button
                  type="button"
                  className={tabStyle === 'orb' ? 'active' : ''}
                  onClick={() => setTabStyle('orb')}
                >
                  <span className="tab-style-icon orb-icon" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  {t('settings.general.tabStyleOrb')}
                </button>
              </div>
            </Field>
            <Field
              label={t('settings.general.updates')}
              desc={
                updateState?.status === 'downloading'
                  ? t('settings.general.updateDownloading', {
                      progress: String(updateState.progress ?? 0)
                    })
                  : updateState?.status === 'downloaded'
                    ? t('settings.general.updateReadyDesc', {
                        version: updateState.latestVersion ?? ''
                      })
                    : updateState?.status === 'available'
                      ? t('settings.general.updateAvailableDesc', {
                          version: updateState.latestVersion ?? ''
                        })
                      : t('settings.general.updatesDesc', {
                          version: updateState?.currentVersion ?? '—'
                        })
              }
            >
              <div className="path-actions">
                <button
                  className="btn btn-ghost btn-sm"
                  type="button"
                  onClick={handleCheckUpdate}
                  disabled={checkingUpdate || updateState?.status === 'downloading'}
                >
                  {checkingUpdate || updateState?.status === 'checking'
                    ? t('settings.general.checkingUpdate')
                    : t('settings.general.checkUpdate')}
                </button>
                {updateState?.status === 'downloaded' && (
                  <button className="btn btn-primary btn-sm" type="button" onClick={handleInstallUpdate}>
                    {t('settings.general.installUpdate')}
                  </button>
                )}
              </div>
            </Field>
          </Card>
        )}

        {settingsTab === 'general' && <AnimationSettingsSection />}

        {settingsTab === 'appearance' && (
          <>
            <ThemeSettingsSection />
            <FontSettingsSection />
          </>
        )}

        {settingsTab === 'quick' && <QuickSettingsSection />}

        {settingsTab === 'dev' && <DevConsoleSection />}

        {settingsTab.startsWith('p:') &&
          (() => {
            const id = settingsTab.slice(2)
            const p = installed.find((x) => x.id === id)
            if (!p) return null
            const sections = pluginSections.filter((s) => s.pluginId === id)
            const values = pluginSettings[id] ?? {}
            const renderValue = (item: PluginSettingsItem) => {
              const raw = item.key in values ? values[item.key] : item.default
              if (item.type === 'boolean' || item.type === 'bool' || item.type === 'switch') {
                return (
                  <Switch
                    on={raw !== false && raw != null}
                    onToggle={() => handlePluginSetting(id, item.key, !(raw !== false && raw != null))}
                  />
                )
              }
              if (item.type === 'select' && Array.isArray(item.options) && item.options.length > 0) {
                return (
                  <select
                    value={raw === undefined || raw === null ? '' : String(raw)}
                    onChange={(e) => {
                      const opt = item.options?.find((o) => String(o.value) === e.target.value)
                      handlePluginSetting(id, item.key, opt ? opt.value : e.target.value)
                    }}
                  >
                    {item.options.map((o) => (
                      <option key={String(o.value)} value={String(o.value)}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                )
              }
              if (item.type === 'number') {
                return (
                  <input
                    type="number"
                    defaultValue={raw === undefined || raw === null ? '' : String(raw)}
                    onBlur={(e) => {
                      const n = Number(e.target.value)
                      if (!Number.isNaN(n)) handlePluginSetting(id, item.key, n)
                    }}
                  />
                )
              }
              // string / text / 默认
              return (
                <input
                  type="text"
                  defaultValue={raw === undefined || raw === null ? '' : String(raw)}
                  onBlur={(e) => handlePluginSetting(id, item.key, e.target.value)}
                />
              )
            }
            return (
              <Card title={p.name} hint={t('settings.pluginSection.hint')}>
                {sections.length === 0 ? (
                  <p className="desc">{t('settings.pluginSection.empty')}</p>
                ) : (
                  sections.map((section) => (
                    <div key={section.id} className="plugin-settings-section">
                      {section.title ? <h3 className="label">{section.title}</h3> : null}
                      {section.items.map((item) => (
                        <Field key={item.key} label={item.label}>
                          {renderValue(item)}
                        </Field>
                      ))}
                    </div>
                  ))
                )}
              </Card>
            )
          })()}
      </div>
    </section>
  )
}
