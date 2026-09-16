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
import { settingsStore } from '../settings/SettingsStore'
import { themePackRegistry } from './themePacks'

/** 与壳子 useTheme THEME_PRESETS 对齐的内置 Token（主进程侧副本，避免 renderer 依赖） */
export const THEME_TOKEN_PRESETS: Record<'light' | 'dark', Record<string, string>> = {
  light: {
    '--bg': '#f4f5f7',
    '--surface': '#ffffff',
    '--surface-2': '#f0f2f5',
    '--surface-3': '#e8ebf0',
    '--border': 'rgba(15,23,42,0.08)',
    '--border-strong': 'rgba(15,23,42,0.14)',
    '--text': '#0f1420',
    '--text-2': '#5c6578',
    '--text-3': '#8b93a5',
    '--accent': '#1a1f2e',
    '--ok': '#0d9f6e',
    '--danger': '#e11d48'
  },
  dark: {
    '--bg': '#0a0c10',
    '--surface': '#12151c',
    '--surface-2': '#171b24',
    '--surface-3': '#1e2430',
    '--border': 'rgba(255,255,255,0.06)',
    '--border-strong': 'rgba(255,255,255,0.12)',
    '--text': '#f2f4f8',
    '--text-2': '#9aa3b5',
    '--text-3': '#5e677a',
    '--accent': '#f2f4f8',
    '--ok': '#3ecf8e',
    '--danger': '#ff6b81'
  }
}

function hexToRgba(hex: string, alpha: number): string {
  if (!hex.startsWith('#')) return hex
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  if (full.length < 6) return hex
  const n = parseInt(full, 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

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
  const tokens: Record<string, string> = {
    ...THEME_TOKEN_PRESETS[mode],
    ...(pack?.tokens ?? {}),
    ...overrides
  }
  const ok = tokens['--ok'] || THEME_TOKEN_PRESETS[mode]['--ok']
  tokens['--ok-soft'] = hexToRgba(ok, mode === 'light' ? 0.1 : 0.12)
  return { mode, tokens }
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
  const payload = JSON.stringify({ ...resolved, transparent: Boolean(opts?.transparent) })
  return `(() => {
  try {
    const payload = ${payload};
    const root = document.documentElement;
    root.dataset.theme = payload.mode;
    root.style.colorScheme = payload.mode;
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
