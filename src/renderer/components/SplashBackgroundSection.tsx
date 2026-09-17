/**
 * SplashBackgroundSection — 设置 → 主题「启动背景」
 * 类型：品牌色 / 主题色（关闭自定义）/ 自定义图片（pickFile + 不透明度）。
 * 变更写入 settings.general.splashBackground，下次冷启动 Splash 生效。
 * 依赖：useI18n、shellApi、resolveMediaSrc、@shared/types/plugin。
 */
import { useEffect, useRef, useState } from 'react'
import type { SplashBackgroundConfig, SplashBackgroundType } from '@shared/types/plugin'
import { resolveMediaSrc } from '@renderer/hooks/useTheme'
import { shellApi } from '@renderer/services/shellApi'
import { useI18n } from '@renderer/hooks/useI18n'
import { toastStore } from '@renderer/hooks/useToast'

const DEFAULT_OPACITY = 0.55

const DEFAULT_CFG: SplashBackgroundConfig = {
  type: 'brand',
  opacity: DEFAULT_OPACITY,
}

const TYPE_OPTIONS: { id: SplashBackgroundType; labelKey: string; descKey: string }[] = [
  { id: 'brand', labelKey: 'settings.splash.typeBrand', descKey: 'settings.splash.typeBrandDesc' },
  { id: 'none', labelKey: 'settings.splash.typeNone', descKey: 'settings.splash.typeNoneDesc' },
  { id: 'image', labelKey: 'settings.splash.typeImage', descKey: 'settings.splash.typeImageDesc' },
]

function shortName(path: string): string {
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] || path
}

export function SplashBackgroundSection() {
  const { t } = useI18n()
  const [cfg, setCfg] = useState<SplashBackgroundConfig>(DEFAULT_CFG)
  const [picking, setPicking] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const settings = await shellApi.getSettings()
        if (cancelled) return
        const raw = settings.general?.splashBackground
        if (raw && typeof raw === 'object' && raw.type) {
          setCfg({
            type: raw.type,
            value: raw.value ?? '',
            opacity: typeof raw.opacity === 'number' ? raw.opacity : DEFAULT_OPACITY,
          })
        }
      } catch {
        /* 读取失败保持默认 brand */
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => {
      cancelled = true
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [])

  const persist = (next: SplashBackgroundConfig) => {
    setCfg(next)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void shellApi
        .setSettings({ general: { splashBackground: next } })
        .then(() => toastStore.getState().push(t('settings.splash.saved')))
        .catch(() => undefined)
    }, 300)
  }

  const setType = (type: SplashBackgroundType) => {
    if (type === 'image') {
      const keep = cfg.type === 'image' ? cfg : DEFAULT_CFG
      persist({ ...keep, type: 'image', value: cfg.value ?? '', opacity: cfg.opacity ?? DEFAULT_OPACITY })
      if (!cfg.value) void pickImage()
      return
    }
    persist({ type, opacity: cfg.opacity })
  }

  async function pickImage() {
    if (picking) return
    setPicking(true)
    try {
      const path = await shellApi.pickFile({ filters: 'image' })
      if (!path) return
      persist({
        type: 'image',
        value: path,
        opacity: cfg.opacity ?? DEFAULT_OPACITY,
      })
    } catch {
      toastStore.getState().push(t('settings.splash.pickFailed'))
    } finally {
      setPicking(false)
    }
  }

  const activeType = TYPE_OPTIONS.find((o) => o.id === cfg.type) ?? TYPE_OPTIONS[0]
  const photo = cfg.type === 'image' && cfg.value ? resolveMediaSrc(cfg.value) : null
  const photoPlayable = !!photo?.playable && !!photo.src

  return (
    <div className="s-card splash-bg-settings">
      <h2>{t('settings.splash.title')}</h2>
      <p className="hint">{t('settings.splash.hint')}</p>

      <div className="field">
        <div>
          <div className="label">{t('settings.splash.type')}</div>
          <p className="desc">{t(activeType.descKey)}</p>
        </div>
        <div className="bg-type-row" role="radiogroup" aria-label={t('settings.splash.type')} style={{ margin: 0 }}>
          {TYPE_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={cfg.type === opt.id}
              className={`chip${cfg.type === opt.id ? ' active' : ''}`}
              onClick={() => setType(opt.id)}
            >
              {t(opt.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {cfg.type === 'image' && (
        <div className="field">
          <div>
            <div className="label">{t('settings.splash.image')}</div>
            <p className="desc">
              {cfg.value
                ? t('settings.splash.imageDesc', { name: shortName(cfg.value) })
                : t('settings.splash.imageEmpty')}
            </p>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            disabled={picking || !loaded}
            onClick={() => void pickImage()}
          >
            {cfg.value ? t('settings.splash.change') : t('settings.splash.pick')}
          </button>
        </div>
      )}

      {cfg.type === 'image' && (
        <div className="field">
          <div>
            <div className="label">{t('settings.splash.opacity')}</div>
            <p className="desc">
              {t('settings.splash.opacityDesc', {
                value: String(Math.round((cfg.opacity ?? DEFAULT_OPACITY) * 100)),
              })}
            </p>
          </div>
          <input
            type="range"
            min={0.15}
            max={1}
            step={0.05}
            value={cfg.opacity ?? DEFAULT_OPACITY}
            aria-label={t('settings.splash.opacity')}
            onChange={(e) =>
              persist({
                ...cfg,
                type: 'image',
                value: cfg.value ?? '',
                opacity: Number(e.target.value),
              })
            }
          />
        </div>
      )}

      {photoPlayable && photo && (
        <div className="bg-preview splash-bg-preview">
          <img src={photo.src} alt="" />
        </div>
      )}
      {cfg.type === 'image' && cfg.value && !photoPlayable && (
        <p className="hint" style={{ margin: '8px 0 0' }}>
          {t('settings.splash.localOnly')} <code>{shortName(cfg.value)}</code>
        </p>
      )}
    </div>
  )
}
