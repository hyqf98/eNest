import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppearanceStore } from '@renderer/hooks/useAppearance'
import { useI18n } from '@renderer/hooks/useI18n'
import { Segmented } from '@renderer/components/ui/Segmented'
import { Switch } from '@renderer/components/ui/Switch'
import { Slider } from '@renderer/components/ui/Slider'
import { Button } from '@renderer/components/ui/Button'
import type { ResolvedAppearance, ThemeIdentity, ThemeSettingsField, ThemeSettingValue } from '@shared/types/appearance'
import { DEFAULT_THEME_IDENTITY } from '@shared/theme/builtinThemes'
import { Card, Field } from './SettingsFields'

export function TopTabBarSection() {
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
  return (
    <Card
      title={en ? 'Tab bar' : '标签栏'}
      hint={en ? 'Choose top tabs or the floating orb rail. Your choice is global and stays unchanged when switching themes.' : '顶部标签与悬浮圆轨二选一；这是全局设置，切换主题不会改变，会话也不会丢失。'}
    >
      {!hydrated ? (
        <>
          <p className="desc" role="status">{readFailed ? (en ? 'Could not load appearance settings.' : '无法读取外观设置。') : t('common.loading')}</p>
          {readFailed && <Button variant="ghost" size="sm" onClick={() => { setReadFailed(false); setReadAttempt(value => value + 1) }}>{en ? 'Retry' : '重试'}</Button>}
        </>
      ) : pack ? (
        <TopTabBarControls
          key={JSON.stringify([pack.source, pack.id, pack.version, pack.settings.version])}
          appearance={appearance}
          identity={DEFAULT_THEME_IDENTITY}
          fields={pack.settings.groups.flatMap(group => group.fields)}
        />
      ) : (
        <p className="desc" role="status">{en ? 'Host navigation settings are unavailable. Please reload settings.' : '宿主导航设置暂不可用，请重新读取设置。'}</p>
      )}
    </Card>
  )
}

/** Only schema-declared bindings are writable; drafts never mutate the appearance store. */
function TopTabBarControls({ appearance, identity, fields }: {
  appearance: ResolvedAppearance
  identity: ThemeIdentity
  fields: ThemeSettingsField[]
}) {
  const { t, locale } = useI18n()
  const en = locale === 'en-US'
  const fieldFor = (key: string, type: ThemeSettingsField['type']) => fields.find(field => field.binding.target === 'layout' && field.binding.key === key && field.type === type)
  const styleField = fieldFor('tabStyle', 'select')
  const opacityField = fieldFor('tabOpacity', 'slider')
  const autoHideField = fieldFor('tabAutoHide', 'switch')
  const tabStyle = appearance.layout.tabStyle === 'orb' ? 'orb' : 'classic'
  const isClassic = tabStyle === 'classic'
  const min = Math.max(0, opacityField?.min ?? 0)
  const max = Math.min(1, opacityField?.max ?? 1)
  const step = opacityField?.step ?? 0.05
  const opacityEnabled = Boolean(opacityField) && Number.isFinite(min) && Number.isFinite(max) && min < max && Number.isFinite(step) && step > 0
  const [opacityDraft, setOpacityDraft] = useState<number | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const draft = useRef<number | null>(null)
  const draftVersion = useRef(0)
  const requestVersion = useRef(0)
  const mounted = useRef(true)
  const saves = useRef(Promise.resolve())
  const restoreOpacity = useCallback(() => {
    document.documentElement.style.setProperty('--appearance-tab-opacity', String(useAppearanceStore.getState().appearance.layout.tabOpacity ?? 1))
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; restoreOpacity() }
  }, [restoreOpacity])

  useEffect(() => {
    if (draft.current === null) return
    if (!isClassic) {
      draftVersion.current++
      draft.current = null
      setOpacityDraft(null)
      restoreOpacity()
    } else {
      document.documentElement.style.setProperty('--appearance-tab-opacity', String(draft.current))
    }
  }, [appearance, isClassic, restoreOpacity])

  const commit = (field: ThemeSettingsField | undefined, value: ThemeSettingValue, opacityVersion?: number) => {
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
      } finally {
        if (mounted.current && opacityVersion !== undefined && opacityVersion === draftVersion.current) {
          draft.current = null
          setOpacityDraft(null)
          restoreOpacity()
        }
      }
    })
  }

  const previewOpacity = (value: number | undefined) => {
    if (value === undefined || !Number.isFinite(value) || !opacityEnabled || !isClassic) return
    const next = Math.min(max, Math.max(min, value))
    draftVersion.current++
    draft.current = next
    setOpacityDraft(next)
    document.documentElement.style.setProperty('--appearance-tab-opacity', String(next))
    return next
  }
  const opacity = opacityDraft ?? appearance.layout.tabOpacity ?? 1
  const opacityLabel = en ? 'Top bar background opacity' : '顶部标题栏背景不透明度'
  const autoHideLabel = en ? 'Auto-hide' : '自动隐藏'
  return (
    <>
      <Field label={t('settings.general.tabStyle')}>
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
        <>
          <Field label={en ? 'Background opacity' : '背景不透明度'} desc={en ? 'Only the background changes; labels and window buttons remain opaque.' : '仅调整背景，不影响标签和窗口按钮的可见度。'}>
            <div className="appearance-slider-row">
              <Slider
                aria-label={opacityLabel}
                min={min}
                max={max}
                step={step}
                disabled={!opacityEnabled}
                value={[opacity]}
                onValueChange={([next]) => { previewOpacity(next) }}
                onValueCommit={([value]) => {
                  const next = previewOpacity(value)
                  if (next !== undefined) commit(opacityField, next, draftVersion.current)
                }}
              />
              <output>{Math.round(opacity * 100)}%</output>
            </div>
          </Field>
          <Field label={autoHideLabel} desc={en ? 'Hide the top bar when the pointer leaves; move to the top edge to reveal it.' : '指针离开后收起标题栏，移到窗口顶部边缘即展开。'}>
            <Switch
              aria-label={autoHideLabel}
              checked={appearance.layout.tabAutoHide === true}
              disabled={!autoHideField}
              onCheckedChange={next => commit(autoHideField, next)}
            />
          </Field>
        </>
      )}
      {(!styleField || (isClassic && (!opacityField || !autoHideField))) && <p className="desc">{en ? 'Some host navigation settings are unavailable.' : '部分宿主导航设置暂不可用。'}</p>}
      {saveFailed && <p className="desc" role="alert">{en ? 'Settings were not saved. The last confirmed appearance has been restored.' : '设置未保存，已恢复到宿主确认的外观。'}</p>}
    </>
  )
}
