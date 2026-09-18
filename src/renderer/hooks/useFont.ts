/**
 * useFont — 界面字体（中英双槽位 + 预设栈 + 自定义上传）与字号档统一管理
 * hydrate 启动时从 settings.general 恢复：fontFamily（CJK/默认）、fontFamilyEn（英文优先）、
 * fontSizeScale（0.9–1.3）、customFonts，并注册 FontFace。
 * 应用规则：--font = EN 栈 + CJK 栈（Latin 优先英文）；无 fontFamilyEn 时行为与旧版一致。
 * --font-size-base = 14px * fontSizeScale，与 --shell-scale 独立。
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

/** 正文基准字号（px）；tokens.css / base.css 的 --font-size-base 缺省同值 */
export const BASE_FONT_PX = 14

/** 校验字号缩放：连续区间 0.9–1.3（滑杆实时），兼容历史四档 */
function isFontSizeScale(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0.9 && v <= 1.3
}

/** 将字号缩放写入 --font-size-base（与 --shell-scale 独立，作用于正文继承字号） */
function applyFontSizeScale(scale: number): void {
  const s = isFontSizeScale(scale) ? scale : 1
  document.documentElement.style.setProperty(
    '--font-size-base',
    `${(BASE_FONT_PX * s).toFixed(2)}px`
  )
}

export interface FontPreset {
  id: string
  /** i18n 键：settings.font.presets.{id}；无对应 key 时用 label 兜底 */
  nameKey: string
  /** 无 i18n 时的短标签（硬编码中文，任务允许） */
  label: string
  /** 写入字体槽的完整 font-family 值 */
  css: string
  /** 预览卡片使用的 family（不含兜底栈） */
  previewFamily: string
}

/** 组合预设（中英混排一体）；兼容旧 settings.fontFamily 全栈匹配 */
export const FONT_PRESETS: FontPreset[] = [
  {
    id: 'system',
    nameKey: 'settings.font.presets.system',
    label: '系统默认',
    css: '"Inter", "SF Pro Display", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
    previewFamily: 'system-ui, sans-serif',
  },
  {
    id: 'inter',
    nameKey: 'settings.font.presets.inter',
    label: 'Inter / SF',
    css: '"Inter", "SF Pro Text", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    previewFamily: '"Inter", "SF Pro Text", system-ui, sans-serif',
  },
  {
    id: 'source-han',
    nameKey: 'settings.font.presets.sourceHan',
    label: '思源黑体 SC',
    css: '"Source Han Sans SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
    previewFamily: '"Source Han Sans SC", "Noto Sans SC", "PingFang SC", sans-serif',
  },
  {
    id: 'lxgw',
    nameKey: 'settings.font.presets.lxgw',
    label: '霞鹜文楷',
    css: '"LXGW WenKai", "LXGW WenKai Screen", "Kaiti SC", "STKaiti", serif',
    previewFamily: '"LXGW WenKai", "Kaiti SC", serif',
  },
  {
    id: 'sarasa',
    nameKey: 'settings.font.presets.sarasa',
    label: '更纱黑体',
    css: '"Sarasa Gothic SC", "Sarasa UI SC", "Iosevka", "PingFang SC", sans-serif',
    previewFamily: '"Sarasa Gothic SC", "Sarasa UI SC", sans-serif',
  },
  {
    id: 'mono',
    nameKey: 'settings.font.presets.mono',
    label: 'JetBrains Mono 等宽',
    css: '"JetBrains Mono", "SF Mono", "Cascadia Code", ui-monospace, monospace',
    previewFamily: '"JetBrains Mono", "SF Mono", ui-monospace, monospace',
  },
]

