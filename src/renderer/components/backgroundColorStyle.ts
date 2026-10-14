import type { CSSProperties } from 'react'

const SAFE_FUNCTIONS = new Set([
  'linear-gradient', 'radial-gradient', 'conic-gradient',
  'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient',
  'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch',
  'color', 'color-mix', 'var', 'calc', 'min', 'max', 'clamp'
])

/** Preserve existing color/gradient presets without interpreting legacy values as resource URLs. */
export function backgroundColorStyle(value: string): CSSProperties {
  const text = value.trim()
  if (!text || text.length > 4096 || !/^[a-zA-Z0-9_#.,()%\s+\-]+$/.test(text)) return {}
  for (const match of text.matchAll(/([a-zA-Z][a-zA-Z0-9-]*)\s*\(/g)) {
    if (!SAFE_FUNCTIONS.has(match[1].toLowerCase())) return {}
  }
  if (/^(?:repeating-)?(?:linear|radial|conic)-gradient\(/i.test(text)) {
    return { backgroundImage: text }
  }
  return { backgroundColor: text }
}
