/**
 * PluginDetailModal — 插件详情弹窗
 * 大图头（图标/名称/作者/版本/分类/安装量/权限）+ 安装/打开/更新、启用/禁用切换、
 * 已安装时卸载与关闭操作 + README Markdown 正文。
 * 安装：本地 sample 优先（shellApi.installMarketPlugin），失败展示错误；
 *       远程资产入队下载，进度经 InstallProgressPanel。
 * README 经 shellApi.getPluginReadme 异步拉取；GSAP 控制遮罩模糊与内容 stagger 入退场。
 * 使用方：MarketPage（卡片/轮播点击打开）。依赖：MarkdownView、marketMotion、shellApi。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import type {
  PluginLaunchConfig,
  PluginLaunchPatch,
  PluginSummary
} from '@shared/types/plugin'
import { shellApi } from '@renderer/services/shellApi'
import { playModalIn, playModalOut } from '@renderer/gsap/marketMotion'
import { MarkdownView } from '@renderer/components/MarkdownView'
import { useI18n } from '@renderer/hooks/useI18n'
import { useShellStore } from '@renderer/stores/shellStore'
import { permissionLabel } from '@shared/permissionLabels'
import { requiresUserConsent } from '@shared/pluginPermissionPolicy'
import { PluginBuiltinCapabilities } from '@renderer/components/PluginBuiltinCapabilities'

type ReadmeStatus = 'loading' | 'ok' | 'empty' | 'error'

interface Props {
  plugin: PluginSummary
  /** 关闭弹窗（动画结束后由子组件回调） */
  onClose: () => void
  /** 安装完成后打开插件（sample 同步安装成功时调用） */
  onInstall: (id: string) => void
}

/** 插件品牌色推导渐变底色（暗端混入色）：无对应主题 token，品牌色本身即数据 */
const ICON_BG_DARK_MIX = '#111'

function iconBackground(p: PluginSummary): string {
  return `linear-gradient(145deg, ${p.color}, color-mix(in srgb, ${p.color} 50%, ${ICON_BG_DARK_MIX}))`
}

