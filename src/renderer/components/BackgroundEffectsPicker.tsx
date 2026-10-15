import { memo, useId, type CSSProperties } from 'react'
import {
  BUILTIN_BACKGROUND_EFFECTS,
  listBackgroundEffects,
  resolveBackgroundEffect,
  type ResolvedBackgroundEffect,
} from '@shared/backgroundEffects'
import { useThemeStore } from '@renderer/hooks/useTheme'
import { useI18n } from '@renderer/hooks/useI18n'
import { notify } from '@renderer/services/notifyService'
import './backgroundEffectsPicker.css'

/** Static SVG previews keep the settings grid free of animation loops and WebGL contexts. */
function EffectThumbnail({ effect }: { effect: ResolvedBackgroundEffect }) {
  const id = useId().replace(/:/g, '')
  if (effect.renderer === 'video') {
    return (
      <span className="bg-effect-thumbnail bg-effect-video" aria-hidden="true">
        {effect.poster && <img src={effect.poster} alt="" loading="lazy" />}
        <svg viewBox="0 0 160 96"><path d="M71 33 96 48 71 63Z" /></svg>
      </span>
    )
  }
  const style = {
    '--effect-color': effect.colors?.[0] ?? '#81c9d7',
    '--effect-secondary': effect.colors?.[1] ?? '#426e9f',
    '--effect-highlight': effect.colors?.[2] ?? '#d2e9ec',
  } as CSSProperties
  return (
    <span className={`bg-effect-thumbnail bg-effect-${effect.preset}`} style={style} aria-hidden="true">
      <svg viewBox="0 0 160 96" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id={`${id}-light`} x1="0" y1="0" x2="1" y2="1">
            <stop stopColor="var(--effect-color)" stopOpacity=".75" />
            <stop offset="1" stopColor="var(--effect-secondary)" stopOpacity=".12" />
          </linearGradient>
        </defs>
        {effect.preset === 'fold' && (
          <g stroke="var(--effect-color)" strokeWidth=".7" fill={`url(#${id}-light)`}>
            <path d="M80 48 12-8 48-8Z M80 48 168 2 168 37Z M80 48 118 104 158 104Z M80 48 42 104 56 104Z M80 48-8 81-8 89Z" />
            <path d="M80 48 110-8 M80 48-8 15 M80 48 168 69" fill="none" opacity=".45" />
          </g>
        )}
        {effect.preset === 'aurora' && (
          <g fill="none" strokeLinecap="round">
            <path d="M-15 65C35 104 89 4 175 30" stroke="#3bb5a0" strokeWidth="15" opacity=".2" />
            <path d="M-15 67C35 100 89 8 175 30" stroke="#72d4b4" strokeWidth="3" opacity=".58" />
            <path d="M-15 16C44-12 88 96 175 57" stroke="#b4bf80" strokeWidth="12" opacity=".15" />
            <path d="M-15 16C44-12 88 96 175 57" stroke="#cbd2a5" strokeWidth="2" opacity=".52" />
          </g>
        )}
        {effect.preset === 'orbit' && (
          <g transform="rotate(-20 80 48)" fill="none">
            <ellipse cx="80" cy="48" rx="55" ry="28" stroke="#b9864b" strokeWidth="10" opacity=".18" />
            <ellipse cx="80" cy="48" rx="55" ry="28" stroke="#d7ac77" strokeWidth="3" opacity=".8" />
            <ellipse cx="80" cy="48" rx="59" ry="31" stroke="#8a7259" opacity=".6" />
            <ellipse cx="80" cy="48" rx="72" ry="38" stroke="var(--effect-color)" strokeWidth=".5" opacity=".35" />
            <circle cx="115" cy="26" r="2" fill="#edf1df" />
          </g>
        )}
        {effect.preset === 'ripple' && (
          <g fill="none" stroke="var(--effect-color)">
            <path d="M-9 13C22-5 8 43 33 38S40-8 70 7 68 38 103 29 130-7 170 8M-5 56C20 34 25 77 49 67S48 30 80 47 85 87 115 72 135 33 169 48M-8 91C19 71 34 103 63 90S70 66 94 87 133 87 173 79" strokeWidth="7" opacity=".12" />
            <path d="M-9 13C22-5 8 43 33 38S40-8 70 7 68 38 103 29 130-7 170 8M-5 56C20 34 25 77 49 67S48 30 80 47 85 87 115 72 135 33 169 48M-8 91C19 71 34 103 63 90S70 66 94 87 133 87 173 79" strokeWidth="1.1" opacity=".65" />
          </g>
        )}
        {effect.preset === 'tunnel' && (
          <g fill="none" stroke="var(--effect-color)" strokeWidth=".8">
            {[1, 1.4, 1.9, 2.5, 3.2, 4.1].map((scale, index) => (
              <polygon key={scale} points="80,28 98,38 98,58 80,68 62,58 62,38"
                transform={`translate(80 48) rotate(${index * 3}) scale(${scale}) translate(-80 -48)`}
                opacity={.3 + index * .1} />
            ))}
          </g>
        )}
      </svg>
    </span>
  )
}

