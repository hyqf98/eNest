import type { HomeResolvedAppearance, HomeAppearanceSnapshot } from '@shared/types/home'
import { appearanceStyleProperties, DEFAULT_NOTIFICATION_STYLE } from '@shared/theme/appearance'
import { applyLevelToDefaults } from '@renderer/gsap/marketMotion'
import { syncBackgroundAtmosphereTheme } from '@renderer/components/backgroundAtmosphere'

let appliedProperties = new Set<string>()
const fonts = new Map<string, { face: FontFace; url: string }>()

/** Called by an isolated workspace when its renderer is retired. */
export function releaseAppearanceResources(): void {
  for (const entry of fonts.values()) document.fonts.delete(entry.face)
  fonts.clear()
}

/** Apply the same semantic snapshot in every trusted renderer and release old resources. */
export function applyAppearanceToDom(appearance: HomeResolvedAppearance & { resources?: HomeAppearanceSnapshot['resources'] }): void {
  const root = document.documentElement
  root.dataset.theme = appearance.mode
  root.dataset.appearanceTheme = appearance.theme.id
  root.dataset.appearanceSource = appearance.theme.source
  root.dataset.appearanceLegacy = String(appearance.theme.legacy)
  root.dataset.appearanceLayout = appearance.layout.variant
  root.dataset.tabStyle = appearance.layout.tabStyle === 'orb' ? 'orb' : 'classic'
  const notifications = appearance.notifications ?? DEFAULT_NOTIFICATION_STYLE
  root.dataset.notificationLayout = notifications.layout
  root.dataset.notificationAccent = notifications.accent
  root.dataset.notificationShadow = notifications.shadow
  root.dataset.appearanceTexture = appearance.background.texture
  root.dataset.appearanceEffect = appearance.background.effect === 'none' ? 'none' : 'enabled'
  root.dataset.anim = appearance.animation.effective
  root.style.colorScheme = appearance.mode
  const properties = appearanceStyleProperties(appearance)
  for (const key of appliedProperties) if (!(key in properties)) root.style.removeProperty(key)
  for (const [key, value] of Object.entries(properties)) {
    if (value) root.style.setProperty(key, value)
    else root.style.removeProperty(key)
  }
  appliedProperties = new Set(Object.keys(properties))
  // The original shell uses a 14px baseline; opted-in business plugins keep 13px.
  root.style.setProperty('--font-size-base', `${14 * appearance.fonts.scale}px`)
  const hasEffect = appearance.background.effect !== 'none'
  root.classList.toggle('has-bg-media', hasEffect || !!appearance.background.media?.value)
  root.classList.toggle('has-bg-effect', hasEffect)
  root.style.setProperty('--bg-media-opacity', String(appearance.background.media?.opacity ?? 0.85))
  syncBackgroundAtmosphereTheme(root, appearance.background.media)
  applyLevelToDefaults(appearance.animation.effective)
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
