/** Background choices are data only. The host owns rendering and binds plugin sources. */
import type { BackgroundConfig, BackgroundEffectDefinition, BackgroundEffectPreset, ThemePack, ThemeTokens } from '@shared/types/plugin'
import { isPluginAssetPath } from '@shared/pluginContract'

export type ResolvedBackgroundEffect = BackgroundEffectDefinition & {
  nameEn?: string
  /** Undefined for the host's built-in effects. */
  source?: string
}

export const DEFAULT_BACKGROUND_EFFECT: BackgroundEffectPreset = 'tunnel'
export const MAX_BACKGROUND_EFFECTS_PER_PACK = 8

/** Resolve the same background source for the shell, launch/Quick and detached chrome. */
export function resolveThemeBackground(theme: Pick<ThemeTokens, 'packId' | 'background' | 'backgroundSource'>, packs: readonly ThemePack[]): BackgroundConfig | null {
  const pack = theme.packId ? packs.find((item) => item.id === theme.packId) : undefined
  if (theme.backgroundSource === 'pack') return pack?.background ?? null
  if (theme.backgroundSource === 'user') return theme.background ?? null
  return theme.background ?? pack?.background ?? null
}

export const BUILTIN_BACKGROUND_EFFECTS: readonly ResolvedBackgroundEffect[] = [
  { id: 'fold', name: '空间折叠', nameEn: 'Spatial Fold', description: '折面交错展开，光线沿边缘流动', renderer: 'preset', preset: 'fold', logoStyle: 'fold' },
  { id: 'aurora', name: '极光绸缎', nameEn: 'Aurora Silk', description: '青绿与淡金的绸带缓缓交叠', renderer: 'preset', preset: 'aurora', logoStyle: 'aurora' },
  { id: 'orbit', name: '引力光环', nameEn: 'Gravity Orbit', description: '冷白光沿橙金色引力盘环绕', renderer: 'preset', preset: 'orbit', logoStyle: 'orbit' },
  { id: 'ripple', name: '液态波纹', nameEn: 'Liquid Ripple', description: '光线随液态表面缓缓起伏', renderer: 'preset', preset: 'ripple', logoStyle: 'ripple' },
  { id: 'tunnel', name: '光域隧道', nameEn: 'Light Tunnel', description: '六边形光框展开纵深空间', renderer: 'preset', preset: 'tunnel', logoStyle: 'tunnel' },
]

const PRESETS = new Set<string>(['fold', 'aurora', 'orbit', 'ripple', 'tunnel'])
const EFFECT_ID = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/
const SOURCE_ID = /^[a-z0-9]+(?:\.[a-z0-9-]+)+$/
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/
const COMMON_FIELDS = ['id', 'name', 'description', 'renderer', 'logoStyle']

/** Encode each component separately so colons and percent escapes cannot collide. */
export function getPluginBackgroundEffectId(source: string, packId: string, effectId: string): string {
  return `plugin:${encodeURIComponent(source)}:${encodeURIComponent(packId)}:${encodeURIComponent(effectId)}`
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}

function ownedMedia(value: unknown, source: string, video: boolean): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('background effect media must be a plugin asset URL')
  const prefix = `enest://plugin/${source}/`
  if (!value.startsWith(prefix)) throw new Error('background effect media must belong to its source plugin')
  // Check the raw path before URL normalization can erase a ../ segment.
  const rawPath = value.slice(prefix.length)
  let asset: string
  try { asset = decodeURIComponent(rawPath) } catch { throw new Error('invalid background effect media encoding') }
  if (!asset.startsWith('assets/') || !isPluginAssetPath(asset)) throw new Error('invalid background effect media path')
  if (!(video ? /\.(mp4|webm)$/i : /\.(png|jpe?g|webp|avif|gif)$/i).test(asset)) {
    throw new Error('unsupported background effect media format')
  }
  const url = new URL(value)
  if (url.protocol !== 'enest:' || url.hostname !== 'plugin' || url.port || url.username || url.password || url.search || url.hash
      || decodeURIComponent(url.pathname) !== `/${source}/${asset}`) {
    throw new Error('invalid background effect media URL')
  }
  return url.href
}

