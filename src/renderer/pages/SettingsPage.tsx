/**
 * SettingsPage — 设置页
 * 左侧标签（通用/主题/开发者 + 已安装插件动态分组），右侧渲染对应卡片。
 * 通用保留行为、系统和维护设置；全部外观设置由主题包 Schema 在主题 Tab 中渲染。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useShellStore } from '@renderer/stores/shellStore'
import { useUpdateDialogStore } from '@renderer/stores/updateDialogStore'
import { ProfileSection } from '@renderer/components/ProfileSection'
import { AppearanceSettingsSection } from '@renderer/components/AppearanceSettingsSection'
import { useAppearanceStore } from '@renderer/hooks/useAppearance'
import { DevConsoleSection } from '@renderer/components/DevConsoleSection'
import { QuickSettingsSection } from '@renderer/components/QuickSettingsSection'
import { PluginMemorySection } from '@renderer/components/PluginMemorySection'
import { LanguageSelect } from '@renderer/components/LanguageSelect'
import { Select } from '@renderer/components/ui/Select'
import { Switch } from '@renderer/components/ui/Switch'
import { Segmented } from '@renderer/components/ui/Segmented'
import { Button } from '@renderer/components/ui/Button'
import { Input } from '@renderer/components/ui/Input'
import { Slider } from '@renderer/components/ui/Slider'
import { ColorPickerField } from '@renderer/components/ColorPickerField'
import { SettingsTabs } from '@renderer/components/SettingsTabs'
import { useI18n } from '@renderer/hooks/useI18n'
import type { Locale } from '@renderer/i18n'
import { shellApi } from '@renderer/services/shellApi'
import { notify } from '@renderer/services/notifyService'
import { toastStore } from '@renderer/hooks/useToast'
import type { ProxyConfig, ProxyType, SettingsSectionContributionItem as PluginSettingsItem } from '@shared/types/plugin'
import type { ResolvedAppearance, ThemeIdentity, ThemeSettingsField, ThemeSettingValue } from '@shared/types/appearance'
import { DEFAULT_THEME_IDENTITY } from '@shared/theme/builtinThemes'
import type { ShellSettingsSection as PluginSettingsSection } from '@shared/types/shell'
import type { UpdateStatePayload } from '@shared/types/ipc'
import { PLUGIN_CATEGORY_COLOR_DEFAULT } from '@shared/constants'
import '@renderer/components/pluginSettings.css'
import '@renderer/styles/settings.css'

type CloseBehavior = 'minimize-tray' | 'quit'
type NotifyPosition = 'center' | 'bottom-right'

/** 历史 mock 值 'tray' 归一到共享契约 'minimize-tray' */
function normalizeCloseBehavior(v: unknown): CloseBehavior {
  return v === 'quit' ? 'quit' : 'minimize-tray'
}