/** 英文/Latin 槽位预设子集（写入 fontFamilyEn） */
export const FONT_PRESETS_EN: FontPreset[] = [
  {
    id: 'en-sans',
    nameKey: 'settings.font.presets.inter',
    label: 'Inter / SF',
    css: '"Inter", "SF Pro Text", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    previewFamily: '"Inter", "SF Pro Text", system-ui, sans-serif',
  },
  {
    id: 'en-georgia',
    nameKey: 'settings.font.presets.system',
    label: 'Georgia 衬线',
    css: 'Georgia, "Times New Roman", "Songti SC", serif',
    previewFamily: 'Georgia, "Times New Roman", serif',
  },
  {
    id: 'en-mono',
    nameKey: 'settings.font.presets.mono',
    label: 'JetBrains Mono',
    css: '"JetBrains Mono", "SF Mono", "Cascadia Code", ui-monospace, monospace',
    previewFamily: '"JetBrains Mono", "SF Mono", ui-monospace, monospace',
  },
]

/** 中文/CJK 槽位预设子集（写入 fontFamily） */
export const FONT_PRESETS_CJK: FontPreset[] = [
  {
    id: 'cjk-system',
    nameKey: 'settings.font.presets.system',
    label: '系统默认',
    css: '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif',
    previewFamily: '"PingFang SC", "Microsoft YaHei", sans-serif',
  },
  {
    id: 'cjk-source-han',
    nameKey: 'settings.font.presets.sourceHan',
    label: '思源黑体 SC',
    css: '"Source Han Sans SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
    previewFamily: '"Source Han Sans SC", "Noto Sans SC", "PingFang SC", sans-serif',
  },
  {
    id: 'cjk-lxgw',
    nameKey: 'settings.font.presets.lxgw',
    label: '霞鹜文楷',
    css: '"LXGW WenKai", "LXGW WenKai Screen", "Kaiti SC", "STKaiti", serif',
    previewFamily: '"LXGW WenKai", "Kaiti SC", serif',
  },
  {
    id: 'cjk-sarasa',
    nameKey: 'settings.font.presets.sarasa',
    label: '更纱黑体',
    css: '"Sarasa Gothic SC", "Sarasa UI SC", "PingFang SC", sans-serif',
    previewFamily: '"Sarasa Gothic SC", "Sarasa UI SC", sans-serif',
  },
]

/** 将 family 名包装为合法 CSS font-family 值（含兜底栈） */
export function cssFontValue(family: string): string {
  const quoted = family.includes('"') ? family : `"${family}"`
  return `${quoted}, ${FALLBACK_STACK}`
}

/**
 * 拼接中英字体栈：Latin 字符优先命中英文栈，CJK 回落中文栈。
 * en 为空时原样返回 cjk（兼容旧版单栈行为）。
 */
export function composeFontStack(en: string, cjk: string): string {
  if (!en) return cjk
  if (!cjk) return en
  return `${en}, ${cjk}`
}

/** 写入 --font CSS 变量；空串则移除内联值，回落 tokens.css 默认 */
function applyFontToDom(en: string, cjk: string): void {
  const root = document.documentElement
  const css = composeFontStack(en, cjk)
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
  /** CJK/默认槽：当前 --font 的中文/兜底栈；空表示 tokens.css 默认 */
  fontFamily: string
  /** 英文槽：Latin 优先栈；空表示不单独指定（与旧版一致） */
  fontFamilyEn: string
  /** 组合预设命中 id；自定义/双槽时可能为 null */
  presetId: string | null
  enPresetId: string | null
  cjkPresetId: string | null
  /** 当前命中的自定义字体 id（作为 CJK 槽） */
  customFontId: string | null
  customFonts: CustomFontMeta[]
  /** 字号档：0.9 / 1.0 / 1.15 / 1.3 */
  fontSizeScale: number
  hydrated: boolean
  hydrating: boolean
  uploading: boolean
  hydrate: () => Promise<void>
  /** 应用组合预设（清空英文槽，整栈写入 CJK 槽） */
  setPreset: (presetId: string) => Promise<void>
  /** 英文槽：id 为空串/传 null 表示「默认」（清除 fontFamilyEn） */
  setEnPreset: (presetId: string | null) => Promise<void>
  /** 中文槽：id 为空串/传 null 表示「默认」（清除 fontFamily） */
  setCjkPreset: (presetId: string | null) => Promise<void>
  setFontSizeScale: (scale: number) => Promise<void>
  applyCustom: (fontId: string) => Promise<void>
  uploadFont: (file: File) => Promise<void>
  removeCustomFont: (fontId: string) => Promise<void>
}

