/**
 * BackgroundPicker — 壳子背景 + 启动画面（合并卡片）
 * 壳子背景：none / color（预设渐变）/ image / video；不透明度与 cover|contain。
 * 启动画面：品牌色 / 主题色 / 自定义图片，写入 settings.general.splashBackground。
 * 依赖：useTheme（setBackground）、shellApi、resolveMediaSrc、@shared/types/plugin。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  BackgroundConfig,
  BackgroundType,
  SplashBackgroundConfig,
  SplashBackgroundType
} from '@shared/types/plugin'
import { resolveMediaSrc, useThemeStore } from '@renderer/hooks/useTheme'
import { Segmented } from '@renderer/components/ui/Segmented'
import { shellApi } from '@renderer/services/shellApi'
import { toastStore } from '@renderer/hooks/useToast'
import { useI18n } from '@renderer/hooks/useI18n'
import { backgroundAtmosphereStyle } from './backgroundAtmosphere'
import { BackgroundEffectsPicker } from './BackgroundEffectsPicker'
import { ColorPickerField } from './ColorPickerField'

const TYPE_OPTIONS: { id: BackgroundType; label: string }[] = [
  { id: 'none', label: '无' },
  { id: 'color', label: '氛围色' },
  { id: 'image', label: '图片' },
  { id: 'video', label: '视频' },
]

/** 低饱和氛围色；「随主题」直接引用 Token，颜色微调后立即同步。 */
export const BG_GRADIENTS: { id: string; name: string; css: string; swatch: string }[] = [
  {
    id: 'theme',
    name: '随主题',
    css: 'radial-gradient(ellipse 90% 65% at 12% 0%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 68%), linear-gradient(165deg, var(--bg), var(--surface-2))',
    swatch: 'linear-gradient(135deg, var(--accent-soft), var(--surface-2))',
  },
  {
    id: 'dawn',
    name: '晨曦',
    css: 'radial-gradient(ellipse 90% 70% at 15% 0%, #e8c9b1 0%, transparent 65%), linear-gradient(165deg, #faf4eb 0%, #f2ebe1 55%, #e8ded2 100%)',
    swatch: 'linear-gradient(135deg,#e8c9b1,#f2ebe1)',
  },
  {
    id: 'mint',
    name: '薄荷',
    css: 'radial-gradient(ellipse 80% 55% at 10% 0%, #bdd5c8 0%, transparent 60%), linear-gradient(160deg, #f0f4ee 0%, #dce8df 55%, #e9efea 100%)',
    swatch: 'linear-gradient(135deg,#bdd5c8,#e9efea)',
  },
  {
    id: 'linen',
    name: '亚麻',
    css: 'radial-gradient(ellipse 75% 55% at 20% 0%, #e5ddce 0%, transparent 65%), linear-gradient(155deg, #f7f5ef 0%, #ece8df 55%, #e4e1d8 100%)',
    swatch: 'linear-gradient(135deg,#e5ddce,#f7f5ef)',
  },
  {
    id: 'peach',
    name: '陶土',
    css: 'radial-gradient(ellipse 80% 60% at 0% 0%, #d9b3a0 0%, transparent 62%), linear-gradient(170deg, #f6eee6 0%, #edddd0 55%, #e4cbb9 100%)',
    swatch: 'linear-gradient(135deg,#d9b3a0,#f6eee6)',
  },
  {
    id: 'ocean',
    name: '深海',
    css: 'radial-gradient(ellipse 85% 60% at 15% 0%, #39585e 0%, transparent 65%), linear-gradient(160deg, #233d43 0%, #1b2e34 55%, #192629 100%)',
    swatch: 'linear-gradient(135deg,#39585e,#192629)',
  },
  {
    id: 'forest',
    name: '松林',
    css: 'radial-gradient(ellipse 70% 50% at 20% 10%, #486354 0%, transparent 62%), linear-gradient(180deg, #2a4034 0%, #21332c 55%, #1a2924 100%)',
    swatch: 'linear-gradient(135deg,#486354,#1a2924)',
  },
  {
    id: 'ink',
    name: '石墨',
    css: 'radial-gradient(ellipse 70% 50% at 0% 0%, #464740 0%, transparent 65%), linear-gradient(155deg, #32332e 0%, #252622 55%, #1c1d1a 100%)',
    swatch: 'linear-gradient(135deg,#464740,#1c1d1a)',
  },
]

const DEFAULT_GRADIENT = BG_GRADIENTS[0]

const DEFAULT_BG: BackgroundConfig = {
  type: 'none',
  value: '',
  opacity: 0.85,
  fit: 'cover',
}

const SPLASH_DEFAULT: SplashBackgroundConfig = {
  type: 'brand',
  opacity: 0.55,
}