/** 消息通知位置归一：仅认 center，其余（含缺省）归 bottom-right */
function normalizeNotifyPosition(v: unknown): NotifyPosition {
  return v === 'center' ? 'center' : 'bottom-right'
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

function TopTabBarSection() {
  const appearance = useAppearanceStore((s) => s.appearance)
  const packs = useAppearanceStore((s) => s.packs)
  const hydrated = useAppearanceStore((s) => s.hydrated)
  const { t, locale } = useI18n()
  const [readFailed, setReadFailed] = useState(false)
  const [readAttempt, setReadAttempt] = useState(0)
  const en = locale === 'en-US'

  useEffect(() => {
    let cancelled = false
    if (!hydrated) {
      void useAppearanceStore.getState().hydrate().catch(() => {
        if (!cancelled) setReadFailed(true)
      })
    }
    return () => { cancelled = true }
  }, [hydrated, readAttempt])

  // Navigation preferences use the host's existing profile even while another theme is active.
  const pack = hydrated ? packs.find(candidate => candidate.source === DEFAULT_THEME_IDENTITY.source && candidate.id === DEFAULT_THEME_IDENTITY.id) : undefined
  return (
    <Card
      title={en ? 'Tab bar' : '标签栏'}
      hint={en ? 'Choose top tabs or the floating orb rail. Your choice is global and stays unchanged when switching themes.' : '顶部标签与悬浮圆轨二选一；这是全局设置，切换主题不会改变，会话也不会丢失。'}
    >
      {!hydrated ? (
        <>
          <p className="desc" role="status">{readFailed ? (en ? 'Could not load appearance settings.' : '无法读取外观设置。') : t('common.loading')}</p>
          {readFailed && <Button variant="ghost" size="sm" onClick={() => { setReadFailed(false); setReadAttempt(value => value + 1) }}>{en ? 'Retry' : '重试'}</Button>}
        </>
      ) : pack ? (
        <TopTabBarControls
          key={JSON.stringify([pack.source, pack.id, pack.version, pack.settings.version])}
          appearance={appearance}
          identity={DEFAULT_THEME_IDENTITY}
          fields={pack.settings.groups.flatMap(group => group.fields)}
        />
      ) : (
        <p className="desc" role="status">{en ? 'Host navigation settings are unavailable. Please reload settings.' : '宿主导航设置暂不可用，请重新读取设置。'}</p>
      )}
    </Card>
  )
}

/** Only schema-declared bindings are writable; drafts never mutate the appearance store. */
function TopTabBarControls({ appearance, identity, fields }: {
  appearance: ResolvedAppearance
  identity: ThemeIdentity
  fields: ThemeSettingsField[]
}) {
  const { t, locale } = useI18n()
  const en = locale === 'en-US'
  const fieldFor = (key: string, type: ThemeSettingsField['type']) => fields.find(field => field.binding.target === 'layout' && field.binding.key === key && field.type === type)
  const styleField = fieldFor('tabStyle', 'select')
  const opacityField = fieldFor('tabOpacity', 'slider')
  const autoHideField = fieldFor('tabAutoHide', 'switch')
  const tabStyle = appearance.layout.tabStyle === 'orb' ? 'orb' : 'classic'
  const isClassic = tabStyle === 'classic'
  const min = Math.max(0, opacityField?.min ?? 0)
  const max = Math.min(1, opacityField?.max ?? 1)
  const step = opacityField?.step ?? 0.05
  const opacityEnabled = Boolean(opacityField) && Number.isFinite(min) && Number.isFinite(max) && min < max && Number.isFinite(step) && step > 0
  const [opacityDraft, setOpacityDraft] = useState<number | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const draft = useRef<number | null>(null)
  const draftVersion = useRef(0)
  const requestVersion = useRef(0)
  const mounted = useRef(true)
  const saves = useRef(Promise.resolve())
  const restoreOpacity = useCallback(() => {
    document.documentElement.style.setProperty('--appearance-tab-opacity', String(useAppearanceStore.getState().appearance.layout.tabOpacity ?? 1))
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; restoreOpacity() }
  }, [restoreOpacity])

  useEffect(() => {
    if (draft.current === null) return
    if (!isClassic) {
      draftVersion.current++
      draft.current = null
      setOpacityDraft(null)
      restoreOpacity()
    } else {
      document.documentElement.style.setProperty('--appearance-tab-opacity', String(draft.current))
    }
  }, [appearance, isClassic, restoreOpacity])

  const commit = (field: ThemeSettingsField | undefined, value: ThemeSettingValue, opacityVersion?: number) => {
    if (!field) return
    const request = ++requestVersion.current
    setSaveFailed(false)
    // Serialize commits without disabling a slider that may already be in another gesture.
    saves.current = saves.current.then(async () => {
      const state = useAppearanceStore.getState()
      try {
        const currentField = state.packs.find(pack => pack.source === identity.source && pack.id === identity.id)
          ?.settings.groups.flatMap(group => group.fields).find(candidate => candidate.binding.target === 'layout' && candidate.binding.key === field.binding.key && candidate.type === field.type)
        if (!currentField) throw new Error('Host navigation binding unavailable')
        await state.updateThemeProfile({ theme: { ...identity }, values: { [currentField.key]: value } })
      } catch {
        if (mounted.current && request === requestVersion.current) setSaveFailed(true)
      } finally {
        if (mounted.current && opacityVersion !== undefined && opacityVersion === draftVersion.current) {
          draft.current = null
          setOpacityDraft(null)
          restoreOpacity()
        }
      }
    })
  }

  const previewOpacity = (value: number | undefined) => {
    if (value === undefined || !Number.isFinite(value) || !opacityEnabled || !isClassic) return
    const next = Math.min(max, Math.max(min, value))
    draftVersion.current++
    draft.current = next
    setOpacityDraft(next)
    document.documentElement.style.setProperty('--appearance-tab-opacity', String(next))
    return next
  }
  const opacity = opacityDraft ?? appearance.layout.tabOpacity ?? 1
  const opacityLabel = en ? 'Top bar background opacity' : '顶部标题栏背景不透明度'
  const autoHideLabel = en ? 'Auto-hide' : '自动隐藏'
  return (
    <>
      <Field label={t('settings.general.tabStyle')}>
        <Segmented
          ariaLabel={t('settings.general.tabStyle')}
          value={tabStyle}
          disabled={!styleField}
          options={[
            { value: 'classic', label: t('settings.general.tabStyleClassic'), disabled: !styleField?.options?.some(option => option.value === 'classic') },
            { value: 'orb', label: t('settings.general.tabStyleOrb'), disabled: !styleField?.options?.some(option => option.value === 'orb') },
          ]}
          onChange={next => commit(styleField, next)}
        />
      </Field>
      {isClassic && (
        <>
          <Field label={en ? 'Background opacity' : '背景不透明度'} desc={en ? 'Only the background changes; labels and window buttons remain opaque.' : '仅调整背景，不影响标签和窗口按钮的可见度。'}>
            <div className="appearance-slider-row">
              <Slider
                aria-label={opacityLabel}
                min={min}
                max={max}
                step={step}
                disabled={!opacityEnabled}
                value={[opacity]}
                onValueChange={([next]) => { previewOpacity(next) }}
                onValueCommit={([value]) => {
                  const next = previewOpacity(value)
                  if (next !== undefined) commit(opacityField, next, draftVersion.current)
                }}
              />
              <output>{Math.round(opacity * 100)}%</output>
            </div>
          </Field>
          <Field label={autoHideLabel} desc={en ? 'Hide the top bar when the pointer leaves; move to the top edge to reveal it.' : '指针离开后收起标题栏，移到窗口顶部边缘即展开。'}>
            <Switch
              aria-label={autoHideLabel}
              checked={appearance.layout.tabAutoHide === true}
              disabled={!autoHideField}
              onCheckedChange={next => commit(autoHideField, next)}
            />
          </Field>
        </>
      )}
      {(!styleField || (isClassic && (!opacityField || !autoHideField))) && <p className="desc">{en ? 'Some host navigation settings are unavailable.' : '部分宿主导航设置暂不可用。'}</p>}
      {saveFailed && <p className="desc" role="alert">{en ? 'Settings were not saved. The last confirmed appearance has been restored.' : '设置未保存，已恢复到宿主确认的外观。'}</p>}
    </>
  )
}