export const BackgroundEffectsPicker = memo(function BackgroundEffectsPicker() {
  const selection = useThemeStore((state) => state.backgroundEffect)
  const packs = useThemeStore((state) => state.packs)
  const setBackgroundEffect = useThemeStore((state) => state.setBackgroundEffect)
  const { locale } = useI18n()
  const english = locale === 'en-US'
  const group = useId()
  const options = listBackgroundEffects(packs)
  const pluginOptions = options.filter((effect) => effect.source)
  const unavailable = selection !== 'none' && !options.some((effect) => effect.id === selection)
  const resolved = resolveBackgroundEffect(selection, packs)
  const name = (effect: ResolvedBackgroundEffect) => english ? effect.nameEn ?? effect.name : effect.name
  const select = (id: string) => {
    void setBackgroundEffect(id).catch(() => notify.error(english
      ? 'The background effect could not be saved. Please try again.'
      : '背景动效未保存，请重试'))
  }
  const card = (effect: ResolvedBackgroundEffect) => (
    <label key={effect.id} className={`bg-effect-card${selection === effect.id ? ' active' : ''}`}>
      <input type="radio" name={group} value={effect.id} checked={selection === effect.id} onChange={() => select(effect.id)} />
      <EffectThumbnail effect={effect} />
      <span className="bg-effect-name">{name(effect)}<span className="bg-effect-check" aria-hidden="true">✓</span></span>
      {effect.source && <span className="bg-effect-description">{effect.description}</span>}
      {effect.source && <span className="bg-effect-source" title={effect.source}>{effect.source}</span>}
    </label>
  )

  return (
    <section className="bg-effects-picker" aria-labelledby={`${group}-title`}>
      <div className="bg-effects-heading">
        <div>
          <h3 className="bg-section-label" id={`${group}-title`}>{english ? 'Background effects' : '背景动效'}</h3>
          <p className="hint">{english
            ? 'Shared by startup, the workspace and Quick.'
            : '启动画面、工作区和 Quick 共用。'}</p>
        </div>
      </div>
      <div className="bg-effects-choices" role="radiogroup" aria-labelledby={`${group}-title`}>
        <div className="bg-effects-actions">
          <label className={`chip bg-effect-off${selection === 'none' ? ' active' : ''}`}>
            <input type="radio" name={group} value="none" checked={selection === 'none'} onChange={() => select('none')} />
            {english ? 'Effects off' : '关闭动效'}
          </label>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => window.dispatchEvent(new Event('enest:preview-splash'))}>
            {english ? 'Replay startup' : '重播启动画面'}
          </button>
        </div>
        <div className="bg-effect-grid">{BUILTIN_BACKGROUND_EFFECTS.map(card)}</div>
        {pluginOptions.length > 0 && <>
          <div className="bg-effects-plugin-label">{english ? 'From theme plugins' : '主题插件提供'}</div>
          <div className="bg-effect-grid">{pluginOptions.map(card)}</div>
        </>}
      </div>
      {unavailable && resolved && (
        <p className="hint bg-effect-unavailable" role="status">{english
          ? `The selected plugin effect is unavailable. Using ${name(resolved)} for now; your selection will return when the plugin is available.`
          : `所选插件动效暂不可用，当前使用「${name(resolved)}」。原选择已保留，插件恢复后自动启用。`}</p>
      )}
    </section>
  )
})
