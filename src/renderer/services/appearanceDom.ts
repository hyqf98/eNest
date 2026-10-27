import type { HomeResolvedAppearance, HomeAppearanceSnapshot } from '@shared/types/home'
import { appearanceStyleProperties, DEFAULT_NOTIFICATION_STYLE } from '@shared/theme/appearance'
import { applyLevelToDefaults } from '@renderer/gsap/marketMotion'
import { syncBackgroundAtmosphereTheme } from '@renderer/components/backgroundAtmosphere'

let appliedProperties = new Set<string>()
let appliedRoot: HTMLElement | null = null
let appliedMediaKey = ''
let appliedLevel: HomeResolvedAppearance['animation']['effective'] | undefined
const fonts = new Map<string, { face: FontFace; url: string }>()

/** Called by an isolated workspace when its renderer is retired. */
export function releaseAppearanceResources(): void {
  for (const entry of fonts.values()) document.fonts.delete(entry.face)
  fonts.clear()
}

/** Apply the same semantic snapshot in every trusted renderer and release old resources. */
export function applyAppearanceToDom(appearance: HomeResolvedAppearance & { resources?: HomeAppearanceSnapshot['resources'] }): void {
  const root = document.documentElement
  if (appliedRoot !== root) {
    appliedRoot = root
    appliedProperties = new Set()
    appliedMediaKey = ''
    appliedLevel = undefined
  }
  const notifications = appearance.notifications ?? DEFAULT_NOTIFICATION_STYLE
  const attributes = {
    theme: appearance.mode, appearanceTheme: appearance.theme.id, appearanceSource: appearance.theme.source,
    appearanceLegacy: String(appearance.theme.legacy), appearanceLayout: appearance.layout.variant,
    tabStyle: appearance.layout.tabStyle === 'orb' ? 'orb' : 'classic',
    notificationLayout: notifications.layout, notificationAccent: notifications.accent, notificationShadow: notifications.shadow,
    appearanceTexture: appearance.background.texture, appearanceEffect: appearance.background.effect === 'none' ? 'none' : 'enabled',
    anim: appearance.animation.effective,
  }
  for (const [key, value] of Object.entries(attributes)) if (root.dataset[key] !== value) root.dataset[key] = value
  if (root.style.colorScheme !== appearance.mode) root.style.colorScheme = appearance.mode
  const setProperty = (key: string, value: string) => {
    if (root.style.getPropertyValue(key) === value) return
    if (value) root.style.setProperty(key, value)
    else root.style.removeProperty(key)
  }
  const properties = appearanceStyleProperties(appearance)
  for (const key of appliedProperties) if (!(key in properties)) setProperty(key, '')
  for (const [key, value] of Object.entries(properties)) setProperty(key, value || '')
  appliedProperties = new Set(Object.keys(properties))
  // The original shell uses a 14px baseline; opted-in business plugins keep 13px.
  setProperty('--font-size-base', `${14 * appearance.fonts.scale}px`)
  const hasEffect = appearance.background.effect !== 'none'
  const hasMedia = hasEffect || !!appearance.background.media?.value
  if (root.classList.contains('has-bg-media') !== hasMedia) root.classList.toggle('has-bg-media', hasMedia)
  if (root.classList.contains('has-bg-effect') !== hasEffect) root.classList.toggle('has-bg-effect', hasEffect)
  setProperty('--bg-media-opacity', String(appearance.background.media?.opacity ?? 0.85))
  const mediaKey = JSON.stringify(appearance.background.media ?? null)
  if (appliedMediaKey !== mediaKey) {
    syncBackgroundAtmosphereTheme(root, appearance.background.media)
    appliedMediaKey = mediaKey
  }
  if (appliedLevel !== appearance.animation.effective) {
    applyLevelToDefaults(appearance.animation.effective)
    appliedLevel = appearance.animation.effective
  }
  const resources = appearance.resources?.fonts ?? []
  for (const [family, entry] of fonts) if (!resources.some(font => font.family === family && font.url === entry.url)) {
    document.fonts.delete(entry.face)
    fonts.delete(family)
  }
  for (const resource of resources) {
    if (fonts.get(resource.family)?.url === resource.url || !/^enest(?:-home)?:\/\/appearance\/font\/[a-f0-9]{64}$/.test(resource.url)) continue
    const face = new FontFace(resource.family, `url(${JSON.stringify(resource.url)})`)
    fonts.set(resource.family, { face, url: resource.url })
    void face.load().then(loaded => { if (fonts.get(resource.family)?.face === face) document.fonts.add(loaded) }).catch(() => undefined)
  }
}
