/**
 * TabBarFields —— 「设置 → 主题 → 标签栏」分区
 *
 * 标签栏是壳的导航形态（经典顶栏 / 悬浮圆轨）与标题栏自动隐藏。
 * 它此前在「设置 → 通用」里，与标题栏透明度分处两页；两者同属"顶栏怎么呈现"，
 * 现在统一放到主题页的背景透明度分区之后。
 *
 * 归属仍是壳：读取默认主题 profile 的 layout 绑定，切换第三方主题不会改变选择，
 * 也不会丢会话标签。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppearanceStore } from '@renderer/hooks/useAppearance'
import { useI18n } from '@renderer/hooks/useI18n'
import { Segmented } from '@renderer/components/ui/Segmented'
import { Switch } from '@renderer/components/ui/Switch'
import { Button } from '@renderer/components/ui/Button'
import type { ThemeIdentity, ThemeSettingsField, ThemeSettingValue } from '@shared/types/appearance'
import { DEFAULT_THEME_IDENTITY } from '@shared/theme/builtinThemes'
import { Field } from './SettingsFields'

export function TabBarFields() {
  const appearance = useAppearanceStore((s) => s.appearance)
  const packs = useAppearanceStore((s) => s.packs)
  const hydrated = useAppearanceStore((s) => s.hydrated)
  const { t, locale } = useI18n()
  const [readFailed, setReadFailed] = useState(false)
  const [readAttempt, setReadAttempt] = useState(0)
  const en = locale === 'en-US'

  useEffect(() => {
    let cancelled = false
    if (!hydrated) {
      void useAppearanceStore.getState().hydrate().catch(() => {
        if (!cancelled) setReadFailed(true)
      })
    }
    return () => { cancelled = true }
  }, [hydrated, readAttempt])

  // Navigation preferences use the host's existing profile even while another theme is active.
  const pack = hydrated ? packs.find(candidate => candidate.source === DEFAULT_THEME_IDENTITY.source && candidate.id === DEFAULT_THEME_IDENTITY.id) : undefined

  if (!hydrated) {
    return (
      <p className="desc appearance-inline-status" role="status">
        {readFailed ? (en ? 'Could not load appearance settings.' : '无法读取外观设置。') : t('common.loading')}
        {readFailed && <Button variant="ghost" size="sm" onClick={() => { setReadFailed(false); setReadAttempt(value => value + 1) }}>{en ? 'Retry' : '重试'}</Button>}
      </p>
    )
  }
  if (!pack) return <p className="desc appearance-inline-status" role="status">{en ? 'Host navigation settings are unavailable. Please reload settings.' : '宿主导航设置暂不可用，请重新读取设置。'}</p>
  return (
    <TabBarControls
      key={JSON.stringify([pack.source, pack.id, pack.version, pack.settings.version])}
      identity={DEFAULT_THEME_IDENTITY}
      fields={pack.settings.groups.flatMap(group => group.fields)}
    />
  )
}

/** Only schema-declared bindings are writable; drafts never mutate the appearance store. */
function TabBarControls({ identity, fields }: {
  identity: ThemeIdentity
  fields: ThemeSettingsField[]
}) {
  const appearance = useAppearanceStore((s) => s.appearance)
  const { t, locale } = useI18n()
  const en = locale === 'en-US'
  const fieldFor = (key: string, type: ThemeSettingsField['type']) => fields.find(field => field.binding.target === 'layout' && field.binding.key === key && field.type === type)
  const styleField = fieldFor('tabStyle', 'select')
  const autoHideField = fieldFor('tabAutoHide', 'switch')
  const tabStyle = appearance.layout.tabStyle === 'orb' ? 'orb' : 'classic'
  const isClassic = tabStyle === 'classic'
  const [saveFailed, setSaveFailed] = useState(false)
  const requestVersion = useRef(0)
  const mounted = useRef(true)
  const saves = useRef(Promise.resolve())

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const commit = useCallback((field: ThemeSettingsField | undefined, value: ThemeSettingValue) => {
    if (!field) return
    const request = ++requestVersion.current
    setSaveFailed(false)
    // Serialize commits without disabling a slider that may already be in another gesture.
    saves.current = saves.current.then(async () => {
      const state = useAppearanceStore.getState()
      try {
        const currentField = state.packs.find(pack => pack.source === identity.source && pack.id === identity.id)
          ?.settings.groups.flatMap(group => group.fields).find(candidate => candidate.binding.target === 'layout' && candidate.binding.key === field.binding.key && candidate.type === field.type)
        if (!currentField) throw new Error('Host navigation binding unavailable')
        await state.updateThemeProfile({ theme: { ...identity }, values: { [currentField.key]: value } })
      } catch {
        if (mounted.current && request === requestVersion.current) setSaveFailed(true)
      }
    })
  }, [identity])

  const autoHideLabel = en ? 'Auto-hide' : '自动隐藏'
  return (
    <>
      <Field
        label={t('settings.general.tabStyle')}
        desc={t('settings.general.tabStyleDesc')}
      >
        <Segmented
          ariaLabel={t('settings.general.tabStyle')}
          value={tabStyle}
          disabled={!styleField}
          options={[
            { value: 'classic', label: t('settings.general.tabStyleClassic'), disabled: !styleField?.options?.some(option => option.value === 'classic') },
            { value: 'orb', label: t('settings.general.tabStyleOrb'), disabled: !styleField?.options?.some(option => option.value === 'orb') },
          ]}
          onChange={next => commit(styleField, next)}
        />
      </Field>
      {isClassic && (
        <Field label={autoHideLabel} desc={en ? 'Hide the top bar when the pointer leaves; move to the top edge to reveal it.' : '指针离开后收起标题栏，移到窗口顶部边缘即展开。'}>
          <Switch
            aria-label={autoHideLabel}
            checked={appearance.layout.tabAutoHide === true}
            disabled={!autoHideField}
            onCheckedChange={next => commit(autoHideField, next)}
          />
        </Field>
      )}
      {(!styleField || (isClassic && !autoHideField)) && <p className="desc">{en ? 'Some host navigation settings are unavailable.' : '部分宿主导航设置暂不可用。'}</p>}
      {saveFailed && <p className="desc" role="alert">{en ? 'Settings were not saved. The last confirmed appearance has been restored.' : '设置未保存，已恢复到宿主确认的外观。'}</p>}
    </>
  )
}
