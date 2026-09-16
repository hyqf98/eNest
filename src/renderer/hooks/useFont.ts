/**
 * useFont — 界面字体（预设栈 + 自定义上传）统一管理
 * hydrate 启动时从 settings.general.fontFamily / customFonts 恢复，并注册 FontFace。
 * setPreset / setCustom 实时写 documentElement.style.setProperty('--font', ...) 并持久化。
 * 自定义字体：浏览器 mock 用 FileReader + localStorage dataURL（≤5MB）；Electron 写 ~/eNest/fonts/。
 * 依赖：shellApi、toastStore、@shared/types/plugin。
 */
import { create } from 'zustand'
import type { CustomFontMeta } from '@shared/types/plugin'
import { shellApi, isMockShell } from '@renderer/services/shellApi'
import { toastStore } from '@renderer/hooks/useToast'
import { t } from '@renderer/i18n'

/** 自定义字体上传大小上限（mock 下 dataURL 进 localStorage） */
export const MAX_FONT_BYTES = 5 * 1024 * 1024

/** 允许的字体扩展名 */
export const FONT_EXTENSIONS = ['.ttf', '.otf', '.woff', '.woff2'] as const

/** 自定义字体 family 后的兜底栈 */
const FALLBACK_STACK =
  '"Inter", "SF Pro Text", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'

/** mock 下自定义字体二进制 localStorage 键前缀 */
const MOCK_FONT_KEY = 'enest.customFont.'

export interface FontPreset {
  id: string
  /** i18n 键：settings.font.presets.{id} */
  nameKey: string
  /** 写入 --font 的完整 font-family 值 */
  css: string
  /** 预览卡片使用的 family（不含兜底栈，便于缺字体时回落） */
  previewFamily: string
}

/** 预设字体组合（中英混排友好） */
export const FONT_PRESETS: FontPreset[] = [
  {
    id: 'system',
    nameKey: 'settings.font.presets.system',
    css: '"Inter", "SF Pro Display", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
    previewFamily: 'system-ui, sans-serif',
  },
  {
    id: 'inter',
    nameKey: 'settings.font.presets.inter',
    css: '"Inter", "SF Pro Text", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    previewFamily: '"Inter", "SF Pro Text", system-ui, sans-serif',
  },
  {
    id: 'source-han',
    nameKey: 'settings.font.presets.sourceHan',
    css: '"Source Han Sans SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
    previewFamily: '"Source Han Sans SC", "Noto Sans SC", "PingFang SC", sans-serif',
  },
  {
    id: 'lxgw',
    nameKey: 'settings.font.presets.lxgw',
    css: '"LXGW WenKai", "LXGW WenKai Screen", "Kaiti SC", "STKaiti", serif',
    previewFamily: '"LXGW WenKai", "Kaiti SC", serif',
  },
  {
    id: 'sarasa',
    nameKey: 'settings.font.presets.sarasa',
    css: '"Sarasa Gothic SC", "Sarasa UI SC", "Iosevka", "PingFang SC", sans-serif',
    previewFamily: '"Sarasa Gothic SC", "Sarasa UI SC", sans-serif',
  },
  {
    id: 'mono',
    nameKey: 'settings.font.presets.mono',
    css: '"JetBrains Mono", "SF Mono", "Cascadia Code", ui-monospace, monospace',
    previewFamily: '"JetBrains Mono", "SF Mono", ui-monospace, monospace',
  },
]

/** 将 family 名包装为合法 CSS font-family 值（含兜底栈） */
export function cssFontValue(family: string): string {
  const quoted = family.includes('"') ? family : `"${family}"`
  return `${quoted}, ${FALLBACK_STACK}`
}

/** 写入 --font CSS 变量；空串则移除内联值，回落 tokens.css 默认 */
function applyFontToDom(css: string): void {
  const root = document.documentElement
  if (!css) root.style.removeProperty('--font')
  else root.style.setProperty('--font', css)
}