export function PluginDetailModal({ plugin, onClose, onInstall }: Props) {
  const sensitivePermissions = [...new Set(plugin.permissions)].filter(requiresUserConsent)
  const rootRef = useRef<HTMLDivElement>(null)
  const closingRef = useRef(false)
  const [status, setStatus] = useState<ReadmeStatus>('loading')
  const [readme, setReadme] = useState('')
  const [uninstalling, setUninstalling] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  /** 本地可变副本：启用切换后立刻反映，不必等父级刷新 */
  const [enabled, setEnabled] = useState(plugin.enabled !== false)
  /** 图标加载失败时回退 glyph 色块 */
  const [iconFailed, setIconFailed] = useState(false)
  const showIcon = Boolean(plugin.icon) && !iconFailed
  const { t } = useI18n()

  // —— 快捷启动配置（仅已安装插件；settings.pluginLaunch[id]）——
  const [launchCfg, setLaunchCfg] = useState<PluginLaunchConfig | null>(null)
  const [savingLaunch, setSavingLaunch] = useState(false)
  const [aliasDraft, setAliasDraft] = useState('')

  const disabled = plugin.installed && !enabled
  const updateVersion = plugin.latestVersion
  const motionContext = useRef<gsap.Context | null>(null)

  /** 先播退场，再通知父级卸载 */
  const requestClose = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    motionContext.current?.add(() => {
      void playModalOut(rootRef.current).then(() => {
        if (motionContext.current) onClose()
      })
    })
  }, [onClose])

  // 入场动画
  useEffect(() => {
    const context = gsap.context(() => playModalIn(rootRef.current), rootRef)
    motionContext.current = context
    closingRef.current = false
    return () => {
      motionContext.current = null
      context.revert()
    }
  }, [plugin.id])

  // plugin 变更时同步 enabled / 图标回退状态
  useEffect(() => {
    setEnabled(plugin.enabled !== false)
    setActionError(null)
    setIconFailed(false)
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
    closingRef.current = false
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

  // Escape 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        requestClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestClose])

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
    if (installing || uninstalling) return
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
    if (installing || !updateVersion || !shellApi.installMarketPlugin) return
    const ok = window.confirm(
      t('plugin.updateConfirm', { name: plugin.name, version: updateVersion })
    )
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
    if (toggling || !shellApi.setPluginEnabled) return
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
    if (uninstalling) return
    const ok = window.confirm(t('plugin.uninstallConfirm', { name: plugin.name }))
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

  return (
    <div className="detail-overlay" ref={rootRef} role="presentation">
      <div
        className="detail-backdrop"
        data-detail-backdrop
        onClick={requestClose}
        aria-hidden="true"
      />
      <div
        className="detail-modal"
        data-detail-modal
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-detail-title"
      >
        <header className="detail-header" data-detail-header>
          <div
            className="detail-icon"
            data-detail-icon
            style={{ background: iconBackground(plugin), ...(disabled ? { opacity: 0.6 } : null) }}
          >
            {showIcon ? (
              <img
                src={plugin.icon}
                alt={plugin.name}
                loading="lazy"
                draggable={false}
                onError={() => setIconFailed(true)}
                style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' }}
              />
            ) : (
              plugin.glyph
            )}
          </div>
          <div className="detail-meta" data-detail-meta>
            <h2 id="plugin-detail-title">{plugin.name}</h2>
            <div className="detail-sub">
              {plugin.author} · v{plugin.version}
              {updateVersion ? ` · ${t('plugin.updateAvailable', { version: updateVersion })}` : ''}
            </div>
            <div className="detail-chips" data-detail-chips>
              <span className="detail-chip">{plugin.category}</span>
              {plugin.installed ? (
                <span className="detail-chip ok">
                  {disabled ? t('plugin.disabled') : t('plugin.installed')}
                </span>
              ) : null}

            </div>
          </div>
          <div className="detail-actions" data-detail-actions>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handlePrimary()}
              disabled={uninstalling || installing || toggling || disabled}
            >
              {actionLabel}
            </button>
            {plugin.installed && updateVersion && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void handleUpdate()}
                disabled={uninstalling || installing || toggling}
              >
                {installing ? t('plugin.updating') : t('plugin.update')}
              </button>
            )}
            {plugin.installed && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void handleToggleEnabled()}
                disabled={uninstalling || installing || toggling}
              >
                {toggling ? t('common.loading') : enabled ? t('plugin.disable') : t('plugin.enable')}
              </button>
            )}
            {plugin.installed && (
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void handleUninstall()}
                disabled={uninstalling}
              >
                {uninstalling ? t('plugin.uninstalling') : t('plugin.uninstall')}
              </button>
            )}
            <button type="button" className="btn btn-ghost" onClick={requestClose} disabled={uninstalling}>
              {t('plugin.close')}
            </button>
          </div>
          {actionError && (
            <div
              className="detail-state"
              style={{ gridColumn: '1 / -1', color: 'var(--danger)', fontSize: 12 }}
              role="alert"
            >
              {actionError}
            </div>
          )}
        </header>

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

        <div className="detail-body" data-detail-body>
          <section className="detail-capabilities" aria-label="插件能力与授权">
            <h3>系统与隐私权限</h3>
            <p className="desc">{sensitivePermissions.length ? '以下操作需要你的授权，安装后可在插件设置中管理。' : '此插件未申请系统或隐私权限。'}</p>
            {sensitivePermissions.length > 0 ? (
              <div className="detail-chips">
                {sensitivePermissions.map((permission) => (
                  <span key={permission} className="detail-chip perm" title={permission}>{permissionLabel(permission)}</span>
                ))}
              </div>
            ) : null}
            <PluginBuiltinCapabilities />
          </section>
          {status === 'loading' && (
            <div className="detail-state">
              <div className="detail-spinner" aria-hidden="true" />
              <span>正在加载说明文档…</span>
            </div>
          )}
          {status === 'empty' && (
            <div className="detail-state">
              <strong>暂无说明文档</strong>
              <span>该插件尚未提供 README，可直接安装体验。</span>
            </div>
          )}
          {status === 'error' && (
            <div className="detail-state">
              <strong>加载失败</strong>
              <span>说明文档读取出错，请稍后重试。</span>
            </div>
          )}
          {status === 'ok' && <MarkdownView source={readme} baseUrl={plugin.readmeUrl} imageMap={plugin.readmeImages} />}
        </div>
      </div>
    </div>
  )
}
