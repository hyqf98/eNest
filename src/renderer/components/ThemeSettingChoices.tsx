import { useId, type CSSProperties } from 'react'
import { BUILTIN_BACKGROUND_EFFECTS, type ResolvedBackgroundEffect } from '@shared/backgroundEffects'
import { paletteById } from '@shared/theme/defaultTheme/backgroundPalettes'
import type { ThemeBackgroundPaletteDeclaration, ThemeSettingOption } from '@shared/types/appearance'
import type { ThemeSettingPresentation } from '@shared/theme/settingsPresentation'
import { Segmented } from '@renderer/components/ui/Segmented'
import { Button } from '@renderer/components/ui/Button'

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

/** Static previews never run theme markup, animation loops or WebGL contexts. */
function OptionThumbnail({ option, palettes, gradientCards }: { option: ThemeSettingOption; palettes?: ReadonlyArray<ThemeBackgroundPaletteDeclaration>; gradientCards: boolean }) {
  const preview = option.preview
  const swatchClass = gradientCards ? 'theme-gradient-preview' : 'bg-effect-thumbnail'
  if (preview?.kind === 'asset') {
    return <span className="bg-effect-thumbnail" aria-hidden="true"><img src={preview.src} alt="" loading="lazy" /></span>
  }
  if (preview?.kind === 'swatch') {
    const background = `linear-gradient(135deg, ${preview.stops[0]}, ${preview.stops[1]})`
    return <span className={swatchClass} style={{ background }} aria-hidden="true" />
  }
  const effect = BUILTIN_BACKGROUND_EFFECTS.find(item => item.id === option.value)
  if (effect) return <EffectThumbnail effect={effect} />
  // 含本主题声明的配色，这样自定义 palette 不是一排占位符。
  const palette = paletteById(option.value, palettes)
  if (palette) return <span className={swatchClass} style={{ background: palette.swatch }} aria-hidden="true" />
  return <span className="bg-effect-thumbnail bg-effect-none" aria-hidden="true">—</span>
}

interface Props {
  label: string
  presentation: ThemeSettingPresentation
  options: ThemeSettingOption[]
  value: string | number | boolean | null
  /** Active pack declarations, so custom atmosphere presets can render their swatch. */
  palettes?: ReadonlyArray<ThemeBackgroundPaletteDeclaration>
  disabled?: boolean
  onChange: (value: string | number | boolean | null) => void
}

export function ThemeSettingChoices({ label, presentation, options, value, palettes, disabled, onChange }: Props) {
  const selected = options.findIndex(option => option.value === value)
  if (presentation === 'segmented') return <Segmented className={`theme-setting-segmented${options.length > 3 ? ' theme-setting-segmented-many' : ''}`} ariaLabel={label} disabled={disabled} value={String(selected)} options={options.map((option, index) => ({ value: String(index), label: option.label }))} onChange={index => { const option = options[Number(index)]; if (option) onChange(option.value) }} />
  // 整组都是渐变缩略图时沿用配色卡的网格与样式；否则按效果卡呈现。纯粹由数据推导，不读主题 ID。
  const gradientCards = options.every(option => option.preview?.kind === 'swatch' || (option.preview === undefined && Boolean(paletteById(option.value, palettes))))
  const gridClass = gradientCards ? 'theme-gradient-grid' : 'bg-effect-grid'
  const cardClass = gradientCards ? 'theme-gradient-card' : 'bg-effect-card'
  return <div className={gridClass} role="group" aria-label={label}
    style={{ '--theme-choice-columns': Math.min(options.length || 1, Math.max(4, Math.ceil(options.length / 2))) } as CSSProperties}>
    {options.map((option, index) => (
      <Button key={index} disabled={disabled} className={cardClass + (option.value === value ? ' active' : '')} aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
        <OptionThumbnail option={option} palettes={palettes} gradientCards={gradientCards} />
        <span className="bg-effect-name"><span className="bg-effect-label" title={option.label}>{option.label}</span><span className="bg-effect-check" aria-hidden="true">✓</span></span>
      </Button>
    ))}
  </div>
}