const SPLASH_TYPES: { id: SplashBackgroundType; labelKey: string; descKey: string }[] = [
  { id: 'brand', labelKey: 'settings.splash.typeBrand', descKey: 'settings.splash.typeBrandDesc' },
  { id: 'none', labelKey: 'settings.splash.typeNone', descKey: 'settings.splash.typeNoneDesc' },
  { id: 'image', labelKey: 'settings.splash.typeImage', descKey: 'settings.splash.typeImageDesc' },
]

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
  const backgroundEffect = useThemeStore((s) => s.backgroundEffect)
  const { t, locale } = useI18n()
  const english = locale === 'en-US'
  const hasEffect = backgroundEffect !== 'none'
  const [picking, setPicking] = useState(false)
  const [opacityDraft, setOpacityDraft] = useState<number | null>(null)
  const pendingOpacity = useRef<number | null>(null)
  const opacityFrame = useRef<number | null>(null)
  const applyOpacityPreview = useCallback(() => {
    if (opacityFrame.current !== null) cancelAnimationFrame(opacityFrame.current)
    opacityFrame.current = null
    const opacity = pendingOpacity.current
    pendingOpacity.current = null
    const state = useThemeStore.getState()
    if (opacity !== null && state.background && state.background.type !== 'none') {
      state.previewBackground({ ...state.background, opacity })
    }
  }, [])
  const commitOpacity = useCallback(() => {
    applyOpacityPreview()
    void useThemeStore.getState().flushBackgroundPreview()
    setOpacityDraft(null)
  }, [applyOpacityPreview])
  const previewOpacity = (opacity: number): void => {
    setOpacityDraft(opacity)
    pendingOpacity.current = opacity
    if (opacityFrame.current === null) opacityFrame.current = requestAnimationFrame(applyOpacityPreview)
  }
  useEffect(() => {
    window.addEventListener('blur', commitOpacity)
    return () => {
      window.removeEventListener('blur', commitOpacity)
      applyOpacityPreview()
      void useThemeStore.getState().flushBackgroundPreview()
    }
  }, [applyOpacityPreview, commitOpacity])

  /** 启动画面（并入本卡片） */
  const [splash, setSplash] = useState<SplashBackgroundConfig>(SPLASH_DEFAULT)
  const [splashPicking, setSplashPicking] = useState(false)
  const splashSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const settings = await shellApi.getSettings()
        if (cancelled) return
        const raw = settings.general?.splashBackground
        if (raw && typeof raw === 'object' && raw.type) {
          setSplash({
            type: raw.type,
            value: raw.value ?? '',
            opacity: typeof raw.opacity === 'number' ? raw.opacity : SPLASH_DEFAULT.opacity,
          })
        }
      } catch {
        /* 默认 brand */
      }
    })()
    return () => {
      cancelled = true
      if (splashSaveTimer.current) clearTimeout(splashSaveTimer.current)
    }
  }, [])

  const persistSplash = (next: SplashBackgroundConfig) => {
    setSplash(next)
    if (splashSaveTimer.current) clearTimeout(splashSaveTimer.current)
    splashSaveTimer.current = setTimeout(() => {
      void shellApi
        .setSettings({ general: { splashBackground: next } })
        .then(() => toastStore.getState().push(t('settings.splash.saved')))
        .catch(() => undefined)
    }, 300)
  }

  const setSplashType = (type: SplashBackgroundType) => {
    if (type === 'image') {
      const keep = splash.type === 'image' ? splash : SPLASH_DEFAULT
      persistSplash({
        ...keep,
        type: 'image',
        value: splash.value ?? '',
        opacity: splash.opacity ?? SPLASH_DEFAULT.opacity,
      })
      if (!splash.value) void pickSplashImage()
      return
    }
    persistSplash({ type, opacity: splash.opacity })
  }

  async function pickSplashImage() {
    if (splashPicking) return
    setSplashPicking(true)
    try {
      const path = await shellApi.pickFile({ filters: 'image' })
      if (!path) return
      persistSplash({
        type: 'image',
        value: path,
        opacity: splash.opacity ?? SPLASH_DEFAULT.opacity,
      })
    } catch {
      toastStore.getState().push(t('settings.splash.pickFailed'))
    } finally {
      setSplashPicking(false)
    }
  }

  const splashActive = SPLASH_TYPES.find((o) => o.id === splash.type) ?? SPLASH_TYPES[0]
  const splashPhoto =
    splash.type === 'image' && splash.value ? resolveMediaSrc(splash.value) : null
  const splashPhotoOk = !!splashPhoto?.playable && !!splashPhoto.src

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
    void setBackground({ ...cfg, type, value: '' })
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
      <h2>{english ? 'Background' : '背景'}</h2>
      <BackgroundEffectsPicker />
      <div className="bg-merge-divider" />

      <div className="bg-section-label">{english ? 'Atmosphere & custom background' : '氛围色与自定义背景'}</div>
      {hasEffect && <p className="hint">{english ? 'Images and videos appear when background effects are off.' : '关闭背景动效后，图片和视频才会显示。'}</p>}

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
            </div>
            <ColorPickerField value={customSolid ? cfg.value : '#d6cfc2'} label="自定义背景"
              onChange={hex => useThemeStore.getState().previewBackground({ ...cfg, value: hex })} />
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
              <div className="label">{cfg.type === 'color' ? '氛围强度' : '不透明度'}</div>
              <p className="desc">{Math.round((opacityDraft ?? cfg.opacity) * 100)}%</p>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={opacityDraft ?? cfg.opacity}
              aria-label={cfg.type === 'color' ? '氛围强度' : '背景不透明度'}
              onChange={(e) => previewOpacity(Number(e.target.value))}
              onPointerDown={e => e.currentTarget.setPointerCapture(e.pointerId)}
              onPointerUp={commitOpacity}
              onPointerCancel={commitOpacity}
              onKeyUp={commitOpacity}
              onBlur={commitOpacity}
            />
          </div>

          {(cfg.type === 'image' || cfg.type === 'video') && (
            <div className="field">
              <div>
                <div className="label">适配方式</div>
              </div>
              <Segmented
                style={{ margin: 0 }}
                value={cfg.fit}
                onChange={(fit) => patch({ fit })}
                options={[
                  { value: 'cover' as const, label: '铺满' },
                  { value: 'contain' as const, label: '完整' }
                ]}
              />
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
          浏览器预览无法加载本地文件，桌面端可正常显示：{' '}
          <code>{shortName(cfg.value)}</code>
        </p>
      )}

      {/* —— 启动画面：与壳子背景同卡片 —— */}
      <div className="bg-merge-divider" />
      <div className="bg-section-label">{t('settings.splash.title')}</div>
      {hasEffect || backgroundAtmosphereStyle(background) ? (
        <p className="hint bg-effects-unified-note">{english
          ? 'The selected effect and atmosphere colors also apply to startup. Turn effects off and clear atmosphere colors to use a separate startup background.'
          : '所选背景动效和氛围色会统一应用到启动画面。关闭动效并清除氛围色后，可单独配置启动背景。'}</p>
      ) : <>
      <p className="hint">{english ? 'Applies on the next startup.' : '下次启动生效。'}</p>
      <div className="field" style={{ borderTop: 'none', paddingTop: 0 }}>
        <div>
          <div className="label">{t('settings.splash.type')}</div>
          <p className="desc">{t(splashActive.descKey)}</p>
        </div>
        <div
          className="bg-type-row"
          role="radiogroup"
          aria-label={t('settings.splash.type')}
          style={{ margin: 0 }}
        >
          {SPLASH_TYPES.map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={splash.type === opt.id}
              className={`chip${splash.type === opt.id ? ' active' : ''}`}
              onClick={() => setSplashType(opt.id)}
            >
              {t(opt.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {splash.type === 'image' && (
        <>
          <div className="field">
            <div>
              <div className="label">{t('settings.splash.image')}</div>
              <p className="desc">
                {splash.value
                  ? t('settings.splash.imageDesc', { name: shortName(splash.value) })
                  : t('settings.splash.imageEmpty')}
              </p>
            </div>
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              disabled={splashPicking}
              onClick={() => void pickSplashImage()}
            >
              {splash.value ? t('settings.splash.change') : t('settings.splash.pick')}
            </button>
          </div>
          <div className="field">
            <div>
              <div className="label">{t('settings.splash.opacity')}</div>
              <p className="desc">
                {t('settings.splash.opacityDesc', {
                  value: String(
                    Math.round(((splash.opacity ?? SPLASH_DEFAULT.opacity) as number) * 100)
                  ),
                })}
              </p>
            </div>
            <input
              type="range"
              min={0.15}
              max={1}
              step={0.05}
              value={splash.opacity ?? SPLASH_DEFAULT.opacity}
              aria-label={t('settings.splash.opacity')}
              onChange={(e) =>
                persistSplash({
                  ...splash,
                  type: 'image',
                  value: splash.value ?? '',
                  opacity: Number(e.target.value),
                })
              }
            />
          </div>
        </>
      )}

      {splashPhotoOk && splashPhoto && (
        <div className="bg-preview splash-bg-preview">
          <img src={splashPhoto.src} alt="" />
        </div>
      )}
      {splash.type === 'image' && splash.value && !splashPhotoOk && (
        <p className="hint" style={{ margin: '8px 0 0' }}>
          {t('settings.splash.localOnly')} <code>{shortName(splash.value)}</code>
        </p>
      )}
      </>}
    </div>
  )
}
