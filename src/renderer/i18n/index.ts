/**
 * i18n — 轻量键值词典 + zustand locale 状态
 * 提供 t() 翻译、useI18nStore 订阅、hydrate/setLocale。
 * setLocale 同步 document.documentElement.lang 并持久化到 shellApi settings.general.locale。
 * 缺失键回退为键名本身；支持 {name} 占位符插值。
 * 依赖：zustand、shellApi、zh-CN/en-US 词典。
 */
import { create } from 'zustand'
import { shellApi } from '../services/shellApi'
import zhCN from './zh-CN'
import enUS from './en-US'

/** 支持的界面语言 */
export type Locale = 'zh-CN' | 'en-US'

/** 扁平化后的词典：点分路径 → 文案 */
export type FlatDict = Record<string, string>

/** 嵌套词典原始结构 */
type NestedDict = { [key: string]: string | NestedDict }

const LOCALES: readonly Locale[] = ['zh-CN', 'en-US']

/** 默认语言 */
export const DEFAULT_LOCALE: Locale = 'zh-CN'

/** 将嵌套词典扁平化为 a.b.c → 文案 */
function flattenDict(obj: NestedDict, prefix = ''): FlatDict {
  const out: FlatDict = {}
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') {
      out[path] = value
    } else if (value && typeof value === 'object') {
      Object.assign(out, flattenDict(value, path))
    }
  }
  return out
}

const dictionaries: Record<Locale, FlatDict> = {
  'zh-CN': flattenDict(zhCN as unknown as NestedDict),
  'en-US': flattenDict(enUS as unknown as NestedDict),
}

/** 判断是否为受支持的 locale 字符串 */
export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v)
}

/** 简单 {param} 插值 */
function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const v = params[name]
    return v === undefined ? match : String(v)
  })
}

/**
 * 非 hook 翻译：按当前 store locale 取文案。
 * 缺失键返回键名；支持 params 插值。
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const { locale } = useI18nStore.getState()
  const dict = dictionaries[locale] ?? dictionaries[DEFAULT_LOCALE]
  const raw = dict[key] ?? dictionaries[DEFAULT_LOCALE][key]
  if (raw === undefined) return key
  return interpolate(raw, params)
}

interface I18nState {
  locale: Locale
  hydrated: boolean
  /** 按当前 locale 翻译（组件内使用，locale 变更会触发重渲染） */
  t: (key: string, params?: Record<string, string | number>) => string
  /** 水合：从 shellApi 设置读取 locale，写入 DOM lang */
  hydrate: () => Promise<void>
  /** 切换语言：更新 store、DOM lang，并写入 settings.general.locale */
  setLocale: (locale: Locale) => Promise<void>
}

/** i18n 全局 store：locale + 翻译动作 */
export const useI18nStore = create<I18nState>((set, get) => ({
  locale: DEFAULT_LOCALE,
  hydrated: false,

  t: (key, params) => {
    const { locale } = get()
    const dict = dictionaries[locale] ?? dictionaries[DEFAULT_LOCALE]
    const raw = dict[key] ?? dictionaries[DEFAULT_LOCALE][key]
    if (raw === undefined) return key
    return interpolate(raw, params)
  },

  hydrate: async () => {
    if (get().hydrated) return
    let locale: Locale = DEFAULT_LOCALE
    try {
      const settings = await shellApi.getSettings()
      const general = settings.general as { locale?: unknown } | undefined
      const candidate = general?.locale
      if (isLocale(candidate)) {
        locale = candidate
      } else if (typeof candidate === 'string' && candidate.startsWith('en')) {
        locale = 'en-US'
      }
    } catch {
      /* 无主进程时保持默认 */
    }
    document.documentElement.lang = locale
    set({ locale, hydrated: true })
  },

  setLocale: async (locale) => {
    document.documentElement.lang = locale
    set({ locale })
    try {
      await shellApi.setSettings({ general: { locale } })
    } catch {
      /* mock 或 IPC 失败时仅本地生效 */
    }
  },
}))
