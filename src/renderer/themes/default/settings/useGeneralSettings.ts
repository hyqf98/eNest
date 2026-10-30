import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '@renderer/hooks/useI18n'
import type { Locale } from '@renderer/i18n'
import { shellApi } from '@renderer/services/shellApi'
import { toastStore } from '@renderer/hooks/useToast'
import type { ProxyConfig, ProxyType } from '@shared/types/plugin'

type CloseBehavior = 'minimize-tray' | 'quit'
export type NotifyPosition = 'center' | 'bottom-right'

/** 未设置或无效的关闭行为回落到托盘。 */
function normalizeCloseBehavior(v: unknown): CloseBehavior {
  return v === 'quit' ? 'quit' : 'minimize-tray'
}

/** 消息通知位置归一：仅认 center，其余（含缺省）归 bottom-right */
function normalizeNotifyPosition(v: unknown): NotifyPosition {
  return v === 'center' ? 'center' : 'bottom-right'
}

/** 从宿主设置快照读取通用设置。 */
function pickGeneral(settings: Awaited<ReturnType<typeof shellApi.getSettings>>) {
  const g = settings.general ?? {}
  return {
    locale: (g.locale as Locale | undefined) ?? undefined,
    hardwareAcceleration: g.hardwareAcceleration,
    dataRoot: g.dataRoot,
    closeBehavior: normalizeCloseBehavior(g.closeBehavior),
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

/** Kept at page scope so tab switches retain drafts and the original loading lifetime. */
export function useGeneralSettings() {
  const { t, setLocale } = useI18n()
  const [hwAccel, setHwAccel] = useState(true)
  const [dataRoot, setDataRoot] = useState('')
  const [closeBehavior, setCloseBehavior] = useState<CloseBehavior>('minimize-tray')
  const [notifyPosition, setNotifyPosition] = useState<NotifyPosition>('bottom-right')
  const [loadingGeneral, setLoadingGeneral] = useState(true)
  const [proxyType, setProxyType] = useState<ProxyType>('system')
  const [proxyHost, setProxyHost] = useState('')
  const [proxyPort, setProxyPort] = useState('')
  const [testingProxy, setTestingProxy] = useState(false)

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

  return {
    hwAccel, dataRoot, closeBehavior, notifyPosition, loadingGeneral,
    proxyType, proxyHost, proxyPort, testingProxy, setProxyHost, setProxyPort,
    handleLocale, handleHwAccel, handleCloseBehavior, handleNotifyPosition,
    handleProxyType, handleProxyFieldBlur, handleTestProxy, handleOpenDataRoot
  }
}
