import type { ReactNode } from 'react'
import type { BackgroundConfig, CustomFontMeta } from '@shared/types/plugin'
import type { ResolvedAppearance, ThemeBackgroundPaletteDeclaration, ThemeSettingValue, ThemeSettingsField, ThemeSettingsSchema } from '@shared/types/appearance'
import { themeSettingsPresentation } from '@shared/theme/settingsPresentation'
import { Button } from '@renderer/components/ui/Button'
import { Select } from '@renderer/components/ui/Select'
import { Slider } from '@renderer/components/ui/Slider'
import { Switch } from '@renderer/components/ui/Switch'
import { ColorPickerField } from '@renderer/components/ColorPickerField'
import { ThemeSettingChoices } from './ThemeSettingChoices'

export function themeFieldValue(field: ThemeSettingsField, appearance: ResolvedAppearance, values: Record<string, ThemeSettingValue>): ThemeSettingValue {
  if (Object.hasOwn(values, field.key)) return values[field.key]
  const binding = field.binding
  if (binding.target === 'token') return appearance.tokens[binding.key] ?? field.default
  if (binding.target === 'font') return appearance.fonts[binding.key] ?? field.default
  if (binding.target === 'splash') return appearance.splash?.[binding.key] ?? field.default
  if (binding.target === 'layout') return appearance.layout[binding.key] ?? field.default
  if (binding.target === 'component') return appearance.components[binding.key]
  if (binding.target === 'notification') return appearance.notifications[binding.key]
  if (binding.target === 'animation') return appearance.animation.requested
  if (binding.key === 'effect' && field.type === 'switch') return appearance.background.effect !== 'none'
  if (binding.key === 'media' && appearance.background.media?.type === 'color') return field.default
  return appearance.background[binding.key] ?? field.default
}

export function visibleThemeFields(fields: ThemeSettingsField[], allFields: ThemeSettingsField[], appearance: ResolvedAppearance, values: Record<string, ThemeSettingValue>): ThemeSettingsField[] {
  return fields.filter(field => {
    if (!field.visibleWhen) return true
    const dependency = allFields.find(item => item.key === field.visibleWhen!.field)
    return Boolean(dependency && themeFieldValue(dependency, appearance, values) === field.visibleWhen.equals)
  })
}

interface ThemeSettingsFieldsProps {
  schema: ThemeSettingsSchema
  appearance: ResolvedAppearance
  values: Record<string, ThemeSettingValue>
  customFonts: CustomFontMeta[]
  importingFont: string | null
  /** Active pack declarations so custom atmosphere presets render their swatch instead of a placeholder. */
  palettes?: ThemeBackgroundPaletteDeclaration[]
  disabled?: boolean
  /** 嵌入宿主卡片时不再各自成卡，分组仅保留小节标题 */
  embedded?: boolean
  onChange: (field: ThemeSettingsField, value: ThemeSettingValue) => void
  onCommit: () => void
  onPickMedia: (field: ThemeSettingsField) => void
  onImportFont: (field: ThemeSettingsField) => void
  onRemoveFont?: (font: CustomFontMeta) => void
  onPreviewSplash?: () => void
  onResetColors?: () => void
}

const formatValue = (value: number) => Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 })

/** 滑杆读数：字号比例显示成百分比并标出实际基准；其余沿用数值。 */
function sliderText(field: ThemeSettingsField, value: number): string {
  if (field.binding.target === 'font' && field.binding.key === 'scale') {
    return `${Math.round(value * 100)}% (${Number((14 * value).toFixed(1))}px)`
  }
  return formatValue(value)
}

/** 字体示例按槽位取文：英文槽看拉丁字形，中文槽看汉字，等宽槽看代码与数字。 */
function fontSpecimen(field: ThemeSettingsField): string {
  const key = field.binding.target === 'font' ? field.binding.key : ''
  if (key === 'cjk') return '山海可期 · 永字八法 · 中文字形'
  if (key === 'mono') return 'const nest = "eNest" // 0123456789'
  return 'The quick brown fox · AaBbCc 0123'
}

