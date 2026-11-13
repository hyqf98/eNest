/**
 * TransparencyFields —— 壳级「材质浓度」控件
 *
 * 两个滑块都是壳的通用外观参数（`appearance.layout`），不随主题包变化：
 * - 标题栏透明度：控制窗口顶部标题栏的底色与磨砂浓度
 * - 设置卡片透明度：控制设置页卡片材质的底色与磨砂浓度
 *
 * 存储值始终是「不透明度」（0 = 全透明、1 = 实色），滑块对外显示「透明度」
 * （右端更透明）。换算只在这一层做，历史值与主题 schema 都不变。
 *
 * 放在「设置 → 主题」首卡：它们是"主题如何呈现"的一部分，但归属壳而非主题包。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppearanceStore } from '@renderer/hooks/useAppearance'
import { useI18n } from '@renderer/hooks/useI18n'
import { Slider } from '@renderer/components/ui/Slider'
import type { ResolvedAppearance, ThemeIdentity, ThemeSettingsField, ThemeSettingValue } from '@shared/types/appearance'
import { DEFAULT_THEME_IDENTITY } from '@shared/theme/builtinThemes'
import { themeProfileKey } from '@shared/theme/appearance'
import { Field } from './SettingsFields'

/** 取整到 4 位小数：`1 - 0.82` 会得到 0.18000000000000005，直接喂 Slider 会露出长尾。 */
const round = (value: number) => Math.round(value * 10_000) / 10_000

export function TransparencyFields() {
  const appearance = useAppearanceStore((s) => s.appearance)
  const packs = useAppearanceStore((s) => s.packs)
  const { locale } = useI18n()
  const en = locale === 'en-US'

  /** 两个字段都从当前主题的 schema 里取：主题可以决定是否暴露这两个滑块。 */
  const activePack = packs.find(pack => pack.source === DEFAULT_THEME_IDENTITY.source && pack.id === DEFAULT_THEME_IDENTITY.id)
  const fieldFor = (key: string) => activePack?.settings.groups
    .flatMap(group => group.fields)
    .find(field => field.binding.target === 'layout' && field.binding.key === key && field.type === 'slider')
  const tabField = fieldFor('tabOpacity')
  const cardField = fieldFor('cardOpacity')

  const min = Math.max(0, tabField?.min ?? 0)
  const max = Math.min(1, tabField?.max ?? 1)
  const step = tabField?.step ?? 0.05
  const tabEnabled = Boolean(tabField) && Number.isFinite(min) && Number.isFinite(max) && min < max && Number.isFinite(step) && step > 0

  const [tabDraft, setTabDraft] = useState<number | null>(null)
  const [cardDraft, setCardDraft] = useState<number | null>(null)
  const tabDraftRef = useRef<number | null>(null)
  const cardDraftRef = useRef<number | null>(null)
  const tabVersion = useRef(0)
  const requestVersion = useRef(0)
  const mounted = useRef(true)
  const saves = useRef(Promise.resolve())

  // 两个变量在离开页面时回到已保存值，避免预览残留在其它窗口。
  const restore = useCallback(() => {
    const layout = useAppearanceStore.getState().appearance.layout
    document.documentElement.style.setProperty('--appearance-tab-opacity', String(layout.tabOpacity ?? 0))
    document.documentElement.style.setProperty('--appearance-card-opacity', String(layout.cardOpacity ?? 0.82))
  }, [])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; restore() }
  }, [restore])

  const commit = (field: ThemeSettingsField | undefined, value: ThemeSettingValue, version?: number) => {
    if (!field) return
    const request = ++requestVersion.current
    saves.current = saves.current.then(async () => {
      const state = useAppearanceStore.getState()
      try {
        const currentField = state.packs.find(pack => pack.source === DEFAULT_THEME_IDENTITY.source && pack.id === DEFAULT_THEME_IDENTITY.id)
          ?.settings.groups.flatMap(group => group.fields)
          .find(candidate => candidate.binding.target === 'layout' && candidate.binding.key === field.binding.key && candidate.type === field.type)
        if (!currentField) throw new Error('Host layout binding unavailable')
        await state.updateThemeProfile({ theme: { ...DEFAULT_THEME_IDENTITY }, values: { [currentField.key]: value } })
      } finally {
        if (mounted.current && version !== undefined && version === tabVersion.current) {
          tabDraftRef.current = null
          setTabDraft(null)
          restore()
        }
        // request 只用于抑制过期会话的报错提示，这里无需额外状态
        void request
      }
    })
  }

  const previewTab = (transparency: number) => {
    if (!tabEnabled) return
    const stored = Math.min(max, Math.max(min, round(1 - transparency)))
    tabVersion.current++
    tabDraftRef.current = stored
    setTabDraft(stored)
    document.documentElement.style.setProperty('--appearance-tab-opacity', String(stored))
    return stored
  }
  const previewCard = (transparency: number) => {
    if (!cardField) return
    const stored = Math.min(1, Math.max(0, round(1 - transparency)))
    cardDraftRef.current = stored
    setCardDraft(stored)
    document.documentElement.style.setProperty('--appearance-card-opacity', String(stored))
    return stored
  }

  const tabStored = tabDraft ?? appearance.layout.tabOpacity ?? 0
  const cardStored = cardDraft ?? appearance.layout.cardOpacity ?? 0.82
  if (!tabField && !cardField) return null

  return (
    <>
      {tabField && (
        <Field
          label={en ? 'Titlebar transparency' : '标题栏透明度'}
          desc={en ? 'Higher means more transparent; labels and window buttons stay opaque.' : '越往右越透明，可透出窗口背景动效；标签与窗口按钮始终清晰。'}
        >
          <div className="appearance-slider-row">
            <Slider
              aria-label={en ? 'Titlebar transparency' : '标题栏透明度'}
              min={min} max={max} step={step}
              disabled={!tabEnabled}
              value={[round(1 - tabStored)]}
              onValueChange={([next]) => { previewTab(next) }}
              onValueCommit={([value]) => {
                const stored = previewTab(value)
                if (stored !== undefined) commit(tabField, stored, tabVersion.current)
              }}
            />
            <output>{Math.round(round(1 - tabStored) * 100)}%</output>
          </div>
        </Field>
      )}
      {cardField && (
        <Field
          label={en ? 'Settings card transparency' : '设置卡片透明度'}
          desc={en ? 'Higher means more transparent; text and controls stay readable.' : '越往右越透明，可让页面背景动效透进设置卡片；文字与控件保持清晰。'}
        >
          <div className="appearance-slider-row">
            <Slider
              aria-label={en ? 'Settings card transparency' : '设置卡片透明度'}
              min={0} max={1} step={cardField.step ?? 0.05}
              value={[round(1 - cardStored)]}
              onValueChange={([next]) => { previewCard(next) }}
              onValueCommit={([value]) => {
                const stored = previewCard(value)
                if (stored !== undefined) commit(cardField, stored)
              }}
            />
            <output>{Math.round(round(1 - cardStored) * 100)}%</output>
          </div>
        </Field>
      )}
    </>
  )
}
