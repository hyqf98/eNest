/**
 * PluginDetailModal — 插件详情弹窗
 * 大图头（图标/名称/作者/版本/分类/安装量/权限）+ 安装/打开与关闭操作 + README Markdown 正文。
 * README 经 shellApi.getPluginReadme 异步拉取；GSAP 控制遮罩模糊与内容 stagger 入退场。
 * 使用方：MarketPage（卡片/轮播点击打开）。依赖：MarkdownView、marketMotion、shellApi。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PluginPermission, PluginSummary } from '@shared/types/plugin'
import { shellApi } from '@renderer/services/shellApi'
import { playModalIn, playModalOut } from '@renderer/gsap/marketMotion'
import { MarkdownView } from '@renderer/components/MarkdownView'

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
  /** 安装 / 打开插件 */
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

  const actionLabel = plugin.installed ? '打开' : '安装'

  const handleInstall = () => {
    onInstall(plugin.id)
    requestClose()
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
            style={{ background: iconBackground(plugin) }}
          >
            {plugin.glyph}
          </div>
          <div className="detail-meta" data-detail-meta>
            <h2 id="plugin-detail-title">{plugin.name}</h2>
            <div className="detail-sub">
              {plugin.author} · v{plugin.version}
            </div>
            <div className="detail-chips" data-detail-chips>
              <span className="detail-chip">{plugin.category}</span>
              <span className="detail-chip">★ {plugin.installs}</span>
              {plugin.installed ? <span className="detail-chip ok">已安装</span> : null}
              {plugin.permissions.map((perm) => (
                <span key={perm} className="detail-chip perm" title={perm}>
                  {PERMISSION_LABELS[perm] ?? perm}
                </span>
              ))}
            </div>
          </div>
          <div className="detail-actions" data-detail-actions>
            <button type="button" className="btn btn-primary" onClick={handleInstall}>
              {actionLabel}
            </button>
            <button type="button" className="btn btn-ghost" onClick={requestClose}>
              关闭
            </button>
          </div>
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