/** 从 settings 读取并应用字体与字号（hydrate / 外部刷新共用） */
async function loadAndApplyFromSettings(): Promise<{
  fontFamily: string
  fontFamilyEn: string
  presetId: string | null
  enPresetId: string | null
  cjkPresetId: string | null
  customFontId: string | null
  customFonts: CustomFontMeta[]
  fontSizeScale: number
}> {
  const settings = await shellApi.getSettings()
  const general = settings.general ?? {}
  const fontFamily = typeof general.fontFamily === 'string' ? general.fontFamily : ''
  const fontFamilyEn = typeof general.fontFamilyEn === 'string' ? general.fontFamilyEn : ''
  const rawScale = general.fontSizeScale
  const fontSizeScale = isFontSizeScale(rawScale) ? rawScale : 1
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
  let enPresetId: string | null = null
  let cjkPresetId: string | null = null
  let customFontId: string | null = null

  if (fontFamilyEn) {
    enPresetId = FONT_PRESETS_EN.find((p) => p.css === fontFamilyEn)?.id ?? null
  }
  if (fontFamily) {
    cjkPresetId = FONT_PRESETS_CJK.find((p) => p.css === fontFamily)?.id ?? null
    // 兼容旧组合预设整栈
    const matchedPreset = FONT_PRESETS.find((p) => p.css === fontFamily)
    if (matchedPreset) presetId = matchedPreset.id
    if (!cjkPresetId && !matchedPreset) {
      const matchedCustom = customFonts.find((c) => fontFamily.startsWith(`"${c.family}"`))
      if (matchedCustom) customFontId = matchedCustom.id
    }
  }

  applyFontToDom(fontFamilyEn, fontFamily)
  applyFontSizeScale(fontSizeScale)
  return {
    fontFamily,
    fontFamilyEn,
    presetId,
    enPresetId,
    cjkPresetId,
    customFontId,
    customFonts,
    fontSizeScale,
  }
}

async function persistGeneral(partial: {
  fontFamily?: string
  fontFamilyEn?: string
  fontSizeScale?: number
  customFonts?: CustomFontMeta[]
}): Promise<void> {
  await shellApi.setSettings({ general: { ...partial } })
}

