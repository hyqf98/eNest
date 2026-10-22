import { THEME_TOKEN_PRESETS } from '@shared/theme/presets'
import { parseThemeColor } from '@shared/theme/colors'

export function colorWithPreservedAlpha(previous: string, next: string): string {
  const alpha = parseThemeColor(previous)?.[3] ?? 1
  const color = parseThemeColor(next)
  return alpha < 1 && color ? `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})` : next
}

/** 色卡需要 6 位 hex；透明边框仍展示实际 RGB 色，不使用无关占位色。 */
export function normalizeHex(c: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c
  if (/^#[0-9a-fA-F]{3}$/.test(c)) {
    const [r, g, b] = c.slice(1)
    return `#${r}${r}${g}${g}${b}${b}`
  }
  const rgb = c.match(/^rgba?\(\s*(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/i)
  if (rgb) {
    return '#' + rgb.slice(1, 4).map((value) =>
      Math.round(Math.max(0, Math.min(255, Number(value)))).toString(16).padStart(2, '0')
    ).join('')
  }
  return THEME_TOKEN_PRESETS.light['--accent']
}

/** 媒体 URL：http/blob/data/enest 直接用；绝对本地路径转 enest://media（Electron 协议） */
export function resolveMediaSrc(value: string): { src: string; playable: boolean; placeholder?: string } {
  if (!value) return { src: '', playable: false }
  if (/^(https?:|blob:|data:|enest:|enest-home:)/i.test(value)) {
    return { src: value, playable: true }
  }
  // POSIX / Windows 绝对路径 → 主进程 pluginProtocol 的 enest://media
  if (/^(\/|[a-zA-Z]:[\\/])/.test(value)) {
    return {
      src: `enest://media/?path=${encodeURIComponent(value)}`,
      playable: true,
      placeholder: value,
    }
  }
  return {
    src: '',
    playable: false,
    placeholder: value,
  }
}