/** Shared strict validator: registration fails atomically; persisted data is checked again. */
export function validateBackgroundEffects(value: unknown, source: string): BackgroundEffectDefinition[] {
  if (!validText(source, 256) || !SOURCE_ID.test(source)) throw new Error('invalid background effect source')
  if (!Array.isArray(value) || value.length > MAX_BACKGROUND_EFFECTS_PER_PACK) {
    throw new Error(`backgroundEffects must contain at most ${MAX_BACKGROUND_EFFECTS_PER_PACK} effects`)
  }
  const ids = new Set<string>()
  return [...value].map((item): BackgroundEffectDefinition => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid background effect definition')
    const effect = item as Record<string, unknown>
    const renderer = effect.renderer
    if (renderer !== 'preset' && renderer !== 'video') throw new Error('unsupported background effect renderer')
    const allowed = new Set([...COMMON_FIELDS, ...(renderer === 'preset' ? ['preset', 'colors', 'speed'] : ['video', 'poster'])])
    if (Object.keys(effect).some((key) => !allowed.has(key))) throw new Error('unknown background effect field')
    if (typeof effect.id !== 'string' || !EFFECT_ID.test(effect.id) || ids.has(effect.id)) throw new Error('invalid or duplicate background effect id')
    ids.add(effect.id)
    if (!validText(effect.name, 64)) throw new Error('invalid background effect name')
    if (effect.description !== undefined && !validText(effect.description, 200)) throw new Error('invalid background effect description')
    if (effect.logoStyle !== undefined && (typeof effect.logoStyle !== 'string' || !PRESETS.has(effect.logoStyle))) {
      throw new Error('invalid background effect logoStyle')
    }
    const base = {
      id: effect.id,
      name: effect.name,
      ...(effect.description !== undefined ? { description: effect.description as string } : {}),
      ...(effect.logoStyle !== undefined ? { logoStyle: effect.logoStyle as BackgroundEffectPreset } : {}),
    }
    if (renderer === 'video') {
      return { ...base, renderer, video: ownedMedia(effect.video, source, true),
        ...(effect.poster !== undefined ? { poster: ownedMedia(effect.poster, source, false) } : {}) }
    }
    if (typeof effect.preset !== 'string' || !PRESETS.has(effect.preset)) throw new Error('invalid background effect preset')
    if (effect.speed !== undefined && (typeof effect.speed !== 'number' || !Number.isFinite(effect.speed) || effect.speed < 0.25 || effect.speed > 2)) {
      throw new Error('background effect speed must be between 0.25 and 2')
    }
    if (effect.colors !== undefined && (!Array.isArray(effect.colors) || effect.colors.length !== 3
      || ![...effect.colors].every((color) => typeof color === 'string' && HEX_COLOR.test(color)))) {
      throw new Error('background effect colors must contain three six-digit hex colors')
    }
    return { ...base, renderer, preset: effect.preset as BackgroundEffectPreset,
      ...(effect.speed !== undefined ? { speed: effect.speed as number } : {}),
      ...(effect.colors !== undefined ? { colors: [...effect.colors as string[]] as [string, string, string] } : {}) }
  })
}

export function listBackgroundEffects(packs: readonly ThemePack[] = []): ResolvedBackgroundEffect[] {
  const effects = BUILTIN_BACKGROUND_EFFECTS.map((effect) => ({ ...effect }))
  const seen = new Set(effects.map((effect) => effect.id))
  for (const pack of packs) {
    if (!pack || !validText(pack.id, 128) || !pack.backgroundEffects) continue
    try {
      for (const definition of validateBackgroundEffects(pack.backgroundEffects, pack.source)) {
        const id = getPluginBackgroundEffectId(pack.source, pack.id, definition.id)
        if (seen.has(id)) continue
        seen.add(id)
        effects.push({ ...definition, id, source: pack.source })
      }
    } catch { /* Invalid persisted/mock inputs never become renderable choices. */ }
  }
  return effects
}

export function resolveBackgroundEffect(selection: string | undefined, packs: readonly ThemePack[] = []): ResolvedBackgroundEffect | null {
  if (selection === 'none') return null
  const effects = listBackgroundEffects(packs)
  return effects.find((effect) => effect.id === selection)
    ?? effects.find((effect) => effect.id === DEFAULT_BACKGROUND_EFFECT)!
}