export const useFontStore = create<FontState>((set, get) => ({
  fontFamily: '',
  fontFamilyEn: '',
  presetId: null,
  enPresetId: null,
  cjkPresetId: null,
  customFontId: null,
  customFonts: [],
  fontSizeScale: 1,
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
      applyFontToDom('', '')
      applyFontSizeScale(1)
      set({
        fontFamily: '',
        fontFamilyEn: '',
        presetId: null,
        enPresetId: null,
        cjkPresetId: null,
        customFontId: null,
        customFonts: [],
        fontSizeScale: 1,
        hydrated: true,
        hydrating: false,
      })
    }
  },

  setPreset: async (presetId) => {
    const preset = FONT_PRESETS.find((p) => p.id === presetId)
    if (!preset) return
    // 组合预设：清空英文槽，整栈写入 CJK/默认槽
    applyFontToDom('', preset.css)
    set({
      fontFamily: preset.css,
      fontFamilyEn: '',
      presetId: preset.id,
      enPresetId: null,
      cjkPresetId: null,
      customFontId: null,
    })
    try {
      await persistGeneral({ fontFamily: preset.css, fontFamilyEn: '' })
      toastStore.getState().push(t('settings.font.fontChanged'))
    } catch {
      toastStore.getState().push(t('settings.font.saveFailed'), 'error')
    }
  },

  setEnPreset: async (presetId) => {
    const id = presetId || null
    const preset = id ? FONT_PRESETS_EN.find((p) => p.id === id) : null
    if (id && !preset) return
    const en = preset?.css ?? ''
    const { fontFamily } = get()
    applyFontToDom(en, fontFamily)
    set({
      fontFamilyEn: en,
      enPresetId: preset?.id ?? null,
      presetId: null,
    })
    try {
      await persistGeneral({ fontFamilyEn: en })
      toastStore.getState().push(t('settings.font.fontChanged'))
    } catch {
      toastStore.getState().push(t('settings.font.saveFailed'), 'error')
    }
  },

  setCjkPreset: async (presetId) => {
    const id = presetId || null
    const preset = id ? FONT_PRESETS_CJK.find((p) => p.id === id) : null
    if (id && !preset) return
    const cjk = preset?.css ?? ''
    const { fontFamilyEn } = get()
    applyFontToDom(fontFamilyEn, cjk)
    set({
      fontFamily: cjk,
      cjkPresetId: preset?.id ?? null,
      presetId: null,
      customFontId: null,
    })
    try {
      await persistGeneral({ fontFamily: cjk })
      toastStore.getState().push(t('settings.font.fontChanged'))
    } catch {
      toastStore.getState().push(t('settings.font.saveFailed'), 'error')
    }
  },

  setFontSizeScale: async (scale) => {
    const next = isFontSizeScale(scale) ? scale : 1
    applyFontSizeScale(next)
    set({ fontSizeScale: next })
    try {
      await persistGeneral({ fontSizeScale: next })
    } catch {
      /* 乐观更新已生效；写入失败静默 */
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
    const { fontFamilyEn } = get()
    applyFontToDom(fontFamilyEn, css)
    set({
      fontFamily: css,
      presetId: null,
      cjkPresetId: null,
      customFontId: meta.id,
    })
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
      const { fontFamilyEn } = get()
      applyFontToDom(fontFamilyEn, css)
      set({
        customFonts,
        fontFamily: css,
        presetId: null,
        cjkPresetId: null,
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
    let customFontId = state.customFontId

    if (state.customFontId === fontId) {
      // 回退到默认栈（保留英文槽）
      fontFamily = ''
      customFontId = null
      applyFontToDom(state.fontFamilyEn, '')
    }

    set({
      customFonts,
      fontFamily,
      customFontId,
      cjkPresetId: customFontId ? state.cjkPresetId : null,
    })
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
  const fontFamilyEn = useFontStore((s) => s.fontFamilyEn)
  const presetId = useFontStore((s) => s.presetId)
  const enPresetId = useFontStore((s) => s.enPresetId)
  const cjkPresetId = useFontStore((s) => s.cjkPresetId)
  const customFontId = useFontStore((s) => s.customFontId)
  const customFonts = useFontStore((s) => s.customFonts)
  const fontSizeScale = useFontStore((s) => s.fontSizeScale)
  const hydrated = useFontStore((s) => s.hydrated)
  const uploading = useFontStore((s) => s.uploading)
  const hydrate = useFontStore((s) => s.hydrate)
  const setPreset = useFontStore((s) => s.setPreset)
  const setEnPreset = useFontStore((s) => s.setEnPreset)
  const setCjkPreset = useFontStore((s) => s.setCjkPreset)
  const setFontSizeScale = useFontStore((s) => s.setFontSizeScale)
  const applyCustom = useFontStore((s) => s.applyCustom)
  const uploadFont = useFontStore((s) => s.uploadFont)
  const removeCustomFont = useFontStore((s) => s.removeCustomFont)
  return {
    fontFamily,
    fontFamilyEn,
    presetId,
    enPresetId,
    cjkPresetId,
    customFontId,
    customFonts,
    fontSizeScale,
    hydrated,
    uploading,
    hydrate,
    setPreset,
    setEnPreset,
    setCjkPreset,
    setFontSizeScale,
    applyCustom,
    uploadFont,
    removeCustomFont,
  }
}
