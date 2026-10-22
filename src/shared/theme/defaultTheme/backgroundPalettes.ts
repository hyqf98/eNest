import type { ThemeBackgroundPaletteDeclaration } from '@shared/types/appearance'
import { parseThemeColor } from '@shared/theme/colors'

/** Built-in ids are the closed union; pack-declared presets add arbitrary safe ids at runtime. */
interface BackgroundPalette { id: string; name: string; css: string; swatch: string }

const palettes: BackgroundPalette[] = [
  { id: 'theme', name: '随主题', css: 'radial-gradient(ellipse 90% 65% at 12% 0%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 68%), linear-gradient(165deg, var(--bg), var(--surface-2))', swatch: 'linear-gradient(135deg, var(--accent-soft), var(--surface-2))' },
  { id: 'dawn', name: '晨曦', css: 'radial-gradient(ellipse 90% 70% at 15% 0%, #e8c9b1 0%, transparent 65%), linear-gradient(165deg, #faf4eb 0%, #f2ebe1 55%, #e8ded2 100%)', swatch: 'linear-gradient(135deg,#e8c9b1,#f2ebe1)' },
  { id: 'mint', name: '薄荷', css: 'radial-gradient(ellipse 80% 55% at 10% 0%, #bdd5c8 0%, transparent 60%), linear-gradient(160deg, #f0f4ee 0%, #dce8df 55%, #e9efea 100%)', swatch: 'linear-gradient(135deg,#bdd5c8,#e9efea)' },
  { id: 'linen', name: '亚麻', css: 'radial-gradient(ellipse 75% 55% at 20% 0%, #e5ddce 0%, transparent 65%), linear-gradient(155deg, #f7f5ef 0%, #ece8df 55%, #e4e1d8 100%)', swatch: 'linear-gradient(135deg,#e5ddce,#f7f5ef)' },
  { id: 'peach', name: '陶土', css: 'radial-gradient(ellipse 80% 60% at 0% 0%, #d9b3a0 0%, transparent 62%), linear-gradient(170deg, #f6eee6 0%, #edddd0 55%, #e4cbb9 100%)', swatch: 'linear-gradient(135deg,#d9b3a0,#f6eee6)' },
  { id: 'ocean', name: '深海', css: 'radial-gradient(ellipse 85% 60% at 15% 0%, #39585e 0%, transparent 65%), linear-gradient(160deg, #233d43 0%, #1b2e34 55%, #192629 100%)', swatch: 'linear-gradient(135deg,#39585e,#192629)' },
  { id: 'forest', name: '松林', css: 'radial-gradient(ellipse 70% 50% at 20% 10%, #486354 0%, transparent 62%), linear-gradient(180deg, #2a4034 0%, #21332c 55%, #1a2924 100%)', swatch: 'linear-gradient(135deg,#486354,#1a2924)' },
  { id: 'ink', name: '石墨', css: 'radial-gradient(ellipse 70% 50% at 0% 0%, #464740 0%, transparent 65%), linear-gradient(155deg, #32332e 0%, #252622 55%, #1c1d1a 100%)', swatch: 'linear-gradient(135deg,#464740,#1c1d1a)' },
]

/** Original atmosphere presets, not theme identities or caller-authored CSS. */
export const DEFAULT_BACKGROUND_PALETTES: ReadonlyArray<Readonly<BackgroundPalette>> = Object.freeze(palettes.map(palette => Object.freeze(palette)))

/** The same function allowlist the renderer accepts, so a preset can never smuggle url() or a selector. */
const PALETTE_PAINT_FUNCTIONS = new Set([
  'linear-gradient', 'radial-gradient', 'conic-gradient',
  'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient',
  'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch',
  'color', 'color-mix', 'var', 'calc', 'min', 'max', 'clamp',
])

export function backgroundPalette(value: unknown): Readonly<BackgroundPalette> | undefined {
  return DEFAULT_BACKGROUND_PALETTES.find(palette => palette.id === value)
}

export function backgroundPaletteForCss(value: unknown): Readonly<BackgroundPalette> | undefined {
  return DEFAULT_BACKGROUND_PALETTES.find(palette => palette.css === value)
}

/** Do not widen this to arbitrary CSS gradients: these values cross the Home bridge. */
export function isSafeAppearanceBackgroundColor(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 1024 && (Boolean(parseThemeColor(value)) || Boolean(backgroundPaletteForCss(value)))
}

/** Pack-declared paints use the renderer allowlist; they are validated once at registration. */
export function isSafePalettePaint(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 1024) return false
  const text = value.trim()
  if (text !== value || /[\u0000-\u001f\u007f<>\\]/.test(text)) return false
  if (!/^[a-zA-Z0-9_#.,()%\s+\-]+$/.test(text)) return false
  for (const match of text.matchAll(/([a-zA-Z][a-zA-Z0-9-]*)\s*\(/g)) {
    if (!PALETTE_PAINT_FUNCTIONS.has(match[1].toLowerCase())) return false
  }
  return true
}

/** Built-in presets plus a pack's own declarations; host ids always win over a pack. */
export function paletteLibrary(
  declared?: ReadonlyArray<Readonly<ThemeBackgroundPaletteDeclaration>>,
): ReadonlyArray<Readonly<BackgroundPalette>> {
  if (!declared?.length) return DEFAULT_BACKGROUND_PALETTES
  const builtinIds = new Set<string>(DEFAULT_BACKGROUND_PALETTES.map(palette => palette.id))
  const extra = declared
    .filter(palette => !builtinIds.has(palette.id))
    .map(palette => Object.freeze({ ...palette, swatch: palette.swatch ?? palette.css }) as Readonly<BackgroundPalette>)
  return Object.freeze([...DEFAULT_BACKGROUND_PALETTES, ...extra])
}

/** Resolve a palette id against the built-ins and the active pack's declarations. */
export function paletteById(
  value: unknown,
  declared?: ReadonlyArray<Readonly<ThemeBackgroundPaletteDeclaration>>,
): Readonly<BackgroundPalette> | undefined {
  return paletteLibrary(declared).find(palette => palette.id === value)
}