export function ThemeSettingsFields({ schema, appearance, values, customFonts, importingFont, palettes, disabled, embedded, onChange, onCommit, onPickMedia, onImportFont, onRemoveFont, onPreviewSplash, onResetColors }: ThemeSettingsFieldsProps) {
  const fields = schema.groups.flatMap(group => group.fields)
  const commit = (field: ThemeSettingsField, value: ThemeSettingValue) => { onChange(field, value); onCommit() }

  const renderSlider = (field: ThemeSettingsField) => {
    const value = themeFieldValue(field, appearance, values)
    return (
      <div key={field.key} className="appearance-slider-row" data-theme-field={field.key}>
        <span className="appearance-slider-label">{field.label}</span>
        <Slider disabled={disabled} aria-label={field.label} min={field.min} max={field.max} step={field.step} value={[Number(value)]} onValueChange={next => onChange(field, next[0] ?? Number(field.default))} onValueCommit={onCommit} />
        <output>{formatValue(Number(value))}</output>
      </div>
    )
  }

  const renderField = (field: ThemeSettingsField): ReactNode => {
    const value = themeFieldValue(field, appearance, values)
    const media = field.type === 'media' && value && typeof value === 'object' ? value as BackgroundConfig : null
    // 「主题默认」必须落回字段默认值本身：等宽字段的默认值非空，写空串会丢掉主题字体栈。
    const fontOptions = field.type === 'font' ? [...new Map([
      { label: String(value) || '主题默认', value: String(value) },
      { label: '主题默认', value: String(field.default) },
      ...(field.options ?? []).map(option => ({ label: option.label, value: String(option.value) })),
      ...customFonts.map(font => ({ label: font.name, value: `"${font.family}", sans-serif` })),
    ].map(option => [option.value, option])).values()] : []
    const selectedFont = field.type === 'font' ? customFonts.find(font => typeof value === 'string' && value.split(',').some(part => part.trim().replace(/^(["'])(.*)\1$/, '$2') === font.family)) : undefined
    const presentation = themeSettingsPresentation(field)
    const cards = presentation === 'cards'
    // 选项自带的说明：选中哪一项就解释哪一项，避免「品牌色 / 主题色」点了没反应。
    const selectedOption = field.type === 'select' ? field.options?.find(option => option.value === value) : undefined
    return <div key={field.key} className={`field appearance-field appearance-field-${field.type} appearance-field-target-${field.binding.target}${cards ? ' appearance-field-cards' : ''}`} data-theme-field={field.key}>
      <div>
        <div className="label">{field.label}</div>
        {selectedOption?.description && <p className="desc">{selectedOption.description}</p>}
        {field.type === 'font' && <p className="appearance-font-preview" style={{ fontFamily: String(value || 'var(--font)') }}>{fontSpecimen(field)}</p>}
        {field.type === 'media' && <p className="desc">{media ? media.type === 'video' ? '已选择视频背景' : '已选择图片背景' : '尚未选择媒体'}</p>}
        {field.help && <p className="desc">{field.help}</p>}
        {field.binding.target === 'splash' && field.binding.key === 'type' && appearance.background.effect !== 'none' && <p className="desc">当前背景动效会统一铺到启动画面；关闭「背景动效」后这里的选择才生效。</p>}
        {field.binding.target === 'splash' && field.binding.key === 'type' && appearance.background.effect === 'none' && appearance.background.media?.type === 'color' && <p className="desc">主题色沿用当前氛围背景；自定义启动图片优先显示。</p>}
        {field.type === 'media' && field.binding.target === 'background' && appearance.background.effect !== 'none' && <p className="desc">图片和视频在关闭背景动效后显示。</p>}
      </div>
      {(field.type === 'color' || field.type === 'token') && <div className="appearance-color-control"><ColorPickerField disabled={disabled} preserveAlpha label={field.label} value={String(value)} onChange={next => onChange(field, next)} onCommit={onCommit} /><code>{String(value)}</code></div>}
      {field.type === 'slider' && <div className="appearance-slider-row"><Slider disabled={disabled} aria-label={field.label} min={field.min} max={field.max} step={field.step} value={[Number(value)]} onValueChange={next => onChange(field, next[0] ?? Number(field.default))} onValueCommit={onCommit} /><output>{sliderText(field, Number(value))}</output></div>}
      {field.type === 'switch' && <Switch disabled={disabled} aria-label={field.label} checked={value === true} onCheckedChange={next => commit(field, next)} />}
      {field.type === 'select' && (presentation ? <ThemeSettingChoices label={field.label} disabled={disabled} presentation={presentation} options={field.options ?? []} palettes={palettes} value={value as string | number | boolean | null} onChange={next => commit(field, next)} /> : <Select disabled={disabled} ariaLabel={field.label} value={String(value)} onChange={selected => commit(field, field.options?.find(item => String(item.value) === selected)?.value ?? field.default)} options={(field.options ?? []).map(option => ({ label: option.label, value: String(option.value) }))} />)}
      {field.type === 'font' && <div className="appearance-font-controls">
        <Select disabled={disabled} ariaLabel={field.label} value={String(value) || '__theme-default'} onChange={selected => commit(field, selected === '__theme-default' ? String(field.default) : selected)} options={fontOptions.map(option => ({ ...option, value: option.value || '__theme-default' }))} />
        <Button variant="ghost" size="sm" disabled={disabled || importingFont !== null} aria-label={`为${field.label}导入字体`} onClick={() => onImportFont(field)}>{importingFont === field.key ? '导入中…' : '导入字体'}</Button>
        {selectedFont && onRemoveFont && <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onRemoveFont(selectedFont)}>删除字体</Button>}
      </div>}
      {field.type === 'media' && <div className="appearance-media-controls"><Button variant="ghost" size="sm" disabled={disabled} onClick={() => onPickMedia(field)}>{field.binding.target === 'splash' ? '选择图片' : '选择图片／视频'}</Button>{media && <Button variant="ghost" size="sm" disabled={disabled} onClick={() => commit(field, null)}>移除</Button>}</div>}
    </div>
  }

  return <>{schema.groups.map(group => {
    const visibleFields = visibleThemeFields(group.fields, fields, appearance, values)
    if (!visibleFields.length) return null
    // 纯 token/color 组渲染为横排色板网格，替代逐行 field 列表
    const swatchGroup = visibleFields.every(field => field.type === 'token' || field.type === 'color')
    // 组级工具按钮：收进组头右侧，不再堆在组底贴分割线
    const resetColorsAction = onResetColors && group.fields.some(field => field.binding.target === 'token')
    const previewSplashAction = onPreviewSplash && group.fields.some(field => field.binding.target === 'splash')
    return <section key={group.id} className={embedded ? 'appearance-settings-group-embedded' : 's-card appearance-settings-group'} aria-label={group.title} data-theme-group={group.id}>
      <div className="appearance-group-head">
        <div className="appearance-group-head-row">
          <h3 className="appearance-group-title">{group.title}</h3>
          {(resetColorsAction || previewSplashAction) && (
            <div className="appearance-group-tools">
              {resetColorsAction && <Button variant="ghost" size="sm" disabled={disabled} onClick={onResetColors}>恢复配色</Button>}
              {previewSplashAction && <Button variant="ghost" size="sm" disabled={disabled} onClick={onPreviewSplash}>重播启动画面</Button>}
            </div>
          )}
        </div>
        {group.description && <p className="hint">{group.description}</p>}
      </div>
      {swatchGroup
        ? <div className="appearance-swatch-grid">
          {visibleFields.map(field => <ColorPickerField key={field.key} compact disabled={disabled} preserveAlpha label={field.label} value={String(themeFieldValue(field, appearance, values))} onChange={next => onChange(field, next)} onCommit={onCommit} />)}
        </div>
        : <div className="appearance-group-fields">{groupFields(visibleFields)}</div>}
    </section>
  })}</>

  /** 连续数值微调合并进同一个调节块：一屏能用更少的纵向空间把圆角、间距等一起调完。 */
  function groupFields(visibleFields: ThemeSettingsField[]) {
    const nodes: ReactNode[] = []
    for (let index = 0; index < visibleFields.length;) {
      const field = visibleFields[index]
      if (themeSettingsPresentation(field) !== 'slider-cluster') {
        nodes.push(renderField(field))
        index++
        continue
      }
      const run: ThemeSettingsField[] = []
      while (index < visibleFields.length && themeSettingsPresentation(visibleFields[index]) === 'slider-cluster') run.push(visibleFields[index++])
      nodes.push(<div key={`cluster-${run[0].key}`} className="appearance-slider-cluster">{run.map(renderSlider)}</div>)
    }
    return nodes
  }
}
