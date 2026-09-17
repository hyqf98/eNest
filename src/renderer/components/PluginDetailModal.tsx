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
import type { PluginPermission, PluginSummary } from '@shared/types/plugin'
import { shellApi } from '@renderer/services/shellApi'
import { playModalIn, playModalOut } from '@renderer/gsap/marketMotion'
import { MarkdownView } from '@renderer/components/MarkdownView'
import { useI18n } from '@renderer/hooks/useI18n'

/** 权限键 → 中文说明（未收录时原样展示） */
const PERMISSION_LABELS: Partial<Record<PluginPermission, string>> = {
  'clipboard.read': '读取剪贴板',
  'clipboard.write': '写入剪贴板',
  'shell.openExternal': '打开外部链接',
  'storage.local': '本地存储',
  notify: '系统通知',
  'ui.setTitle': '设置标题',
  'ui.setIcon': '设置图标',
  'ui.setBadge': '设置角标',
  'ui.resize': '调整窗口',
  'ui.toast': '应用内提示',
  'settings.register': '注册设置',
}

type ReadmeStatus = 'loading' | 'ok' | 'empty' | 'error'

interface Props {
  plugin: PluginSummary
  /** 关闭弹窗（动画结束后由子组件回调） */
  onClose: () => void
  /** 安装完成后打开插件（sample 同步安装成功时调用） */
  onInstall: (id: string) => void
}

function iconBackground(p: PluginSummary): string {
  return `linear-gradient(145deg, ${p.color}, color-mix(in srgb, ${p.color} 50%, #111))`
}

export function PluginDetailModal({ plugin, onClose, onInstall }: Props) {
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
  const { t } = useI18n()

  const disabled = plugin.installed && !enabled
  const updateVersion = plugin.latestVersion

  /** 先播退场，再通知父级卸载 */
  const requestClose = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    void playModalOut(rootRef.current).then(onClose)
  }, [onClose])

  // 入场动画
  useEffect(() => {
    playModalIn(rootRef.current)
  }, [plugin.id])

  // plugin 变更时同步 enabled
  useEffect(() => {
    setEnabled(plugin.enabled !== false)
    setActionError(null)
  }, [plugin.id, plugin.enabled])

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
      /* 失败 toast 已由 uninstall-result 事件覆盖；恢复按钮可重试 */
      setUninstalling(false)
    }
  }

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
            {plugin.glyph}
          </div>
          <div className="detail-meta" data-detail-meta>
            <h2 id="plugin-detail-title">{plugin.name}</h2>
            <div className="detail-sub">
              {plugin.author} · v{plugin.version}
              {updateVersion ? ` · ${t('plugin.updateAvailable', { version: updateVersion })}` : ''}
            </div>
            <div className="detail-chips" data-detail-chips>
              <span className="detail-chip">{plugin.category}</span>
              <span className="detail-chip">★ {plugin.installs}</span>
              {plugin.installed ? (
                <span className="detail-chip ok">
                  {disabled ? t('plugin.disabled') : t('plugin.installed')}
                </span>
              ) : null}
              {plugin.permissions.map((perm) => (
                <span key={perm} className="detail-chip perm" title={perm}>
                  {PERMISSION_LABELS[perm] ?? perm}
                </span>
              ))}
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
              style={{ gridColumn: '1 / -1', color: 'var(--danger, #f87171)', fontSize: 12 }}
              role="alert"
            >
              {actionError}
            </div>
          )}
        </header>

        <div className="detail-body" data-detail-body>
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
          {status === 'ok' && <MarkdownView source={readme} />}
        </div>
      </div>
    </div>
  )
}
