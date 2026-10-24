/**
 * PluginDetailModal — 插件详情弹窗
 * 大图头（图标/名称/作者/版本/分类/安装量）+ 安装/打开/更新、启用/禁用切换、
 * 已安装时卸载与关闭操作 + README Markdown 正文。
 * 安装：本地 sample 优先（shellApi.installMarketPlugin），失败展示错误；
 *       远程资产入队下载，进度经 InstallProgressPanel。
 * README 经 shellApi.getPluginReadme 异步拉取；专用 motion hook 从点击卡片展开并收回。
 * 使用方：MarketPage（卡片/轮播点击打开）。依赖：MarkdownView、usePluginDetailMotion、shellApi。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  PluginLaunchConfig,
  PluginLaunchPatch,
  PluginPermission,
  PluginPermissionGrant,
  PluginSummary
} from '@shared/types/plugin'
import { filterPermissionGrants, requiresUserConsent } from '@shared/pluginPermissionPolicy'
import { shellApi } from '@renderer/services/shellApi'
import { notify } from '@renderer/services/notifyService'
import { confirmAction } from '@renderer/services/confirmAction'
import { PluginDetailView } from '@renderer/themes/default/workspace/PluginDetailView'
import { useI18n } from '@renderer/hooks/useI18n'
import { useShellStore } from '@renderer/stores/shellStore'
import { usePluginDetailMotion } from '@renderer/themes/default/workspace/usePluginDetailMotion'

type ReadmeStatus = 'loading' | 'ok' | 'empty' | 'error'

interface Props {
  plugin: PluginSummary
  /** The clicked card, featured item or search result supplies the spatial origin. */
  origin?: HTMLElement | null
  /** 关闭弹窗（动画结束后由子组件回调） */
  onClose: () => void
  /** 安装完成后打开插件（sample 同步安装成功时调用） */
  onInstall: (id: string) => void
}

