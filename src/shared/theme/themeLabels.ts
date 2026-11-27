/**
 * 主题声明文案的语言选择。
 *
 * 主题包（含源码内置默认主题）在自己的 schema 里声明分组标题、字段标签、选项和说明，
 * 这些字符串由宿主原样渲染。主题可以额外声明 `*En` 英文字段；这里按当前界面语言取值，
 * 缺英文时回退中文字段，而不是显示键名或空白。
 *
 * 只做取值，不做翻译：宿主不维护主题文案的对照表，第三方主题也能获得同样行为。
 * 依赖：@shared/types/appearance。
 */
import type { ThemeSettingOption, ThemeSettingsField, ThemeSettingsGroup, ThemePackV2 } from '@shared/types/appearance'

/** 支持的语言；与 i18n 的 Locale 保持一致，但这里不依赖渲染层。 */
export type ThemeLabelLocale = 'zh-CN' | 'en-US'

function pick(zh: string | undefined, en: string | undefined, locale: ThemeLabelLocale): string {
  if (locale === 'en-US' && en) return en
  return zh ?? en ?? ''
}

export function themePackName(pack: Pick<ThemePackV2, 'name' | 'nameEn'>, locale: ThemeLabelLocale): string {
  return pick(pack.name, pack.nameEn, locale)
}

export function themePackDescription(pack: Pick<ThemePackV2, 'description' | 'descriptionEn'>, locale: ThemeLabelLocale): string | undefined {
  return locale === 'en-US' ? pack.descriptionEn ?? pack.description : pack.description
}

export function themeGroupTitle(group: Pick<ThemeSettingsGroup, 'title' | 'titleEn'>, locale: ThemeLabelLocale): string {
  return pick(group.title, group.titleEn, locale)
}

export function themeGroupDescription(group: Pick<ThemeSettingsGroup, 'description' | 'descriptionEn'>, locale: ThemeLabelLocale): string | undefined {
  return locale === 'en-US' ? group.descriptionEn ?? group.description : group.description
}

export function themeFieldLabel(field: Pick<ThemeSettingsField, 'label' | 'labelEn'>, locale: ThemeLabelLocale): string {
  return pick(field.label, field.labelEn, locale)
}

export function themeFieldHelp(field: Pick<ThemeSettingsField, 'help' | 'helpEn'>, locale: ThemeLabelLocale): string | undefined {
  return locale === 'en-US' ? field.helpEn ?? field.help : field.help
}

export function themeOptionLabel(option: Pick<ThemeSettingOption, 'label' | 'labelEn'>, locale: ThemeLabelLocale): string {
  return pick(option.label, option.labelEn, locale)
}

export function themeOptionDescription(option: Pick<ThemeSettingOption, 'description' | 'descriptionEn'>, locale: ThemeLabelLocale): string | undefined {
  return locale === 'en-US' ? option.descriptionEn ?? option.description : option.description
}
