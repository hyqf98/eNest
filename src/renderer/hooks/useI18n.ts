/**
 * useI18n — 便捷 hook：从 i18n store 取出 locale / t / setLocale
 * 组件内优先使用本 hook；模块级文案可用 i18n/index 的 t()。
 * 依赖：i18n store（useI18nStore）。
 */
import { useI18nStore, type Locale } from '@renderer/i18n'

export type { Locale }

/** 读取当前语言、翻译函数与切换动作 */
export function useI18n() {
  const locale = useI18nStore((s) => s.locale)
  const t = useI18nStore((s) => s.t)
  const setLocale = useI18nStore((s) => s.setLocale)
  const hydrate = useI18nStore((s) => s.hydrate)
  return { locale, t, setLocale, hydrate }
}
