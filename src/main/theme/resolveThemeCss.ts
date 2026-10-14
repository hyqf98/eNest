/**
 * resolveThemeCss — 主进程侧主题 Token 解析与 CSS 生成
 * 职责：根据 SettingsStore + 主题包 + nativeTheme（system 模式）解析出 light/dark tokens，
 * 生成可注入插件页的 CSS 文本，供 PluginHost / pluginProtocol 使用。
 * 被 PluginHost（executeJavaScript 注入）、pluginProtocol（__enest_theme.css）、
 * pluginHandlers（theme.getTokens）调用。
 * 关键依赖：electron nativeTheme、SettingsStore、themePacks。
 */
import { nativeTheme } from 'electron'
import type { PluginPreferredColorScheme } from '@shared/types/plugin'
import { resolveThemePalette } from '@shared/theme/presets'
import { settingsStore } from '@main/settings/SettingsStore'
import { themePackRegistry } from '@main/theme/themePacks'

/** 解析壳子当前 mode（system 走 nativeTheme）为 light/dark */
export function resolveShellColorScheme(): 'light' | 'dark' {
  const { mode } = settingsStore.getTheme()
  if (mode === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  return mode === 'dark' ? 'dark' : 'light'
}

export interface ResolvedThemeCss {
  mode: 'light' | 'dark'
  tokens: Record<string, string>
}

function customFontPayload(general: ReturnType<typeof settingsStore.getPluginAppearance>): Array<{ family: string; fileName: string }> {
  const stack = [general.fontFamilyEn, general.fontFamily].filter(Boolean).join(', ')
  return (general.customFonts || []).filter(font => stack.includes(font.family)).slice(0, 2)
    .map(font => ({ family: font.family, fileName: font.fileName }))
}

const themeCache = new Map<string, ResolvedThemeCss>()
let themeCacheHits = 0
let themeCacheMisses = 0
let themeCacheBuilds = 0
let themeCacheEvictions = 0

/** Keys encode theme overrides; expose counts only, never keys or token values. */
export function getThemeCacheMetrics() {
  return {
    hits: themeCacheHits, misses: themeCacheMisses, builds: themeCacheBuilds,
    evictions: themeCacheEvictions, entries: themeCache.size, capacity: 2
  }
}

/**
 * 解析最终注入插件页的 Token。
 * preferred=light/dark 时强制该配色；auto 时跟随壳子（含 system/nativeTheme）。
 * 叠加顺序：预设 → 活动主题包 → 用户 overrides（与壳子 applyToDom 一致）。
 */
export function resolveThemeTokens(
  preferred: PluginPreferredColorScheme = 'auto'
): ResolvedThemeCss {
  const theme = settingsStore.getTheme()
  let mode: 'light' | 'dark' = resolveShellColorScheme()
  if (preferred === 'light' || preferred === 'dark') mode = preferred

  const pack = theme.packId ? themePackRegistry.get(theme.packId) : null
  const overrides = (theme.overrides?.[mode] ?? {}) as Record<string, string>
  const key = JSON.stringify([mode, overrides, pack?.tokens ?? null])
  const cached = themeCache.get(key)
  if (cached) { themeCacheHits++; return cached }
  themeCacheMisses++
  const tokens = Object.freeze(resolveThemePalette(mode, overrides, pack?.tokens))
  const resolved = Object.freeze({ mode, tokens })
  themeCache.set(key, resolved)
  themeCacheBuilds++
  while (themeCache.size > 2) { themeCache.delete(themeCache.keys().next().value!); themeCacheEvictions++ }
  return resolved
}

/** 将 tokens 渲染为可直接写入页面的 CSS 文本 */
export function themeTokensToCss(
  resolved: ResolvedThemeCss,
  opts?: { transparent?: boolean }
): string {
  const lines = Object.entries(resolved.tokens).map(([k, v]) => `  ${k}: ${v};`)
  lines.push(`  color-scheme: ${resolved.mode};`)
  if (opts?.transparent) {
    lines.push('  background: transparent !important;')
  }
  return `:root, html {\n${lines.join('\n')}\n}\n`
}

/**
 * 生成注入用 JS：设置 data-theme + CSS 变量 + 可选透明底。
 * 使用 executeJavaScript 而非 <style>，避开 CSP 差异且可反复执行。
 */
export function themeTokensToInjectScript(
  resolved: ResolvedThemeCss,
  opts?: { transparent?: boolean }
): string {
  const general = settingsStore.getPluginAppearance()
  const payload = JSON.stringify({ ...resolved, transparent: Boolean(opts?.transparent), animationLevel: general.animationLevel || 'medium', font: [general.fontFamilyEn, general.fontFamily].filter(Boolean).join(', '), fontScale: Math.max(.9, Math.min(1.3, Number(general.fontSizeScale) || 1)), fonts: customFontPayload(general) })
  return `(() => {
  try {
    const payload = ${payload};
    const root = document.documentElement;
    root.dataset.theme = payload.mode;
    root.dataset.anim = payload.animationLevel;
    root.style.colorScheme = payload.mode;
    if (payload.font) root.style.setProperty('--font', payload.font);
    else root.style.removeProperty('--font');
    root.style.setProperty('--font-size-base', (13 * payload.fontScale) + 'px');
    const faces = window.__enestHostFonts || (window.__enestHostFonts = new Map());
    for (const [family, entry] of faces) if (!payload.fonts.some(font => font.family === family)) { document.fonts.delete(entry.face); faces.delete(family); }
    for (const font of payload.fonts) {
      const pluginId = location.pathname.split('/')[1];
      const url = 'enest://plugin/' + pluginId + '/__enest_fonts/' + encodeURIComponent(font.fileName);
      if (faces.get(font.family)?.url === url) continue;
      const previous = faces.get(font.family); if (previous) document.fonts.delete(previous.face);
      const face = new FontFace(font.family, 'url(' + JSON.stringify(url) + ')');
      faces.set(font.family, { url, face });
      face.load().then(loaded => { if (faces.get(font.family)?.face === face) document.fonts.add(loaded); }).catch(() => {});
    }
    for (const [k, v] of Object.entries(payload.tokens)) {
      if (k && v) root.style.setProperty(k, String(v));
    }
    if (payload.transparent) {
      root.style.background = 'transparent';
      if (document.body) document.body.style.background = 'transparent';
    }
  } catch (_) { /* ignore */ }
})()`
}
