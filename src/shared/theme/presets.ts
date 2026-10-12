/**
 * theme presets — light/dark 内置 Token 预设（单一事实来源）
 * 与 tokens.css 的 :root / [data-theme="dark"] 保持一致；
 * 壳子 useTheme（renderer）与主进程 resolveThemeCss（注入插件 / orb 圆轨）共用。
 * 修改任一色值时三处同步：本文件 + tokens.css +（如涉及）useTheme 文案。
 */
import { compositeThemeColor, parseThemeColor } from '@shared/theme/colors'

export const THEME_TOKEN_PRESETS: Record<'light' | 'dark', Record<string, string>> = {
  light: {
    '--bg': '#f6f6f4',
    '--surface': '#ffffff',
    '--surface-2': '#eeefed',
    '--surface-3': '#e5e7e4',
    '--border': 'rgba(41,44,46,0.08)',
    '--border-strong': 'rgba(41,44,46,0.16)',
    '--text': '#292c2e',
    '--text-2': '#666c70',
    '--text-3': '#82888b',
    '--accent': '#bd542b',
    '--ok': '#318469',
    '--danger': '#c54f46',
    '--link': '#bd542b'
  },
  dark: {
    '--bg': '#17191b',
    '--surface': '#202326',
    '--surface-2': '#292d31',
    '--surface-3': '#33383d',
    '--border': 'rgba(242,243,243,0.09)',
    '--border-strong': 'rgba(242,243,243,0.16)',
    '--text': '#f2f3f3',
    '--text-2': '#adb3b8',
    '--text-3': '#7e878f',
    '--accent': '#e98654',
    '--ok': '#77bfa4',
    '--danger': '#e79589',
    '--link': '#e98654'
  }
}

function luminance(channels: number[]): number {
  const linear = channels.slice(0, 3).map((channel) => {
    const value = Math.max(0, Math.min(255, channel)) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
}

/** 与主题允许的颜色语法一致；半透明强调色先叠到底色上再计算对比度。 */
function accentContrast(tokens: Record<string, string>, mode: 'light' | 'dark'): string {
  const accent = parseThemeColor(tokens['--accent'])
  if (!accent) return mode === 'light' ? '#ffffff' : '#292c2e'
  const presetBg = parseThemeColor(THEME_TOKEN_PRESETS[mode]['--bg'])!
  const background = compositeThemeColor(parseThemeColor(tokens['--bg']) ?? presetBg, presetBg)
  const surface = compositeThemeColor(parseThemeColor(tokens['--surface']) ?? background, background)
  const value = luminance(compositeThemeColor(accent, surface))
  const whiteContrast = 1.05 / (value + 0.05)
  const charcoalContrast = (value + 0.05) / (luminance([41, 44, 46]) + 0.05)
  return whiteContrast >= charcoalContrast ? '#ffffff' : '#292c2e'
}

/** 派生色与当前 Token 同步；主题包和用户显式提供的派生色仍然优先。 */
export function resolveThemePalette(
  mode: 'light' | 'dark',
  overrides: Record<string, string> = {},
  packTokens: Record<string, string> = {}
): Record<string, string> {
  const explicit = { ...packTokens, ...overrides }
  const tokens = { ...THEME_TOKEN_PRESETS[mode], ...explicit }
  const soft = mode === 'light' ? 12 : 16
  const derived = {
    '--accent-contrast': accentContrast(tokens, mode),
    '--accent-soft': `color-mix(in srgb, ${tokens['--accent']} ${soft}%, transparent)`,
    '--ok-soft': `color-mix(in srgb, ${tokens['--ok']} ${soft}%, transparent)`,
    '--danger-soft': `color-mix(in srgb, ${tokens['--danger']} ${soft}%, transparent)`,
    '--link': tokens['--accent'],
    '--glow-color': tokens['--accent'],
    '--bg-dot': `color-mix(in srgb, ${tokens['--text']} 5%, transparent)`,
    '--border-dashed': tokens['--border-strong'],
  }
  return { ...tokens, ...derived, ...explicit }
}