/** 从文件名推导显示名与 family */
function deriveNames(fileName: string): { name: string; family: string } {
  const base = fileName.replace(/\.(ttf|otf|woff2?)$/i, '')
  const name = base || 'Custom Font'
  // family 不能含引号/反斜杠
  const family = name.replace(/["'\\]/g, '').trim() || 'Custom Font'
  return { name, family }
}

function makeId(): string {
  return `font-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 校验扩展名 */
export function isSupportedFontFile(fileName: string): boolean {
  return FONT_EXTENSIONS.some((ext) => fileName.toLowerCase().endsWith(ext))
}

/** File → base64（去掉 data: 前缀） */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const idx = result.indexOf(',')
      resolve(idx >= 0 ? result.slice(idx + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

/** base64 → ArrayBuffer（供 FontFace） */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

/** 注册 FontFace 并 document.fonts.add；失败抛错 */
async function registerFontFace(family: string, source: ArrayBuffer | string): Promise<void> {
  const face = new FontFace(family, source)
  await face.load()
  document.fonts.add(face)
}

interface FontState {
  /** 当前 --font 的完整 CSS 值；空表示默认栈 */
  fontFamily: string
  /** 当前命中的预设 id；自定义字体时为 null */
  presetId: string | null
  /** 当前命中的自定义字体 id */
  customFontId: string | null
  customFonts: CustomFontMeta[]
  hydrated: boolean
  hydrating: boolean
  uploading: boolean
  hydrate: () => Promise<void>
  setPreset: (presetId: string) => Promise<void>
  applyCustom: (fontId: string) => Promise<void>
  uploadFont: (file: File) => Promise<void>
  removeCustomFont: (fontId: string) => Promise<void>
}

/** 从 settings 读取并应用字体（hydrate / 外部刷新共用） */
async function loadAndApplyFromSettings(): Promise<{
  fontFamily: string
  presetId: string | null
  customFontId: string | null
  customFonts: CustomFontMeta[]
}> {
  const settings = await shellApi.getSettings()
  const general = settings.general ?? {}
  const fontFamily = typeof general.fontFamily === 'string' ? general.fontFamily : ''
  const customFonts = Array.isArray(general.customFonts)
    ? (general.customFonts as CustomFontMeta[])
    : []

  // 预注册全部自定义字体（失败忽略，不阻塞启动）
  await Promise.all(
    customFonts.map(async (meta) => {
      try {
        if (isMockShell) {
          const dataUrl = localStorage.getItem(MOCK_FONT_KEY + meta.id)
          if (dataUrl) await registerFontFace(meta.family, `url(${dataUrl})`)
        } else if (shellApi.readCustomFont) {
          const result = await shellApi.readCustomFont(meta.fileName)
          if (result.ok && result.dataBase64) {
            await registerFontFace(meta.family, base64ToArrayBuffer(result.dataBase64))
          }
        }
      } catch {
        /* 单个字体失败不影响其它 */
      }
    })
  )

  let presetId: string | null = null
  let customFontId: string | null = null
  if (fontFamily) {
    const matchedPreset = FONT_PRESETS.find((p) => p.css === fontFamily)
    if (matchedPreset) {
      presetId = matchedPreset.id
    } else {
      const matchedCustom = customFonts.find((c) => fontFamily.startsWith(`"${c.family}"`))
      if (matchedCustom) customFontId = matchedCustom.id
    }
  }

  applyFontToDom(fontFamily)
  return { fontFamily, presetId, customFontId, customFonts }
}

async function persistGeneral(partial: {
  fontFamily?: string
  customFonts?: CustomFontMeta[]
}): Promise<void> {
  await shellApi.setSettings({ general: { ...partial } })
}

export const useFontStore = create<FontState>((set, get) => ({
  fontFamily: '',
  presetId: null,
  customFontId: null,
  customFonts: [],
  hydrated: false,
  hydrating: false,
  uploading: false,

  hydrate: async () => {
    if (get().hydrated || get().hydrating) return
    set({ hydrating: true })
    try {
      const next = await loadAndApplyFromSettings()
      set({ ...next, hydrated: true, hydrating: false })
    } catch {
      applyFontToDom('')
      set({
        fontFamily: '',
        presetId: null,
        customFontId: null,
        customFonts: [],
        hydrated: true,
        hydrating: false,
      })
    }
  },

  setPreset: async (presetId) => {
    const preset = FONT_PRESETS.find((p) => p.id === presetId)
    if (!preset) return
    applyFontToDom(preset.css)
    set({ fontFamily: preset.css, presetId: preset.id, customFontId: null })
    try {
      await persistGeneral({ fontFamily: preset.css })
      toastStore.getState().push(t('settings.font.fontChanged'))
    } catch {
      toastStore.getState().push(t('settings.font.saveFailed'), 'error')
    }
  },

  applyCustom: async (fontId) => {
    const meta = get().customFonts.find((c) => c.id === fontId)
    if (!meta) return
    // 确保 FontFace 已注册（hydrate 失败或冷启动重试）
    try {
      if (isMockShell) {
        const dataUrl = localStorage.getItem(MOCK_FONT_KEY + meta.id)
        if (dataUrl) await registerFontFace(meta.family, `url(${dataUrl})`)
      } else if (shellApi.readCustomFont) {
        const result = await shellApi.readCustomFont(meta.fileName)
        if (result.ok && result.dataBase64) {
          await registerFontFace(meta.family, base64ToArrayBuffer(result.dataBase64))
        }
      }
    } catch {
      /* 继续尝试应用，浏览器可能已缓存 */
    }
    const css = cssFontValue(meta.family)
    applyFontToDom(css)
    set({ fontFamily: css, presetId: null, customFontId: meta.id })
    try {
      await persistGeneral({ fontFamily: css })
      toastStore.getState().push(t('settings.font.fontChanged'))
    } catch {
      toastStore.getState().push(t('settings.font.saveFailed'), 'error')
    }
  },

  uploadFont: async (file) => {
    if (!file) return
    if (!isSupportedFontFile(file.name)) {
      toastStore.getState().push(t('settings.font.unsupported'), 'error')
      return
    }
    if (file.size > MAX_FONT_BYTES) {
      toastStore.getState().push(t('settings.font.tooLarge'), 'error')
      return
    }
    set({ uploading: true })
    try {
      const { name, family } = deriveNames(file.name)
      const id = makeId()
      // 避免同名覆盖：fileName 带 id 前缀
      const safeBase = file.name.replace(/[^\w.\-]+/g, '_')
      const fileName = `${id}-${safeBase}`

      let dataUrlForMock: string | null = null

      if (isMockShell) {
        const base64 = await fileToBase64(file)
        dataUrlForMock = `data:${file.type || 'font/woff2'};base64,${base64}`
        try {
          localStorage.setItem(MOCK_FONT_KEY + id, dataUrlForMock)
        } catch {
          toastStore.getState().push(t('settings.font.tooLarge'), 'error')
          set({ uploading: false })
          return
        }
        await registerFontFace(family, `url(${dataUrlForMock})`)
      } else {
        // Electron：优先用绝对路径复制；否则传 base64
        const sourcePath = shellApi.getPathForFile?.(file) || ''
        if (shellApi.saveCustomFont) {
          let payload: { sourcePath?: string; dataBase64?: string; fileName: string }
          if (sourcePath) {
            payload = { sourcePath, fileName }
          } else {
            payload = { dataBase64: await fileToBase64(file), fileName }
          }
          const result = await shellApi.saveCustomFont(payload)
          if (!result.ok) throw new Error(result.error || 'save failed')
        }
        const base64 = await fileToBase64(file)
        await registerFontFace(family, base64ToArrayBuffer(base64))
      }

      const meta: CustomFontMeta = { id, name, family, fileName }
      const customFonts = [...get().customFonts, meta]
      const css = cssFontValue(family)
      applyFontToDom(css)
      set({
        customFonts,
        fontFamily: css,
        presetId: null,
        customFontId: id,
        uploading: false,
      })
      await persistGeneral({ fontFamily: css, customFonts })
      toastStore.getState().push(t('settings.font.uploaded', { name }), 'success')
    } catch {
      set({ uploading: false })
      toastStore.getState().push(t('settings.font.uploadFailed'), 'error')
    }
  },

  removeCustomFont: async (fontId) => {
    const state = get()
    const meta = state.customFonts.find((c) => c.id === fontId)
    if (!meta) return
    const customFonts = state.customFonts.filter((c) => c.id !== fontId)

    try {
      if (isMockShell) {
        localStorage.removeItem(MOCK_FONT_KEY + meta.id)
      } else if (shellApi.deleteCustomFont) {
        await shellApi.deleteCustomFont(meta.fileName)
      }
    } catch {
      /* 文件删除失败仍从列表移除 */
    }

    let fontFamily = state.fontFamily
    let presetId = state.presetId
    let customFontId = state.customFontId

    if (state.customFontId === fontId) {
      // 回退到默认栈
      fontFamily = ''
      presetId = null
      customFontId = null
      applyFontToDom('')
    }

    set({ customFonts, fontFamily, presetId, customFontId })
    try {
      await persistGeneral({ fontFamily, customFonts })
      toastStore.getState().push(t('settings.font.removed', { name: meta.name }))
    } catch {
      toastStore.getState().push(t('settings.font.saveFailed'), 'error')
    }
  },
}))

/** 便捷 hook：订阅字体状态与动作 */
export function useFont() {
  const fontFamily = useFontStore((s) => s.fontFamily)
  const presetId = useFontStore((s) => s.presetId)
  const customFontId = useFontStore((s) => s.customFontId)
  const customFonts = useFontStore((s) => s.customFonts)
  const hydrated = useFontStore((s) => s.hydrated)
  const uploading = useFontStore((s) => s.uploading)
  const hydrate = useFontStore((s) => s.hydrate)
  const setPreset = useFontStore((s) => s.setPreset)
  const applyCustom = useFontStore((s) => s.applyCustom)
  const uploadFont = useFontStore((s) => s.uploadFont)
  const removeCustomFont = useFontStore((s) => s.removeCustomFont)
  return {
    fontFamily,
    presetId,
    customFontId,
    customFonts,
    hydrated,
    uploading,
    hydrate,
    setPreset,
    applyCustom,
    uploadFont,
    removeCustomFont,
  }
}