function Card({ title, hint, children, className }: { title: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`s-card${className ? ` ${className}` : ''}`}>
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
    notifyPosition: normalizeNotifyPosition(g.notifyPosition),
    proxy: (g.proxy as ProxyConfig | undefined) ?? undefined,
  }
}

/** 校验并归一化表单为可写入的 ProxyConfig；不完整返回 null */
function normalizeProxyForm(
  type: ProxyType,
  host: string,
  port: string,
): ProxyConfig | null {
  if (type === 'system' || type === 'none') return { type }
  const h = host.trim()
  const p = Number(port)
  if (!h || !Number.isInteger(p) || p < 1 || p > 65535) return null
  return { type, host: h, port: p }
}

export function SettingsPage() {
  const settingsTab = useShellStore((s) => s.settingsTab)
  const setSettingsTab = useShellStore((s) => s.setSettingsTab)
  const plugins = useShellStore((s) => s.plugins)
  const { t, locale, setLocale } = useI18n()

  const installed = plugins.filter((p) => p.installed)

  const [hwAccel, setHwAccel] = useState(true)
  const [dataRoot, setDataRoot] = useState('')
  const [closeBehavior, setCloseBehavior] = useState<CloseBehavior>('minimize-tray')
  const [notifyPosition, setNotifyPosition] = useState<NotifyPosition>('bottom-right')
  const [loadingGeneral, setLoadingGeneral] = useState(true)
  const [updateState, setUpdateState] = useState<UpdateStatePayload | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const checkingRef = useRef(false)
  const openUpdateDialog = useUpdateDialogStore((s) => s.openDialog)
  const restartAfterSave = useUpdateDialogStore((s) => s.restartAfterSave)

  const [proxyType, setProxyType] = useState<ProxyType>('system')
  const [proxyHost, setProxyHost] = useState('')
  const [proxyPort, setProxyPort] = useState('')
  const [testingProxy, setTestingProxy] = useState(false)

  /** 插件 settings.register 注入的 section 与持久化值 */
  const [pluginSections, setPluginSections] = useState<PluginSettingsSection[]>([])
  const [pluginSettings, setPluginSettings] = useState<Record<string, Record<string, unknown>>>({})

  /** Installed plugins keep their own settings entry, including before their first launch. */
  const settingsPlugins = installed

  /** Only an uninstalled plugin should lose its settings entry. */
  useEffect(() => {
    if (
      settingsTab.startsWith('p:') &&
      !settingsPlugins.some((p) => `p:${p.id}` === settingsTab)
    ) {
      setSettingsTab('general')
    }
  }, [settingsTab, settingsPlugins, setSettingsTab])

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
        setNotifyPosition(general.notifyPosition)
        // 代理：优先专用 getProxy，回落 settings.general.proxy
        try {
          const proxy = shellApi.getProxy
            ? await shellApi.getProxy()
            : general.proxy ?? { type: 'system' as const }
          if (!cancelled && proxy) {
            setProxyType(proxy.type ?? 'system')
            setProxyHost(proxy.host ?? '')
            setProxyPort(proxy.port != null ? String(proxy.port) : '')
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
          if (!cancelled) setPluginSections(sections)
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
        setPluginSections(payload.sections ?? [])
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
          // 弹框接管：展示 Release Notes + 用户点击「立即更新」后才开始下载
          openUpdateDialog()
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
  }, [t, openUpdateDialog])

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
    void restartAfterSave()
  }, [restartAfterSave])

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

  /** 消息通知位置：UI 乐观更新，主进程显示通知时实时读取，新消息即时生效 */
  const handleNotifyPosition = useCallback(
    (value: NotifyPosition) => {
      setNotifyPosition(value)
      void shellApi.setSettings({
        general: { notifyPosition: value },
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
            config.type === 'none'
              ? t('settings.general.proxyCleared')
              : config.type === 'system' ? t('settings.general.proxySystemApplied') : t('settings.general.proxyApplied')
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
      if (value === 'system' || value === 'none') {
        persistProxy({ type: value })
        return
      }
      // 切到有配置的类型时，若表单已完整则立刻保存；否则等 blur 补齐
      persistProxy(normalizeProxyForm(value, proxyHost, proxyPort), true)
    },
    [persistProxy, proxyHost, proxyPort],
  )

  const handleProxyFieldBlur = useCallback(() => {
    if (proxyType === 'system' || proxyType === 'none') return
    persistProxy(normalizeProxyForm(proxyType, proxyHost, proxyPort))
  }, [persistProxy, proxyHost, proxyPort, proxyType])

  const handleTestProxy = useCallback(() => {
    if (!shellApi.testProxy) return
    const config = normalizeProxyForm(proxyType, proxyHost, proxyPort)
    if (!config) {
      toastStore.getState().push(t('settings.general.proxyInvalid'))
      return
    }
    setTestingProxy(true)
    void (async () => {
      try {
        const result = await shellApi.testProxy!(config)
        if (result.ok) {
          if (config.type === 'system') {
            toastStore.getState().push(t('settings.general.proxyTestOkSystem'))
          } else if (config.type === 'none') {
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
  }, [proxyHost, proxyPort, proxyType, t])

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
    { id: 'profile', label: locale === 'en-US' ? 'Account' : '个人资料' },
    { id: 'appearance', label: t('settings.tabs.appearance') },
    { id: 'quick', label: '快捷键' },
    { id: 'dev', label: t('settings.tabs.dev') },
  ] as const

  const allTabs = [
    ...TABS.map((x) => ({ id: x.id as string, label: x.label })),
    ...settingsPlugins.map((p) => ({ id: `p:${p.id}`, label: p.name })),
  ]

  return (
    <section className="page page-settings">
      <div className="settings-shell">
        <div className="settings-header">
          <h1>{t('settings.title')}</h1>
        </div>
        <SettingsTabs
          tabs={allTabs}
          active={settingsTab}
          moreLabel={t('settings.tabs.more')}
          collapseLabel={locale === 'en-US' ? 'Collapse' : '收起'}
          onChange={setSettingsTab}
        />

        {settingsTab === 'profile' && <ProfileSection />}
        {settingsTab === 'general' && (
          <Card title={t('settings.general.title')}>
            <Field label={t('settings.general.language')}>
              <LanguageSelect value={locale} onChange={handleLocale} />
            </Field>
            <Field label={t('settings.general.hardwareAccel')} desc={t('settings.general.hardwareAccelDesc')}>
              <Switch checked={hwAccel} onCheckedChange={handleHwAccel} aria-label={t('settings.general.hardwareAccel')} />
            </Field>
            <Field label={t('settings.general.dataRoot')}>
              <div className="path-actions">
                <code className="path-text" title={dataRoot}>
                  {loadingGeneral ? t('common.loading') : dataRoot || '—'}
                </code>
                <Button variant="ghost" size="sm" onClick={handleOpenDataRoot} disabled={!dataRoot}>
                  {t('settings.general.openFolder')}
                </Button>
              </div>
            </Field>
            <Field label={t('settings.general.closeBehavior')}>
              <Select
                ariaLabel={t('settings.general.closeBehavior')}
                value={closeBehavior}
                onChange={handleCloseBehavior}
                minWidth={160}
                options={[
                  { value: 'minimize-tray', label: t('settings.general.minimizeToTray') },
                  { value: 'quit', label: t('settings.general.quitApp') },
                ]}
              />
            </Field>
            <Field label={t('settings.general.notifyPosition')} desc={t('settings.general.notifyPositionDesc')}>
              <Segmented
                className="notify-pos-seg"
                ariaLabel={t('settings.general.notifyPosition')}
                value={notifyPosition}
                onChange={handleNotifyPosition}
                options={[
                  {
                    value: 'center' as NotifyPosition,
                    label: <>
                      <span className="notify-pos-icon center-icon" aria-hidden="true"><i /><i /></span>
                      {t('settings.general.notifyPositionCenter')}
                    </>
                  },
                  {
                    value: 'bottom-right' as NotifyPosition,
                    label: <>
                      <span className="notify-pos-icon corner-icon" aria-hidden="true"><i /><i /><i /></span>
                      {t('settings.general.notifyPositionCorner')}
                    </>
                  }
                ]}
              />
            </Field>
            <Field label={t('settings.general.proxy')}>
              <div className="proxy-row">
                <Select
                  value={proxyType}
                  onChange={handleProxyType}
                  minWidth={132}
                  ariaLabel={t('settings.general.proxyType')}
                  options={[
                    { value: 'system', label: t('settings.general.proxySystem') },
                    { value: 'none', label: t('settings.general.proxyNone') },
                    { value: 'http', label: t('settings.general.proxyHttp') },
                  ]}
                />
                {proxyType === 'http' ? (
                  <>
                    <Input
                      className="proxy-host"
                      value={proxyHost}
                      placeholder={t('settings.general.proxyHostPlaceholder')}
                      aria-label={t('settings.general.proxyHost')}
                      onChange={(e) => setProxyHost(e.target.value)}
                      onBlur={handleProxyFieldBlur}
                    />
                    <Input
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
                <Button variant="ghost" size="sm" onClick={handleTestProxy} disabled={testingProxy || proxyType === 'none'}>
                  {testingProxy ? t('settings.general.proxyTesting') : t('settings.general.proxyTest')}
                </Button>
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
                      : `${locale === 'en-US' ? 'Version' : '当前版本'} ${updateState?.currentVersion ?? '—'}`
              }
            >
              <div className="path-actions">
                <Button variant="ghost" size="sm" onClick={handleCheckUpdate} disabled={checkingUpdate || updateState?.status === 'downloading'}>
                  {checkingUpdate || updateState?.status === 'checking'
                    ? t('settings.general.checkingUpdate')
                    : t('settings.general.checkUpdate')}
                </Button>
                {(updateState?.status === 'available' || updateState?.status === 'downloaded') && (
                  <Button variant="ghost" size="sm" onClick={openUpdateDialog}>
                    {t('settings.general.viewUpdateNotes')}
                  </Button>
                )}
                {updateState?.status === 'downloaded' && (
                  <Button variant="primary" size="sm" onClick={handleInstallUpdate}>
                    {t('settings.general.installUpdate')}
                  </Button>
                )}
              </div>
            </Field>
          </Card>
        )}

        {settingsTab === 'general' && <TopTabBarSection />}

        {settingsTab === 'general' && <PluginMemorySection />}

        {settingsTab === 'appearance' && <AppearanceSettingsSection />}

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
              if (item.type === 'page') {
                return (
                  <Button onClick={() => {
                    void shellApi.openPlugin(id, item.entry ?? { code: 'settings' }).catch((error: unknown) => {
                      notify.error(error instanceof Error ? error.message : '无法打开插件设置')
                    })
                  }}>打开插件设置</Button>
                )
              }
              const raw = item.key in values ? values[item.key] : item.default
              if (item.type === 'boolean' || item.type === 'bool' || item.type === 'switch') {
                return (
                  <Switch
                    aria-label={item.label}
                    checked={raw !== false && raw != null}
                    onCheckedChange={() => handlePluginSetting(id, item.key, !(raw !== false && raw != null))}
                  />
                )
              }
              if (item.type === 'select' && Array.isArray(item.options) && item.options.length > 0) {
                return (
                  <Select
                    className="plugin-setting-select"
                    ariaLabel={item.label}
                    value={raw === undefined || raw === null ? '' : String(raw)}
                    onChange={(v) => {
                      const opt = item.options?.find((o) => String(o.value) === v)
                      handlePluginSetting(id, item.key, opt ? opt.value : v)
                    }}
                    options={item.options.map((o) => ({
                      value: String(o.value),
                      label: o.label
                    }))}
                  />
                )
              }
              if (item.type === 'number') {
                return (
                  <Input
                    type="number"
                    className="plugin-setting-input"
                    aria-label={item.label}
                    min={item.min}
                    max={item.max}
                    step={item.step ?? 'any'}
                    defaultValue={raw === undefined || raw === null ? '' : String(raw)}
                    onBlur={(e) => {
                      const input = e.currentTarget
                      const n = Number(input.value)
                      if (!input.value.trim() || !Number.isFinite(n) || !input.validity.valid) {
                        const outOfRange = input.validity.rangeUnderflow || input.validity.rangeOverflow
                        const stepMismatch = input.validity.stepMismatch
                        input.value = raw === undefined || raw === null ? '' : String(raw)
                        const range = Number.isFinite(item.min) && Number.isFinite(item.max)
                          ? `${item.min}～${item.max}`
                          : Number.isFinite(item.min) ? `不小于 ${item.min}` : `不大于 ${item.max}`
                        notify.warn(outOfRange
                          ? `请输入${range}的数字，已恢复原值`
                          : stepMismatch ? `数字步长应为 ${item.step}，已恢复原值` : '请输入有效数字，已恢复原值')
                        return
                      }
                      handlePluginSetting(id, item.key, n)
                    }}
                  />
                )
              }
              if (item.type === 'slider') {
                const min = Number.isFinite(item.min) ? (item.min as number) : 0
                const max = Number.isFinite(item.max) ? (item.max as number) : 100
                const step = Number.isFinite(item.step) && item.step! > 0 ? item.step! : 1
                const num = Number(raw)
                const value = Number.isFinite(num) ? Math.min(max, Math.max(min, num)) : min
                return (
                  <div className="plugin-slider-row">
                    <Slider
                      min={min}
                      max={max}
                      step={step}
                      value={[value]}
                      aria-label={item.label}
                      onValueChange={([next]) => handlePluginSetting(id, item.key, next)}
                    />
                    <span className="plugin-slider-value">{value}</span>
                  </div>
                )
              }
              if (item.type === 'color') {
                const color = typeof raw === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(raw) ? raw : PLUGIN_CATEGORY_COLOR_DEFAULT
                return (
                  <ColorPickerField
                    value={color}
                    label={item.label}
                    onChange={(hex) => handlePluginSetting(id, item.key, hex)}
                  />
                )
              }
              // string / text / 非法 type 回退 text（现状保留）+ dev 日志
              if (
                item.type !== 'text' &&
                item.type !== 'string' &&
                import.meta.env.DEV
              ) {
                console.warn('[settings] unknown item type, fallback to text:', item.type, item.key)
              }
              return (
                <Input
                  className="plugin-setting-input"
                  aria-label={item.label}
                  defaultValue={raw === undefined || raw === null ? '' : String(raw)}
                  onBlur={(e) => handlePluginSetting(id, item.key, e.target.value)}
                />
              )
            }
            return (
              <Card key={id} title={p.name} className="plugin-settings-card">
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