export function PluginDetailModal({ plugin, origin = null, onClose, onInstall }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const requestClose = usePluginDetailMotion(rootRef, plugin.id, origin, onClose)
  const [status, setStatus] = useState<ReadmeStatus>('loading')
  const [readme, setReadme] = useState('')
  const [uninstalling, setUninstalling] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [resettingPermissions, setResettingPermissions] = useState(false)
  const [deniedPermissions, setDeniedPermissions] = useState<PluginPermission[]>([])
  const permissionGrantsRef = useRef<Partial<Record<PluginPermission, PluginPermissionGrant>>>({})
  const permissionRevisionRef = useRef(0)
  const [actionError, setActionError] = useState<string | null>(null)
  /** 本地可变副本：启用切换后立刻反映，不必等父级刷新 */
  const [enabled, setEnabled] = useState(plugin.enabled !== false)
  const { t } = useI18n()

  // —— 快捷启动配置（仅已安装插件；settings.pluginLaunch[id]）——
  const [launchCfg, setLaunchCfg] = useState<PluginLaunchConfig | null>(null)
  const [savingLaunch, setSavingLaunch] = useState(false)
  const [aliasDraft, setAliasDraft] = useState('')

  const disabled = plugin.installed && !enabled
  const updateVersion = plugin.latestVersion
  const busy = uninstalling || installing || toggling || resettingPermissions

  const applyPermissionGrants = useCallback((value: unknown) => {
    const grants = filterPermissionGrants(value)
    permissionGrantsRef.current = grants
    setDeniedPermissions([...new Set(plugin.permissions)].filter(permission =>
      requiresUserConsent(permission) && grants[permission] === 'deny'
    ))
  }, [plugin.permissions])

  // Keep only a recovery action visible; the native prompt still owns consent.
  useEffect(() => {
    let cancelled = false
    const revision = ++permissionRevisionRef.current
    applyPermissionGrants({})
    if (!plugin.installed || !shellApi.getPluginPermissionGrants || !shellApi.setPluginPermissionGrant) return
    const off = shellApi.onEvent((payload) => {
      if (payload.type !== 'permission-grants-changed' || payload.pluginId !== plugin.id) return
      permissionRevisionRef.current += 1
      applyPermissionGrants(payload.grants)
    })
    void shellApi.getPluginPermissionGrants(plugin.id).then(grants => {
      if (!cancelled && revision === permissionRevisionRef.current) applyPermissionGrants(grants)
    }).catch(() => {
      if (!cancelled) setActionError('无法读取授权状态，请关闭详情后重试')
    })
    return () => {
      cancelled = true
      permissionRevisionRef.current += 1
      off()
    }
  }, [plugin.id, plugin.installed, applyPermissionGrants])

  const handleResetPermissions = async () => {
    if (busy || !shellApi.getPluginPermissionGrants || !shellApi.setPluginPermissionGrant) return
    setResettingPermissions(true)
    setActionError(null)
    try {
      const revision = permissionRevisionRef.current
      const grants = await shellApi.getPluginPermissionGrants(plugin.id)
      if (revision === permissionRevisionRef.current) applyPermissionGrants(grants)
      let resetCount = 0
      for (const permission of [...new Set(plugin.permissions)]) {
        if (!requiresUserConsent(permission) || permissionGrantsRef.current[permission] !== 'deny') continue
        await shellApi.setPluginPermissionGrant(plugin.id, permission, 'ask')
        // The host emits the full current state; this also covers older bridges without that event.
        if (permissionGrantsRef.current[permission] === 'deny') {
          applyPermissionGrants({ ...permissionGrantsRef.current, [permission]: 'ask' })
        }
        resetCount += 1
      }
      notify.success(resetCount ? '已恢复询问，下次使用相关功能时会重新授权' : '授权状态已更新')
    } catch (error) {
      setActionError(error instanceof Error ? `重新授权失败：${error.message}` : '重新授权失败，请重试')
    } finally {
      setResettingPermissions(false)
    }
  }

  // plugin 变更时同步 enabled
  useEffect(() => {
    setEnabled(plugin.enabled !== false)
    setActionError(null)
  }, [plugin.id, plugin.enabled, plugin.icon])

  // 快捷启动配置加载：settings.pluginLaunch[plugin.id]
  useEffect(() => {
    let cancelled = false
    setLaunchCfg(null)
    if (!plugin.installed) return
    void shellApi
      .getSettings()
      .then((settings) => {
        if (cancelled) return
        const cfg = settings?.pluginLaunch?.[plugin.id] ?? null
        setLaunchCfg(cfg)
        setAliasDraft(cfg?.aliases?.join('、') ?? '')
      })
      .catch(() => {
        /* 读取失败保持空配置 */
      })
    return () => {
      cancelled = true
    }
  }, [plugin.id, plugin.installed])

  // README 拉取
  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setReadme('')

    const load = async () => {
      try {
        const md = await shellApi.getPluginReadme(plugin.id)
        if (cancelled) return
        if (!md || !md.trim()) {
          setStatus('empty')
        } else {
          setReadme(md)
          setStatus('ok')
        }
      } catch {
        if (!cancelled) setStatus('error')
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [plugin.id])

  const actionLabel = plugin.installed
    ? disabled
      ? t('plugin.disabled')
      : t('plugin.open')
    : installing
      ? t('plugin.installing')
      : t('plugin.install')

  /**
   * 安装 / 打开：
   * - 已安装且启用 → onInstall 打开
   * - 未安装 → installMarketPlugin（sample 同步成功则直接打开；远程入队关弹窗看进度）
   */
  const handlePrimary = async () => {
    if (busy) return
    setActionError(null)
    if (plugin.installed) {
      if (disabled) return
      onInstall(plugin.id)
      requestClose()
      return
    }
    if (!shellApi.installMarketPlugin) {
      onInstall(plugin.id)
      requestClose()
      return
    }
    setInstalling(true)
    try {
      const result = await shellApi.installMarketPlugin(plugin.id)
      if (result.mode === 'sample' || result.mode === 'already') {
        onInstall(plugin.id)
        requestClose()
      } else {
        // remote：已入队，关弹窗由 InstallProgressPanel 展示进度
        requestClose()
      }
    } catch (err) {
      setActionError(t('plugin.installFailed', { error: (err as Error).message }))
      setInstalling(false)
    }
  }

  /** 更新到 latestVersion：二次确认后强制走远程下载入队 */
  const handleUpdate = async () => {
    if (busy || !updateVersion || !shellApi.installMarketPlugin) return
    const ok = await confirmAction({ title: t('plugin.update'), message: t('plugin.updateConfirm', { name: plugin.name, version: updateVersion }), confirmLabel: t('plugin.update') })
    if (!ok) return
    setActionError(null)
    setInstalling(true)
    try {
      await shellApi.installMarketPlugin(plugin.id, { force: true })
      requestClose()
    } catch (err) {
      setActionError(t('plugin.installFailed', { error: (err as Error).message }))
      setInstalling(false)
    }
  }

  /** 启用/禁用切换；乐观更新本地状态，失败回滚 */
  const handleToggleEnabled = async () => {
    if (busy || !shellApi.setPluginEnabled) return
    const next = !enabled
    setToggling(true)
    setActionError(null)
    setEnabled(next)
    try {
      await shellApi.setPluginEnabled(plugin.id, next)
    } catch (err) {
      setEnabled(!next)
      setActionError(t('plugin.enableFailed', { error: (err as Error).message }))
    } finally {
      setToggling(false)
    }
  }

  /** 二次确认后卸载；结果经 uninstall-result 刷新列表，此处关闭详情并恢复按钮 */
  const handleUninstall = async () => {
    if (busy) return
    const ok = await confirmAction({ title: t('plugin.uninstall'), message: t('plugin.uninstallConfirm', { name: plugin.name }), confirmLabel: t('plugin.uninstall'), danger: true })
    if (!ok) return
    if (!shellApi.uninstallPlugin) return
    setUninstalling(true)
    try {
      await shellApi.uninstallPlugin(plugin.id)
      requestClose()
    } catch {
      /* 失败 toast 已由 uninstall-result 事件覆盖 */
    } finally {
      setUninstalling(false)
    }
  }

  // —— 搜索启动偏好 ——

  /** 搜索入口偏好与触发词独立于快捷键的启动位置。 */
  const saveLaunch = useCallback(
    async (
      patch: PluginLaunchPatch
    ): Promise<boolean> => {
      if (!shellApi.setPluginLaunch || savingLaunch) return false
      setSavingLaunch(true)
      setActionError(null)
      try {
        const result = await shellApi.setPluginLaunch(plugin.id, patch)
        if (!result.ok) {
          setActionError(result.error ?? '保存失败')
          return false
        }
        setLaunchCfg(result.config ?? null)
        return true
      } catch (err) {
        setActionError((err as Error).message)
        return false
      } finally {
        setSavingLaunch(false)
      }
    },
    [plugin.id, savingLaunch]
  )

  /** 触发词保存：、/,/空格 分隔，去空去重 */
  const commitAliases = useCallback(() => {
    const aliases = aliasDraft
      .split(/[、,，\s]+/)
      .map((a) => a.trim())
      .filter(Boolean)
    void saveLaunch({ aliases })
  }, [aliasDraft, saveLaunch])

  return <PluginDetailView plugin={plugin} rootRef={rootRef} requestClose={requestClose}
    status={status} readme={readme} busy={busy} disabled={Boolean(disabled)}
    uninstalling={uninstalling} installing={installing} toggling={toggling}
    resettingPermissions={resettingPermissions} deniedPermissions={deniedPermissions}
    actionLabel={actionLabel} actionError={actionError} handlePrimary={handlePrimary}
    handleUpdate={handleUpdate} handleToggleEnabled={handleToggleEnabled}
    handleResetPermissions={handleResetPermissions} handleUninstall={handleUninstall}
    launchControls={<>
          {plugin.installed && shellApi.setPluginLaunch && (
            <section className="detail-launch" data-detail-launch aria-label="快捷启动设置">
              <div className="detail-launch-head">
                <h3>快捷启动</h3>
                <span className="detail-launch-hint">搜索启动偏好与 Quick 搜索触发词</span>
              </div>

              <div className="detail-launch-row">
                <span className="detail-launch-label">启动方式</span>
                <div className="detail-launch-seg" role="radiogroup" aria-label="启动方式">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!launchCfg?.mode}
                    className={!launchCfg?.mode ? 'active' : ''}
                    disabled={savingLaunch}
                    title="Quick 打开进小窗，主窗打开进大窗"
                    onClick={() => void saveLaunch({ mode: null })}
                  >
                    跟随入口
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={launchCfg?.mode === 'quick'}
                    className={launchCfg?.mode === 'quick' ? 'active' : ''}
                    disabled={savingLaunch}
                    title="Quick 搜索打开时进入小窗口"
                    onClick={() => void saveLaunch({ mode: 'quick' })}
                  >
                    小窗口
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={launchCfg?.mode === 'shell'}
                    className={launchCfg?.mode === 'shell' ? 'active' : ''}
                    disabled={savingLaunch}
                    title="Quick 搜索打开时进入主窗口 Tab"
                    onClick={() => void saveLaunch({ mode: 'shell' })}
                  >
                    主窗口
                  </button>
                </div>
              </div>

              <div className="detail-launch-row">
                <span className="detail-launch-label">快捷键</span>
                <button type="button" className="btn btn-ghost" onClick={() => {
                  onClose()
                  const store = useShellStore.getState()
                  store.setShortcutPluginFilter(plugin.id)
                  store.setSettingsTab('quick')
                  store.setView('settings')
                }}>管理此插件的快捷键</button>
                <span className="detail-launch-hint">每条绑定可独立选择启动位置</span>
              </div>

              <div className="detail-launch-row">
                <span className="detail-launch-label">触发词</span>
                <input
                  className="detail-launch-aliases"
                  type="text"
                  value={aliasDraft}
                  placeholder="自定义 Quick 搜索触发词，用「、」或空格分隔"
                  disabled={savingLaunch}
                  onChange={(e) => setAliasDraft(e.target.value)}
                  onBlur={commitAliases}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commitAliases()
                    }
                  }}
                />
              </div>
            </section>
          )}

    </>} />
}
