/**
 * BackgroundPicker — 壳子背景选择器
 * none / color（含预设渐变色卡）/ image / video；不透明度与 cover|contain。
 * 渐变作为 CSS background 写入 color.value，由 AppBackground 直接铺底。
 * 依赖：useTheme（setBackground）、shellApi.pickFile、@shared/types/plugin。
 */
import { useRef, useState } from 'react'
import type { BackgroundConfig, BackgroundType } from '@shared/types/plugin'
import { resolveMediaSrc, useThemeStore } from '@renderer/hooks/useTheme'
import { shellApi } from '@renderer/services/shellApi'
import { toastStore } from '@renderer/hooks/useToast'

const TYPE_OPTIONS: { id: BackgroundType; label: string }[] = [
  { id: 'none', label: '无' },
  { id: 'color', label: '氛围色' },
  { id: 'image', label: '图片' },
  { id: 'video', label: '视频' },
]

/** 预设氛围背景：柔和多层渐变，避免生硬纯色 */
export const BG_GRADIENTS: { id: string; name: string; css: string; swatch: string }[] = [
  {
    id: 'dawn',
    name: '晨曦',
    css: 'radial-gradient(ellipse 90% 70% at 15% 0%, #fde68a 0%, transparent 55%), radial-gradient(ellipse 70% 60% at 85% 10%, #fda4af 0%, transparent 50%), linear-gradient(165deg, #fef3c7 0%, #e0e7ff 45%, #fce7f3 100%)',
    swatch: 'linear-gradient(135deg,#fde68a,#fda4af,#c7d2fe)',
  },
  {
    id: 'mint',
    name: '薄荷',
    css: 'radial-gradient(ellipse 80% 55% at 10% 0%, #6ee7b7 0%, transparent 50%), radial-gradient(ellipse 60% 50% at 90% 80%, #67e8f9 0%, transparent 50%), linear-gradient(160deg, #ecfdf5 0%, #e0f2fe 50%, #f0fdfa 100%)',
    swatch: 'linear-gradient(135deg,#6ee7b7,#67e8f9)',
  },
  {
    id: 'lavender',
    name: '薰衣草',
    css: 'radial-gradient(ellipse 75% 55% at 20% 0%, #c4b5fd 0%, transparent 50%), radial-gradient(ellipse 65% 50% at 85% 70%, #f0abfc 0%, transparent 48%), linear-gradient(155deg, #f5f3ff 0%, #ede9fe 40%, #fae8ff 100%)',
    swatch: 'linear-gradient(135deg,#c4b5fd,#f0abfc)',
  },
  {
    id: 'peach',
    name: '蜜桃',
    css: 'radial-gradient(ellipse 80% 60% at 0% 0%, #fdba74 0%, transparent 52%), radial-gradient(ellipse 70% 50% at 100% 30%, #f9a8d4 0%, transparent 50%), linear-gradient(170deg, #fff7ed 0%, #ffedd5 45%, #fce7f3 100%)',
    swatch: 'linear-gradient(135deg,#fdba74,#f9a8d4)',
  },
  {
    id: 'ocean',
    name: '深海',
    css: 'radial-gradient(ellipse 85% 60% at 15% 0%, #38bdf8 0%, transparent 50%), radial-gradient(ellipse 70% 55% at 85% 80%, #818cf8 0%, transparent 48%), linear-gradient(160deg, #0c4a6e 0%, #1e1b4b 50%, #0f172a 100%)',
    swatch: 'linear-gradient(135deg,#38bdf8,#818cf8,#0f172a)',
  },
  {
    id: 'aurora',
    name: '极光',
    css: 'radial-gradient(ellipse 70% 50% at 20% 10%, #34d399 0%, transparent 50%), radial-gradient(ellipse 65% 45% at 80% 0%, #22d3ee 0%, transparent 48%), radial-gradient(ellipse 55% 40% at 60% 90%, #a78bfa 0%, transparent 45%), linear-gradient(180deg, #022c22 0%, #0f172a 55%, #1e1b4b 100%)',
    swatch: 'linear-gradient(135deg,#34d399,#22d3ee,#a78bfa)',
  },
  {
    id: 'ink',
    name: '墨色',
    css: 'radial-gradient(ellipse 70% 50% at 0% 0%, rgba(148,163,184,0.35) 0%, transparent 55%), radial-gradient(ellipse 50% 40% at 100% 100%, rgba(99,102,241,0.25) 0%, transparent 50%), linear-gradient(155deg, #1e293b 0%, #0f172a 50%, #020617 100%)',
    swatch: 'linear-gradient(135deg,#475569,#1e293b,#020617)',
  },
  {
    id: 'sand',
    name: '暖沙',
    css: 'radial-gradient(ellipse 80% 55% at 10% 0%, #fcd34d 0%, transparent 50%), radial-gradient(ellipse 60% 45% at 90% 60%, #fb923c 0%, transparent 45%), linear-gradient(165deg, #fffbeb 0%, #fef3c7 40%, #ffedd5 100%)',
    swatch: 'linear-gradient(135deg,#fcd34d,#fb923c)',
  },
]

/** 默认选中「薰衣草」——柔和不抢内容 */
const DEFAULT_GRADIENT = BG_GRADIENTS[2]

const DEFAULT_BG: BackgroundConfig = {
  type: 'none',
  value: '',
  opacity: 0.85,
  fit: 'cover',
}

function isGif(path: string): boolean {
  return /\.gif(\?|#|$)/i.test(path)
}

function shortName(path: string): string {
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] || path
}

/** 从 CSS 字符串反查预设 id（用于高亮） */
function matchGradientId(value: string): string | null {
  if (!value) return null
  const hit = BG_GRADIENTS.find((g) => g.css === value)
  return hit?.id ?? null
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
        value:
          cfg.type === 'color' && cfg.value
            ? cfg.value
            : DEFAULT_GRADIENT.css,
        opacity: cfg.opacity,
        fit: cfg.fit,
      })
      return
    }
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

  const activeGradId = cfg.type === 'color' ? matchGradientId(cfg.value) : null
  const customSolid =
    cfg.type === 'color' &&
    cfg.value &&
    !activeGradId &&
    /^#[0-9a-fA-F]{3,8}$/.test(cfg.value)

  return (
    <div className="s-card">
      <h2>背景</h2>
      <p className="hint">预设氛围渐变，或用图片 / 循环视频；可调不透明度</p>

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
        <>
          <div className="bg-grad-grid" role="listbox" aria-label="氛围渐变">
            {BG_GRADIENTS.map((g) => {
              const active = activeGradId === g.id
              return (
                <button
                  key={g.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`bg-grad-card${active ? ' active' : ''}`}
                  title={g.name}
                  onClick={() => patch({ value: g.css, opacity: active && cfg.opacity > 0.7 ? 0.85 : cfg.opacity })}
                >
                  <span className="bg-grad-face" style={{ background: g.css }} />
                  <span className="bg-grad-name">{g.name}</span>
                </button>
              )
            })}
          </div>

          <div className="field">
            <div>
              <div className="label">自定义色</div>
              <p className="desc">仍可选用单色铺底</p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="swatch" style={{ background: customSolid ? cfg.value : '#e2e8f0' }} />
              <input
                ref={colorInputRef}
                type="color"
                value={customSolid ? cfg.value : '#64748b'}
                aria-label="自定义背景颜色"
                onChange={(e) => patch({ value: e.target.value })}
              />
            </div>
          </div>
        </>
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
              min={0.15}
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
