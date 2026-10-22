import type { ThemeSettingPresentation as FieldPresentation, ThemeSettingsField } from '@shared/types/appearance'

/**
 * 宿主渲染层使用的控件形态。优先级：字段自带 `presentation` > 选项自带缩略图 > 宿主按
 * type/binding 推断。这样第三方主题能表达意图，旧主题（含内置默认主题）行为保持不变。
 * - segmented：短选项横向分段
 * - cards：带缩略图的选项卡片
 * - font-choices：字体栈选择
 * - slider-cluster：相邻数值微调项收进同一组紧凑调节块
 */
export type ThemeSettingPresentation = FieldPresentation | 'font-choices'

export function themeSettingsPresentation(field: ThemeSettingsField): ThemeSettingPresentation | undefined {
  // 显式声明优先；与字段是否兼容已在 pack 校验阶段确认。
  if (field.presentation) return field.presentation
  if (field.type === 'font') return 'font-choices'
  if (field.type === 'slider' && (field.binding.target === 'component' || field.binding.target === 'notification' || field.binding.target === 'layout')) return 'slider-cluster'
  if (field.type !== 'select') return undefined
  // 选项自带缩略图时按卡片呈现，主题只需提供素材，不必重复声明。
  if ((field.options ?? []).some(option => option.preview)) return 'cards'
  // 兼容推断：内置背景效果与氛围配色沿用宿主自带缩略图库。
  if (field.binding.target === 'background' && field.binding.key === 'effect') return 'cards'
  if (field.binding.target === 'background' && field.binding.key === 'palette') return 'cards'
  if ((field.options?.length ?? 0) <= 5) return 'segmented'
  return undefined
}
