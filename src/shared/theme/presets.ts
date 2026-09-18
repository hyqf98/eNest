/**
 * theme presets — light/dark 内置 Token 预设（单一事实来源）
 * 与 tokens.css 的 :root / [data-theme="dark"] 保持一致；
 * 壳子 useTheme（renderer）与主进程 resolveThemeCss（注入插件 / orb 圆轨）共用。
 * 修改任一色值时三处同步：本文件 + tokens.css +（如涉及）useTheme 文案。
 */
export const THEME_TOKEN_PRESETS: Record<'light' | 'dark', Record<string, string>> = {
  light: {
    '--bg': '#f6f6f7',
    '--surface': '#ffffff',
    '--surface-2': '#f4f4f5',
    '--surface-3': '#ebebee',
    '--border': 'rgba(24,24,27,0.08)',
    '--border-strong': 'rgba(24,24,27,0.14)',
    '--text': '#18181b',
    '--text-2': '#52525b',
    '--text-3': '#a1a1aa',
    '--accent': '#5e6ad2',
    '--ok': '#2a9d76',
    '--danger': '#e2556b',
    '--link': '#7b86d4'
  },
  dark: {
    '--bg': '#121214',
    '--surface': '#1a1a1e',
    '--surface-2': '#222226',
    '--surface-3': '#2c2c32',
    '--border': 'rgba(255,255,255,0.09)',
    '--border-strong': 'rgba(255,255,255,0.16)',
    '--text': '#f4f4f5',
    '--text-2': '#a1a1aa',
    '--text-3': '#71717a',
    '--accent': '#a5aeef',
    '--ok': '#3dd68c',
    '--danger': '#ff8a9a',
    '--link': '#9aa3e8'
  }
}
