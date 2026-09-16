/**
 * SettingsPage — 设置页
 * 左侧标签（通用/主题/开发者 + 已安装插件动态分组），右侧渲染对应卡片。
 * 通用：语言分段、硬件加速开关、数据目录（只读+打开/复制）、关闭行为、检查更新。
 * 主题面板挂载 ThemeSettingsSection（模式/主题包/背景/Token）；插件列表来自 shellStore.plugins。
 * 依赖：shellStore、ThemeSettingsSection、useI18n、shellApi。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useShellStore } from '../stores/shellStore'
import { ThemeSettingsSection } from '../components/ThemeSettingsSection'
import { QuickSettingsSection } from '../components/QuickSettingsSection'
import { LanguageSelect } from '../components/LanguageSelect'
import { useI18n } from '../hooks/useI18n'
import type { Locale } from '../i18n'
import { shellApi } from '../services/shellApi'
import { toastStore } from '../hooks/useToast'
import type { UpdateStatePayload } from '@shared/types/ipc'

type CloseBehavior = 'tray' | 'quit'

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
    closeBehavior: (g.closeBehavior as CloseBehavior | undefined) ?? settings.closeBehavior ?? 'tray',
  }
}

export function SettingsPage() {
  const settingsTab = useShellStore((s) => s.settingsTab)
  const setSettingsTab = useShellStore((s) => s.setSettingsTab)
  const plugins = useShellStore((s) => s.plugins)
  const { t, locale, setLocale } = useI18n()

  const installed = plugins.filter((p) => p.installed)

  const [hwAccel, setHwAccel] = useState(true)
  const [dataRoot, setDataRoot] = useState('')
  const [closeBehavior, setCloseBehavior] = useState<CloseBehavior>('tray')
  const [loadingGeneral, setLoadingGeneral] = useState(true)
  const [updateState, setUpdateState] = useState<UpdateStatePayload | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const updateBusy = useRef(false)
  const checkingRef = useRef(false)

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
        if (st === 'available') {
          toastStore.getState().push(
            t('toasts.updateAvailable', { version: payload.state.latestVersion ?? '' })
          )
          // 发现新版本后自动下载，完成后提示可安装重启
          if (shellApi.downloadUpdate && !updateBusy.current) {
            updateBusy.current = true
            void shellApi.downloadUpdate().finally(() => {
              updateBusy.current = false
            })
          }
        } else if (st === 'not-available' && checkingRef.current) {
          toastStore.getState().push(t('toasts.updateNone'))
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
        if (result?.status === 'not-available') {
          toastStore.getState().push(t('toasts.updateNone'))
        } else if (result?.status === 'error') {
          toastStore.getState().push(t('toasts.updateError'))
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
      void shellApi.setSettings({
        closeBehavior: value,
        general: { closeBehavior: value },
      })
    },
    [],
  )

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
                <option value="tray">{t('settings.general.minimizeToTray')}</option>
                <option value="quit">{t('settings.general.quitApp')}</option>
              </select>
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

        {settingsTab === 'appearance' && <ThemeSettingsSection />}

        {settingsTab === 'quick' && <QuickSettingsSection />}

        {settingsTab === 'dev' && (
          <Card title={t('settings.dev.title')} hint={t('settings.dev.hint')}>
            <Field label={t('settings.dev.devMode')} desc={t('settings.dev.devModeDesc')}>
              <Switch on onToggle={() => undefined} />
            </Field>
            <Field label={t('settings.dev.autoDevTools')} desc={t('settings.dev.autoDevToolsDesc')}>
              <Switch on={false} onToggle={() => undefined} />
            </Field>
          </Card>
        )}

        {settingsTab.startsWith('p:') &&
          (() => {
            const id = settingsTab.slice(2)
            const p = installed.find((x) => x.id === id)
            if (!p) return null
            return (
              <Card title={p.name} hint={t('settings.pluginSection.hint')}>
                <Field label={t('settings.pluginSection.enable')} desc={t('settings.pluginSection.enableDesc')}>
                  <Switch on onToggle={() => undefined} />
                </Field>
                <Field
                  label={t('settings.pluginSection.showInSettings')}
                  desc={t('settings.pluginSection.showInSettingsDesc')}
                >
                  <Switch on onToggle={() => undefined} />
                </Field>
                <Field
                  label={t('settings.pluginSection.customLabel')}
                  desc={t('settings.pluginSection.customLabelDesc')}
                >
                  <input type="text" defaultValue="朋友" />
                </Field>
              </Card>
            )
          })()}
      </div>
    </section>
  )
}
