import { lazy, useEffect, useRef, useState } from 'react'
import { useI18n } from '@renderer/hooks/useI18n'
import { Select } from '@renderer/components/ui/Select'
import { Switch } from '@renderer/components/ui/Switch'
import { Slider } from '@renderer/components/ui/Slider'
import { Button } from '@renderer/components/ui/Button'
import { Input } from '@renderer/components/ui/Input'
import { shellApi } from '@renderer/services/shellApi'
import { notify } from '@renderer/services/notifyService'
import type { SettingsSectionContributionItem as PluginSettingsItem } from '@shared/types/plugin'
import type { ShellSettingsSection } from '@shared/types/shell'
import { PLUGIN_CATEGORY_COLOR_DEFAULT } from '@shared/constants'
import { Card, Field } from './SettingsFields'
import type { usePluginSettings } from './usePluginSettings'

const ColorPickerField = lazy(() => import('@renderer/components/ColorPickerField').then(module => ({ default: module.ColorPickerField })))

function PluginSettingInput({ item, raw, onCommit }: {
  item: PluginSettingsItem; raw: unknown; onCommit: (value: unknown) => void
}) {
  const confirmed = raw === undefined || raw === null ? '' : String(raw)
  const [draft, setDraft] = useState(confirmed)
  const editing = useRef(false)
  const numeric = item.type === 'number'
  useEffect(() => { if (!editing.current && draft !== confirmed) setDraft(confirmed) })
  return <Input type={numeric ? 'number' : 'text'} className="plugin-setting-input" aria-label={item.label}
    min={numeric ? item.min : undefined} max={numeric ? item.max : undefined} step={numeric ? item.step ?? 'any' : undefined}
    value={draft} onChange={event => { editing.current = true; setDraft(event.currentTarget.value) }}
    onBlur={event => {
      const changed = editing.current
      editing.current = false
      if (!changed) { setDraft(confirmed); return }
      const input = event.currentTarget, value = input.value
      if (numeric && (!value.trim() || !Number.isFinite(Number(value)) || !input.validity.valid)) {
        setDraft(confirmed)
        const range = Number.isFinite(item.min) && Number.isFinite(item.max) ? `${item.min}～${item.max}`
          : Number.isFinite(item.min) ? `不小于 ${item.min}` : `不大于 ${item.max}`
        notify.warn(input.validity.rangeUnderflow || input.validity.rangeOverflow
          ? `请输入${range}的数字，已恢复原值`
          : input.validity.stepMismatch ? `数字步长应为 ${item.step}，已恢复原值` : '请输入有效数字，已恢复原值')
        return
      }
      if (value !== confirmed) onCommit(numeric ? Number(value) : value)
      else setDraft(confirmed)
    }} />
}

export function PluginSettingsSection({ pluginId: id, title, sections, values, onCommit: handlePluginSetting }: {
  pluginId: string
  title: string
  sections: ShellSettingsSection[]
  values: Record<string, unknown>
  onCommit: ReturnType<typeof usePluginSettings>['handlePluginSetting']
}) {
  const { t } = useI18n()
  const renderValue = (item: PluginSettingsItem) => {
    if (item.type === 'page') {
      return (
        <Button onClick={() => {
          void shellApi.openPlugin(id, item.entry ?? { code: 'settings' }).catch((error: unknown) => {
            notify.error(error instanceof Error ? error.message : '无法打开插件设置')
          })
        }}>打开插件设置</Button>
      )
    }
    const raw = item.key in values ? values[item.key] : item.default
    if (item.type === 'boolean' || item.type === 'bool' || item.type === 'switch') {
      return (
        <Switch
          aria-label={item.label}
          checked={raw !== false && raw != null}
          onCheckedChange={() => handlePluginSetting(id, item.key, !(raw !== false && raw != null))}
        />
      )
    }
    if (item.type === 'select' && Array.isArray(item.options) && item.options.length > 0) {
      return (
        <Select
          className="plugin-setting-select"
          ariaLabel={item.label}
          value={raw === undefined || raw === null ? '' : String(raw)}
          onChange={(v) => {
            const opt = item.options?.find((o) => String(o.value) === v)
            handlePluginSetting(id, item.key, opt ? opt.value : v)
          }}
          options={item.options.map((o) => ({
            value: String(o.value),
            label: o.label
          }))}
        />
      )
    }
    if (item.type === 'number') {
      return <PluginSettingInput item={item} raw={raw} onCommit={value => handlePluginSetting(id, item.key, value)} />
    }
    if (item.type === 'slider') {
      const min = Number.isFinite(item.min) ? (item.min as number) : 0
      const max = Number.isFinite(item.max) ? (item.max as number) : 100
      const step = Number.isFinite(item.step) && item.step! > 0 ? item.step! : 1
      const num = Number(raw)
      const value = Number.isFinite(num) ? Math.min(max, Math.max(min, num)) : min
      return (
        <div className="plugin-slider-row">
          <Slider
            min={min}
            max={max}
            step={step}
            value={[value]}
            aria-label={item.label}
            onValueChange={([next]) => handlePluginSetting(id, item.key, next, true)}
          />
          <span className="plugin-slider-value">{value}</span>
        </div>
      )
    }
    if (item.type === 'color') {
      const color = typeof raw === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(raw) ? raw : PLUGIN_CATEGORY_COLOR_DEFAULT
      return (
        <ColorPickerField
          value={color}
          label={item.label}
          onChange={(hex) => handlePluginSetting(id, item.key, hex, true)}
        />
      )
    }
    // string / text / 非法 type 回退 text（现状保留）+ dev 日志
    if (
      item.type !== 'text' &&
      item.type !== 'string' &&
      import.meta.env.DEV
    ) {
      console.warn('[settings] unknown item type, fallback to text:', item.type, item.key)
    }
    return <PluginSettingInput item={item} raw={raw} onCommit={value => handlePluginSetting(id, item.key, value)} />
  }
  return (
    <Card key={id} title={title} className="plugin-settings-card">
      {sections.length === 0 ? (
        <p className="desc">{t('settings.pluginSection.empty')}</p>
      ) : (
        sections.map((section) => (
          <div key={section.id} className="plugin-settings-section">
            {section.title ? <h3 className="label">{section.title}</h3> : null}
            {section.items.map((item) => (
              <Field key={item.key} label={item.label}>
                {renderValue(item)}
              </Field>
            ))}
          </div>
        ))
      )}
    </Card>
  )
}
