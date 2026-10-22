/**
 * resolveThemeCss — 主进程侧主题 Token 解析与 CSS 生成
 * 消费 appearanceService 的权威快照，生成插件页的 CSS 与注入脚本。
 * 旧调用方仅提供 tokens 时，保留原有字体和动画兼容视图。
 */
import type { PluginPreferredColorScheme } from '@shared/types/plugin'
import type { ResolvedAppearance } from '@shared/types/appearance'
import { appearanceStyleProperties } from '@shared/theme/appearance'
import scrollbarCss from '@shared/theme/scrollbar.css?raw'
import { settingsStore } from '@main/settings/SettingsStore'
import { appearanceService } from '@main/theme/appearanceService'

export interface ResolvedThemeCss {
  mode: 'light' | 'dark'
  tokens: Record<string, string>
  appearance?: ResolvedAppearance
}

const themeCache = new Map<string, ResolvedThemeCss>()
let themeCacheHits = 0
let themeCacheMisses = 0
let themeCacheBuilds = 0
let themeCacheEvictions = 0

/** Keys encode authoritative appearance revisions; expose counts only, never keys or token values. */
export function getThemeCacheMetrics() {
  return {
    hits: themeCacheHits, misses: themeCacheMisses, builds: themeCacheBuilds,
    evictions: themeCacheEvictions, entries: themeCache.size, capacity: 2
  }
}

/**
 * 解析最终注入插件页的 Token。
 * preferred=light/dark 时强制该配色；auto 时跟随壳子（含 system/nativeTheme）。
 * 解析规则只由 appearanceService 管理；这里按 revision 缓存注入 DTO。
 */
export function resolveThemeTokens(
  preferred: PluginPreferredColorScheme = 'auto'
): ResolvedThemeCss {
  const appearance = appearanceService.getAppearance(preferred)
  const key = JSON.stringify([appearance.revision, appearance.mode, appearance.requestedMode])
  const cached = themeCache.get(key)
  if (cached) { themeCacheHits++; return cached }
  themeCacheMisses++
  const resolved = Object.freeze({ mode: appearance.mode, tokens: appearance.tokens, appearance })
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
  const lines = Object.entries(resolved.appearance ? appearanceStyleProperties(resolved.appearance, { baseFontSize: 13 }) : resolved.tokens).map(([k, v]) => `  ${k}: ${v};`)
  lines.push(`  color-scheme: ${resolved.mode};`)
  if (opts?.transparent) {
    lines.push('  background: transparent !important;')
  }
  return `:root, html {\n${lines.join('\n')}\n}\n${scrollbarCss}`
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
  const appearance = resolved.appearance
  const fontStack = appearance ? [appearance.fonts.body, appearance.fonts.heading, appearance.fonts.mono].join(',') : [general.fontFamilyEn, general.fontFamily].filter(Boolean).join(', ')
  const selected = new Set(fontStack.split(',').map(value => value.trim().replace(/^(["'])(.*)\1$/, '$2')))
  const fonts = (general.customFonts ?? []).filter(font => selected.has(font.family)).slice(0, 8).map(font => ({ family: font.family, fileName: font.fileName }))
  const payload = JSON.stringify({ mode: resolved.mode, tokens: appearance ? appearanceStyleProperties(appearance, { baseFontSize: 13 }) : resolved.tokens,
    themeId: appearance?.theme.id, layout: appearance?.layout.variant,
    transparent: Boolean(opts?.transparent), animationLevel: appearance?.animation.effective ?? general.animationLevel ?? 'medium',
    font: appearance?.fonts.body ?? [general.fontFamilyEn, general.fontFamily].filter(Boolean).join(', '), fontScale: appearance?.fonts.scale ?? Math.max(.9, Math.min(1.3, Number(general.fontSizeScale) || 1)), fonts })
  return `(() => {
  try {
    const payload = ${payload};
    const root = document.documentElement;
    root.dataset.theme = payload.mode;
    root.dataset.anim = payload.animationLevel;
    if (payload.themeId) root.dataset.appearanceTheme = payload.themeId;
    if (payload.layout) root.dataset.appearanceLayout = payload.layout;
    root.style.colorScheme = payload.mode;
    if (!document.getElementById('enest-host-scrollbars')) {
      const style = document.createElement('style');
      style.id = 'enest-host-scrollbars';
      style.textContent = ${JSON.stringify(scrollbarCss)};
      (document.head || root).appendChild(style);
    }
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
    const oldKeys = window.__enestHostTokenKeys || [];
    for (const key of oldKeys) if (!(key in payload.tokens)) root.style.removeProperty(key);
    window.__enestHostTokenKeys = Object.keys(payload.tokens);
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
