/**
 * useTheme — 主题模式 / 颜色 Token / 主题包 / 背景媒体统一管理
 * 支持 light | dark | system（matchMedia 跟随系统），data-theme 始终写入已解析的 light/dark。
 * 可应用主题包 tokens 与 BackgroundConfig；hydrate 启动时从 shellApi 拉取并监听系统主题变化。
 * 依赖：shellApi（getTheme/setTheme）、toastStore、@shared/types/plugin。
 */
import { create } from 'zustand'
import type { BackgroundConfig, ThemeMode, ThemePack, ThemeTokens } from '@shared/types/plugin'
import { THEME_TOKEN_PRESETS } from '@shared/theme/presets'
import { shellApi } from '@renderer/services/shellApi'
import { toastStore } from '@renderer/hooks/useToast'

/** light/dark 预设颜色 Token（取自 @shared 单一来源）+ 中文标签（system 解析后套用对应预设） */
export const THEME_PRESETS = {
  light: { label: '浅色', ...THEME_TOKEN_PRESETS.light },
  dark: { label: '深色', ...THEME_TOKEN_PRESETS.dark },
} as const

export type { ThemeMode }
/** 解析后的实际主题（system 会落到 light 或 dark） */
export type ResolvedThemeMode = 'light' | 'dark'

/** 设置页可编辑的颜色 Token：友好中文名 + 高级 CSS 变量名 */
export const EDITABLE_TOKENS = [
  { key: '--bg', label: '页面背景色' },
  { key: '--surface', label: '卡片颜色' },
  { key: '--surface-2', label: '次级表面' },
  { key: '--surface-3', label: '浮层表面' },
  { key: '--text', label: '文字颜色' },
  { key: '--text-2', label: '次要文字' },
  { key: '--text-3', label: '弱化文字' },
  { key: '--accent', label: '主按钮 / 强调色' },
  { key: '--ok', label: '成功色' },
  { key: '--danger', label: '危险色' },
  { key: '--border', label: '边框' },
  { key: '--border-strong', label: '强边框' },
] as const

/** 模式展示文案 */
export const THEME_MODE_LABELS: Record<ThemeMode, string> = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
}

const DARK_MQ = '(prefers-color-scheme: dark)'

type TokenMap = Record<string, string>
type OverridesMap = Partial<Record<ResolvedThemeMode, TokenMap>>

function matchMediaDark(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia(DARK_MQ)
}

/** 读取系统是否偏好深色 */
export function prefersDark(): boolean {
  return matchMediaDark()?.matches ?? false
}

