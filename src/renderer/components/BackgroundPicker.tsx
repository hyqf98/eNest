/**
 * BackgroundPicker — 壳子背景媒体选择器
 * 支持 none / color / image / video；选文件（pickMedia）、不透明度滑条、适配 cover|contain。
 * GIF 按静态图处理。路径以 http/blob/data 时可预览，本地绝对路径提示等待 enest:// 资源。
 * 依赖：useTheme（setBackground）、shellApi.pickMedia、@shared/types/plugin。
 */
import { useRef, useState } from 'react'
import type { BackgroundConfig, BackgroundType } from '@shared/types/plugin'
import { resolveMediaSrc, useThemeStore } from '../hooks/useTheme'
import { shellApi } from '../services/shellApi'
import { toastStore } from '../hooks/useToast'

const TYPE_OPTIONS: { id: BackgroundType; label: string }[] = [
  { id: 'none', label: '无' },
  { id: 'color', label: '纯色' },
  { id: 'image', label: '图片' },
  { id: 'video', label: '视频' },
]

const DEFAULT_BG: BackgroundConfig = {
  type: 'none',
  value: '',
  opacity: 0.45,
  fit: 'cover',
}

function isGif(path: string): boolean {
  return /\.gif(\?|#|$)/i.test(path)
}

function shortName(path: string): string {
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] || path
}

export function BackgroundPicker() {
  const background = useThemeStore((s) => s.background)
  const setBackground = useThemeStore((s) => s.setBackground)
  const [picking, setPicking] = useState(false)
  const colorInputRef = useRef<HTMLInputElement>(null)

  const cfg: BackgroundConfig = background ?? DEFAULT_BG

  const patch = (partial: Partial<BackgroundConfig>) => {
    const next: BackgroundConfig = { ...cfg, ...partial }
    void setBackground(next)
  }

  const setType = (type: BackgroundType) => {
    if (type === 'none') {
      void setBackground({ ...DEFAULT_BG, opacity: cfg.opacity, fit: cfg.fit })
      return
    }
    if (type === 'color') {
      void setBackground({
        type: 'color',
        value: cfg.type === 'color' && cfg.value ? cfg.value : '#1a1f2e',
        opacity: cfg.opacity,
        fit: cfg.fit,
      })
      return
    }
    // image / video：尽量沿用已有 value，或触发选文件
    if ((cfg.type === 'image' || cfg.type === 'video') && cfg.value) {
      void setBackground({ ...cfg, type })
      return
    }
    void setBackground({ ...cfg, type, value: cfg.value || '' })
    void pickFile(type)
  }

  async function pickFile(type: BackgroundType) {
    if (picking) return
    setPicking(true)
    try {
      const path = await shellApi.pickFile({ filters: 'media' })
      if (!path) return
      const finalType: BackgroundType = type === 'video' && isGif(path) ? 'image' : type
      void setBackground({
        type: finalType,
        value: path,
        opacity: cfg.opacity,
        fit: cfg.fit,
      })
    } catch {
      toastStore.getState().push('选择媒体失败')
    } finally {
      setPicking(false)
    }
  }

  const mediaPreviewable =
    (cfg.type === 'image' || cfg.type === 'video') && resolveMediaSrc(cfg.value).playable
  const mediaLocal =
    (cfg.type === 'image' || cfg.type === 'video') && cfg.value && !resolveMediaSrc(cfg.value).playable

  return (
    <div className="s-card">
      <h2>背景</h2>
      <p className="hint">类壁纸引擎：纯色 / 静态图 / 循环视频，可调不透明度与适配</p>

      <div className="bg-type-row" role="radiogroup" aria-label="背景类型">
        {TYPE_OPTIONS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={cfg.type === t.id}
            className={`chip${cfg.type === t.id ? ' active' : ''}`}
            onClick={() => setType(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {cfg.type === 'color' && (
        <div className="field">
          <div>
            <div className="label">背景颜色</div>
            <p className="desc">铺满整个壳子底层</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="swatch" style={{ background: cfg.value || '#1a1f2e' }} />
            <input
              ref={colorInputRef}
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(cfg.value) ? cfg.value : '#1a1f2e'}
              aria-label="背景颜色"
              onChange={(e) => patch({ value: e.target.value })}
            />
          </div>
        </div>
      )}

      {(cfg.type === 'image' || cfg.type === 'video') && (
        <div className="field">
          <div>
            <div className="label">{cfg.type === 'image' ? '背景图片' : '背景视频'}</div>
            <p className="desc">
              {cfg.value
                ? `当前：${shortName(cfg.value)}${isGif(cfg.value) ? '（GIF 按图片显示）' : ''}`
                : '从本地选择文件；视频将静音循环播放'}
            </p>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            disabled={picking}
            onClick={() => void pickFile(cfg.type)}
          >
            {cfg.value ? '更换文件' : '选择文件'}
          </button>
        </div>
      )}

      {cfg.type !== 'none' && (
        <>
          <div className="field">
            <div>
              <div className="label">不透明度</div>
              <p className="desc">{Math.round(cfg.opacity * 100)}%（降低以免干扰内容）</p>
            </div>
            <input
              type="range"
              min={0.05}
              max={1}
              step={0.05}
              value={cfg.opacity}
              aria-label="背景不透明度"
              onChange={(e) => patch({ opacity: Number(e.target.value) })}
            />
          </div>

          {(cfg.type === 'image' || cfg.type === 'video') && (
            <div className="field">
              <div>
                <div className="label">适配方式</div>
                <p className="desc">cover 铺满裁切 · contain 完整显示</p>
              </div>
              <div className="segmented" style={{ margin: 0 }}>
                {(['cover', 'contain'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={cfg.fit === f ? 'active' : ''}
                    onClick={() => patch({ fit: f })}
                  >
                    {f === 'cover' ? '铺满' : '完整'}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {mediaPreviewable && (
        <div className="bg-preview">
          {cfg.type === 'video' ? (
            <video src={resolveMediaSrc(cfg.value).src} muted loop playsInline autoPlay />
          ) : (
            <img src={resolveMediaSrc(cfg.value).src} alt="" />
          )}
        </div>
      )}
      {mediaLocal && (
        <p className="hint" style={{ margin: '8px 0 0' }}>
          本地路径已保存。Electron 下将由主进程以 enest://media 提供；浏览器预览暂无法加载{' '}
          <code>{shortName(cfg.value)}</code>
        </p>
      )}
    </div>
  )
}