/** 将 mode（含 system）解析为实际 light/dark */
export function resolveThemeMode(mode: ThemeMode): ResolvedThemeMode {
  if (mode === 'system') return prefersDark() ? 'dark' : 'light'
  return mode
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

/** 将 #RGB/#RRGGBB 归一化为 6 位 hex，非法值回退默认深色 */
export function normalizeHex(c: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c
  if (/^#[0-9a-fA-F]{3}$/.test(c)) {
    const [r, g, b] = c.slice(1)
    return `#${r}${r}${g}${g}${b}${b}`
  }
  return '#5e6ad2'
}

function presetTokens(resolved: ResolvedThemeMode): TokenMap {
  const { label: _label, ...rest } = THEME_PRESETS[resolved]
  return { ...rest } as TokenMap
}

/** 将 resolved 模式 + 覆盖 + 可选主题包 tokens 写入 documentElement */
function applyToDom(
  resolved: ResolvedThemeMode,
  overrides: TokenMap,
  packTokens?: TokenMap,
): TokenMap {
  const root = document.documentElement
  // data-theme 始终是已解析的 light|dark（system 已在调用前 resolve）
  root.dataset.theme = resolved
  const tokens = { ...presetTokens(resolved), ...(packTokens ?? {}), ...overrides }
  for (const [key, value] of Object.entries(tokens)) {
    if (value) root.style.setProperty(key, value)
  }
  const ok = tokens['--ok'] || (resolved === 'light' ? '#0d9f6e' : '#3dd68c')
  root.style.setProperty('--ok-soft', hexToRgba(ok, resolved === 'light' ? 0.1 : 0.12))
  return tokens
}

/** 媒体 URL：http/blob/data/enest 直接用；绝对本地路径转 enest://media（Electron 协议） */
export function resolveMediaSrc(value: string): { src: string; playable: boolean; placeholder?: string } {
  if (!value) return { src: '', playable: false }
  if (/^(https?:|blob:|data:|enest:)/i.test(value)) {
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

interface ThemeState {
  mode: ThemeMode
  resolved: ResolvedThemeMode
  overrides: OverridesMap
  tokens: TokenMap
  packs: ThemePack[]
  packId: string | null
  background: BackgroundConfig | null
  hydrated: boolean
  hydrate: () => Promise<void>
  refreshPacks: () => Promise<void>
  setMode: (mode: ThemeMode) => Promise<void>
  setToken: (key: string, value: string) => void
  resetMode: () => Promise<void>
  applyPack: (packId: string | null) => Promise<void>
  setBackground: (bg: BackgroundConfig | null) => Promise<void>
}

async function persistTheme(state: {
  mode: ThemeMode
  overrides: OverridesMap
  packId: string | null
  background: BackgroundConfig | null
}): Promise<void> {
  const resolved = resolveThemeMode(state.mode)
  const modeOverrides = state.overrides[resolved] ?? {}
  // 始终带上 packId/background 键：null → undefined，供主进程显式清除
  await shellApi.setTheme(state.mode, modeOverrides, {
    packId: state.packId ?? undefined,
    background: state.background ?? undefined,
  })
}

let mqListenerAttached = false

function attachSystemListener(get: () => ThemeState, set: (p: Partial<ThemeState>) => void): void {
  const mq = matchMediaDark()
  if (!mq || mqListenerAttached) return
  mqListenerAttached = true
  const onChange = () => {
    const s = get()
    if (s.mode !== 'system' || !s.hydrated) return
    const resolved = resolveThemeMode('system')
    const pack = s.packId ? s.packs.find((p) => p.id === s.packId) : undefined
    const tokens = applyToDom(resolved, s.overrides[resolved] ?? {}, pack?.tokens)
    set({ resolved, tokens })
  }
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange)
  else if (typeof mq.addListener === 'function') mq.addListener(onChange)
}

/** 主题 store：mode + overrides + packs + background */
export const useThemeStore = create<ThemeState>((set, get) => ({
  mode: 'light',
  resolved: 'light',
  overrides: {},
  tokens: presetTokens('light'),
  packs: [],
  packId: null,
  background: null,
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return
    attachSystemListener(get, set)
    try {
      const t = (await shellApi.getTheme()) as ThemeTokens & { packs?: ThemePack[] }
      const mode: ThemeMode =
        t.mode === 'dark' || t.mode === 'system' || t.mode === 'light' ? t.mode : 'light'
      const resolved = resolveThemeMode(mode)
      const overrides = (t.overrides ?? {}) as OverridesMap
      const packs = t.packs ?? []
      const packId = t.packId ?? null
      const pack = packId ? packs.find((p) => p.id === packId) : undefined
      const background = t.background ?? pack?.background ?? null
      const tokens = applyToDom(resolved, overrides[resolved] ?? {}, pack?.tokens)
      set({
        mode,
        resolved,
        overrides,
        tokens,
        packs,
        packId,
        background,
        hydrated: true,
      })
    } catch {
      const resolved = resolveThemeMode('light')
      const tokens = applyToDom(resolved, {})
      set({ mode: 'light', resolved, tokens, packs: [], hydrated: true })
    }
  },

  /** 重新拉取主题包列表（插件 theme.register / 卸载后壳子事件触发） */
  refreshPacks: async () => {
    try {
      const t = (await shellApi.getTheme()) as ThemeTokens & { packs?: ThemePack[] }
      set({ packs: t.packs ?? [] })
    } catch {
      /* ignore */
    }
  },

  setMode: async (mode) => {
    const { overrides, packs, packId, background } = get()
    const resolved = resolveThemeMode(mode)
    const pack = packId ? packs.find((p) => p.id === packId) : undefined
    // 切换模式时若主题包绑定了 mode，保留 pack tokens；否则仍套用
    const tokens = applyToDom(resolved, overrides[resolved] ?? {}, pack?.tokens)
    set({ mode, resolved, tokens })
    await persistTheme({ mode, overrides, packId, background })
    toastStore.getState().push(
      mode === 'system'
        ? `已切换到跟随系统（当前${THEME_PRESETS[resolved].label}）`
        : `已切换到${THEME_PRESETS[mode].label}`,
    )
  },

  setToken: (key, value) => {
    const { mode, overrides, packs, packId, background } = get()
    const resolved = resolveThemeMode(mode)
    const modeOverrides = { ...(overrides[resolved] ?? {}), [key]: value }
    const next: OverridesMap = { ...overrides, [resolved]: modeOverrides }
    const pack = packId ? packs.find((p) => p.id === packId) : undefined
    const tokens = applyToDom(resolved, modeOverrides, pack?.tokens)
    set({ overrides: next, tokens })
    void persistTheme({ mode, overrides: next, packId, background })
  },

  resetMode: async () => {
    const { mode, overrides, packs, packId, background } = get()
    const resolved = resolveThemeMode(mode)
    const next: OverridesMap = { ...overrides, [resolved]: {} }
    const pack = packId ? packs.find((p) => p.id === packId) : undefined
    const tokens = applyToDom(resolved, {}, pack?.tokens)
    set({ overrides: next, tokens })
    await persistTheme({ mode, overrides: next, packId, background })
    toastStore.getState().push('已重置当前模式的颜色 Token')
  },

  applyPack: async (packId) => {
    const { mode, overrides, packs, background } = get()
    const resolved = resolveThemeMode(mode)
    const pack = packId ? packs.find((p) => p.id === packId) : undefined
    const nextBackground = pack?.background ?? background
    const tokens = applyToDom(resolved, overrides[resolved] ?? {}, pack?.tokens)
    set({ packId, tokens, background: nextBackground ?? null })
    await persistTheme({ mode, overrides, packId, background: nextBackground ?? null })
    toastStore.getState().push(pack ? `已应用主题包「${pack.name}」` : '已取消主题包')
  },

  setBackground: async (bg) => {
    const { mode, overrides, packId } = get()
    // 先同步 DOM 与 store，保证切换即时可见（不受 IPC 延迟影响）
    const active = !!bg && bg.type !== 'none' && !!bg.value
    document.documentElement.classList.toggle('has-bg-media', active)
    set({ background: bg })
    try {
      await persistTheme({ mode, overrides, packId, background: bg })
    } catch {
      /* 持久化失败不影响本地即时预览 */
    }
  },
}))

/** 便捷 hook：从 useThemeStore 取出主题读写 API 供组件使用 */
export function useTheme() {
  const mode = useThemeStore((s) => s.mode)
  const resolved = useThemeStore((s) => s.resolved)
  const tokens = useThemeStore((s) => s.tokens)
  const packs = useThemeStore((s) => s.packs)
  const packId = useThemeStore((s) => s.packId)
  const background = useThemeStore((s) => s.background)
  const setMode = useThemeStore((s) => s.setMode)
  const setToken = useThemeStore((s) => s.setToken)
  const resetMode = useThemeStore((s) => s.resetMode)
  const applyPack = useThemeStore((s) => s.applyPack)
  const setBackground = useThemeStore((s) => s.setBackground)
  const hydrate = useThemeStore((s) => s.hydrate)
  return {
    mode,
    resolved,
    tokens,
    packs,
    packId,
    background,
    setMode,
    setToken,
    resetMode,
    applyPack,
    setBackground,
    hydrate,
  }
}
