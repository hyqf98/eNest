import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { CustomFontMeta, ThemeMode } from '@shared/types/plugin'
import type { ResolvedAppearance, ThemeIdentity, ThemeProfilePatch, ThemeSettingValue, ThemeSettingsField } from '@shared/types/appearance'
import { appearanceStyleProperties, composeFontStacks, themeProfileKey } from '@shared/theme/appearance'
import { useAppearanceStore } from '@renderer/hooks/useAppearance'
import { useI18n } from '@renderer/hooks/useI18n'
import { shellApi } from '@renderer/services/shellApi'
import { Button } from '@renderer/components/ui/Button'
import { Segmented } from '@renderer/components/ui/Segmented'
import { ThemeSelectionCards } from './ThemeSelectionCards'
import { ThemeSettingsFields } from './ThemeSettingsFields'
import { FreePanelFields, usePanelAppearance } from './PanelAppearanceCard'
import { TransparencyFields } from './TransparencyFields'
import { TabBarFields } from './TabBarFields'
import './appearanceSettings.css'

/**
 * 归属壳的布局键：由「标签栏」「背景透明度」两个固定分区渲染。
 * 主题参数卡里要排除它们，否则第三方主题重复声明同名字段会出现第二套控件。
 */
const HOST_LAYOUT_FIELDS = new Set(['tabStyle', 'tabOpacity', 'tabAutoHide', 'cardOpacity'])

function previewField(appearance: ResolvedAppearance, field: ThemeSettingsField, value: ThemeSettingValue): void {
  const binding = field.binding
  if (binding.target === 'token') appearance.tokens[binding.key] = String(value)
  else if (binding.target === 'layout') (appearance.layout[binding.key] as unknown) = value
  else if (binding.target === 'component') (appearance.components[binding.key] as unknown) = value
  else if (binding.target === 'font') (appearance.fonts[binding.key] as unknown) = value
  else if (binding.target === 'splash') (appearance.splash[binding.key] as unknown) = value
  else if (binding.target === 'notification') (appearance.notifications[binding.key] as unknown) = value
  else if (binding.target === 'background') {
    if (binding.key === 'effect') appearance.background.effect = field.type === 'switch' ? value ? appearance.background.effect : 'none' : String(value)
    else (appearance.background[binding.key] as unknown) = value
  }
}

/**
 * 设置 → 外观：两张卡。
 * 1) 主题配置：深浅模式、已安装主题、自由面板外观（壳级 general.panelAppearance）。
 * 2) 主题参数：当前主题动态声明的字段，切换主题后内容随之更换。
 */
export function AppearanceSettingsSection() {
  const appearance = useAppearanceStore(useShallow(({ appearance, profile, packs, customFonts, hydrated }) => ({ appearance, profile, packs, customFonts, hydrated })))
  const panel = usePanelAppearance()
  const { t } = useI18n()
  const [drafts, setDrafts] = useState<Record<string, ThemeSettingValue>>({})
  const [switching, setSwitching] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [importingFont, setImportingFont] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)
  const pending = useRef<ThemeProfilePatch | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const saves = useRef(Promise.resolve())
  const saveCount = useRef(0)
  const draftVersion = useRef(0)
  const activeKey = themeProfileKey(appearance.profile.identity)
  const activePack = appearance.packs.find(pack => pack.source === appearance.profile.identity.source && pack.id === appearance.profile.identity.id)
  // Global navigation is edited only in Settings > Appearance, never by a theme's form.
  const tuningSchema = activePack ? {
    ...activePack.settings,
    groups: activePack.settings.groups.map(group => ({
      ...group,
      // tabStyle / tabAutoHide 由「标签栏」分区渲染，tabOpacity / cardOpacity 由「背景透明度」分区渲染：
      // 这些布局键归属壳，第三方主题若也声明了同名字段，不能在「主题参数」里出现第二个滑块。
      fields: group.fields.filter(field => field.binding.target !== 'layout' || !HOST_LAYOUT_FIELDS.has(field.binding.key)),
    })).filter(group => group.fields.length > 0),
  } : undefined
  const fields = tuningSchema?.groups.flatMap(group => group.fields) ?? []
  const mergedValues = { ...appearance.profile.values, ...drafts }

  const mediaValues = (field: ThemeSettingsField, value: ThemeSettingValue): Record<string, ThemeSettingValue> => {
    const next: Record<string, ThemeSettingValue> = { [field.key]: value }
    const kind = fields.find(candidate => candidate.binding.target === field.binding.target &&
      candidate.binding.key === (field.binding.target === 'splash' ? 'type' : 'kind'))
    if (kind) next[kind.key] = value && typeof value === 'object' ? value.type : 'none'
    return next
  }

  const flush = (): Promise<void> => {
    clearTimeout(timer.current)
    const patch = pending.current
    pending.current = null
    if (!patch) return saves.current
    const version = draftVersion.current
    saveCount.current++
    setSaving(true)
    saves.current = saves.current.catch(() => undefined).then(async () => {
      try {
        await useAppearanceStore.getState().updateThemeProfile(patch)
        setError(undefined)
      } catch {
        setError(t('settings.appearance.saveFailedRestore'))
      } finally {
        saveCount.current--
        setSaving(saveCount.current > 0)
        if (version === draftVersion.current && !pending.current) setDrafts({})
      }
    })
    return saves.current
  }
  const flushRef = useRef(flush)
  flushRef.current = flush

  useEffect(() => {
    void useAppearanceStore.getState().hydrate().catch(() => setError(t('settings.appearance.readFailed')))
    return () => { void flushRef.current() }
  }, [t])

  useEffect(() => {
    setDrafts({})
  }, [activeKey])

  useEffect(() => {
    const preview = structuredClone(appearance.appearance)
    const fontDraft = fields.some(field => field.binding.target === 'font' && ['latin', 'cjk'].includes(field.binding.key) && Object.hasOwn(drafts, field.key))
    const originalBody = preview.fonts.body
    for (const field of fields) if (Object.hasOwn(drafts, field.key)) previewField(preview, field, drafts[field.key])
    if (fontDraft) {
      const modeFonts = activePack?.variants[preview.mode].fonts
      preview.fonts.body = composeFontStacks(preview.fonts.latin || modeFonts?.latin || '', preview.fonts.cjk || modeFonts?.cjk || '') || originalBody
      if (!preview.fonts.heading || preview.fonts.heading === originalBody) preview.fonts.heading = preview.fonts.body
    }
    for (const [property, value] of Object.entries(appearanceStyleProperties(preview))) document.documentElement.style.setProperty(property, value)
    document.documentElement.dataset.notificationLayout = preview.notifications.layout
    document.documentElement.dataset.notificationAccent = preview.notifications.accent
    document.documentElement.dataset.notificationShadow = preview.notifications.shadow
  }, [appearance.appearance, drafts, activePack])

  const queue = (field: ThemeSettingsField, value: ThemeSettingValue) => {
    if (pending.current && themeProfileKey(pending.current.theme) !== activeKey) void flush()
    const patch = pending.current ?? { theme: { ...appearance.profile.identity }, values: {} }
    const values = field.type === 'media' ? mediaValues(field, value) : { [field.key]: value }
    if (field.type === 'token' && field.binding.target === 'token') {
      const mode = appearance.appearance.mode
      patch.colors = { ...patch.colors, [mode]: { ...patch.colors?.[mode], [field.binding.key]: value as string } }
    } else patch.values = { ...patch.values, ...values }
    pending.current = patch
    draftVersion.current++
    setDrafts(previous => ({ ...previous, ...values }))
    clearTimeout(timer.current)
    timer.current = setTimeout(() => { void flushRef.current() }, 160)
  }

  const activate = async (identity: ThemeIdentity) => {
    const key = themeProfileKey(identity)
    setSwitching(key)
    await flush()
    try { await useAppearanceStore.getState().activateTheme(identity); setError(undefined) }
    catch { setError(t('settings.appearance.themeSwitchFailed')) }
    finally { setSwitching(current => current === key ? null : current) }
  }

  const setMode = async (mode: ThemeMode) => {
    await flush()
    try { await useAppearanceStore.getState().setMode(mode) }
    catch { setError(t('settings.appearance.modeSaveFailed')) }
  }

  const pickMedia = async (field: ThemeSettingsField) => {
    const theme = { ...appearance.profile.identity }
    await flush()
    try {
      if (!shellApi.pickAppearanceMedia) throw new Error('native media import unavailable')
      const media = await shellApi.pickAppearanceMedia({ imageOnly: field.binding.target === 'splash' })
      if (media) await useAppearanceStore.getState().updateThemeProfile({ theme, values: mediaValues(field, media) })
    } catch { setError(t('settings.appearance.mediaImportFailed')) }
  }

  const importFont = async (field: ThemeSettingsField) => {
    const theme = { ...appearance.profile.identity }
    await flush()
    setImportingFont(field.key)
    try {
      if (!shellApi.importAppearanceFont) throw new Error('native font import unavailable')
      const font = await shellApi.importAppearanceFont()
      if (font) {
        await useAppearanceStore.getState().refresh()
        await useAppearanceStore.getState().updateThemeProfile({ theme, values: { [field.key]: `"${font.family}", sans-serif` } })
      }
    } catch { setError(t('settings.appearance.fontImportFailed')) }
    finally { setImportingFont(null) }
  }

  const removeFont = async (font: CustomFontMeta) => {
    await flush()
    try {
      if (!shellApi.removeAppearanceFont) throw new Error('native font management unavailable')
      await shellApi.removeAppearanceFont(font.id)
      await useAppearanceStore.getState().refresh()
    } catch { setError(t('settings.appearance.fontRemoveFailed')) }
  }

  const resetColors = async () => {
    await flush()
    try {
      const colors = Object.fromEntries(Object.keys(appearance.profile.colors[appearance.appearance.mode] ?? {}).map(key => [key, null]))
      await useAppearanceStore.getState().updateThemeProfile({ theme: appearance.profile.identity, colors: { [appearance.appearance.mode]: colors } })
    } catch { setError(t('settings.appearance.colorsResetFailed')) }
  }

  const reload = () => {
    setError(undefined)
    void useAppearanceStore.getState().refresh().catch(() => setError(t('settings.appearance.readFailed')))
  }

  return (
    <div className="appearance-settings-stack">
      {/* 主题配置卡：主题选择 + 自由面板外观（壳级 general.panelAppearance）。 */}
      <section className="s-card appearance-settings appearance-card appearance-card-switch" aria-busy={Boolean(switching)} aria-label={t('settings.appearance.configCardAria')}>
        <div className="appearance-card-head">
          <div className="appearance-card-head-copy">
            <h2>{t('settings.appearance.configTitle')}</h2>
            <p className="hint">
              {appearance.packs.length > 1
                ? t('settings.appearance.configHintMany', { count: String(appearance.packs.length) })
                : t('settings.appearance.configHintSingle')}
            </p>
          </div>
          <Segmented ariaLabel={t('settings.appearance.modeAria')} value={appearance.appearance.requestedMode} onChange={mode => void setMode(mode)} options={[
            { value: 'light', label: t('settings.appearance.modeLight') }, { value: 'dark', label: t('settings.appearance.modeDark') }, { value: 'system', label: t('settings.appearance.modeSystem') },
          ]} />
        </div>
        {!appearance.hydrated
          ? <p className="desc appearance-inline-status" role="status">{error ?? t('settings.appearance.loadingThemes')}</p>
          : appearance.packs.length > 0
            ? <ThemeSelectionCards packs={appearance.packs} selected={appearance.profile.identity} mode={appearance.appearance.mode} pendingKey={switching} disabled={Boolean(switching) || importingFont !== null} onSelect={identity => void activate(identity)} />
            : <div className="appearance-empty" role="status">
              <p>{t('settings.appearance.emptyThemes')}</p>
              <Button variant="ghost" size="sm" onClick={reload}>{t('settings.appearance.reload')}</Button>
            </div>}

        {/* eNest 壳通用：自由面板开关 + 外观（不随主题 profile 走，写 general.freePanel / general.panelAppearance）。 */}
        <div className="appearance-section appearance-section-panel" role="group" aria-label={t('settings.panel.sectionAria')}>
          <div className="appearance-section-head">
            <div className="appearance-section-head-row">
              <h3 className="appearance-section-title">{t('settings.panel.sectionAria')}</h3>
              <div className="appearance-group-tools">
                <Button variant="ghost" size="sm" disabled={panel.loading} onClick={panel.reset}>{t('settings.panel.reset')}</Button>
              </div>
            </div>
          </div>
          <FreePanelFields state={panel} />
        </div>

        {/* 壳级材质浓度：标题栏与设置卡片的透明度。归属壳，但与主题呈现放在一起更好找。 */}
        <div className="appearance-section appearance-section-transparency" role="group" aria-label={t('settings.transparency.sectionAria')}>
          <div className="appearance-section-head">
            <div className="appearance-section-head-row">
              <h3 className="appearance-section-title">{t('settings.transparency.sectionAria')}</h3>
            </div>
            <p className="hint">{t('settings.transparency.sectionHint')}</p>
          </div>
          <TransparencyFields />
        </div>

        {/* 标签栏形态：经典顶栏 / 悬浮圆轨与自动隐藏。与透明度同属"顶栏怎么呈现"，紧随其后。 */}
        <div className="appearance-section appearance-section-tabbar" role="group" aria-label={t('settings.tabbar.sectionAria')}>
          <div className="appearance-section-head">
            <div className="appearance-section-head-row">
              <h3 className="appearance-section-title">{t('settings.tabbar.sectionAria')}</h3>
            </div>
            <p className="hint">{t('settings.tabbar.sectionHint')}</p>
          </div>
          <div className="appearance-panel-fields">
            <TabBarFields />
          </div>
        </div>

        <div className="appearance-unified-footer">
          <span className="appearance-save-status" role="status" aria-live="polite">{error || (saving || panel.saving ? t('settings.appearance.saving') : t('settings.appearance.savedHint'))}</span>
        </div>
      </section>

      {/* 主题参数是当前主题动态声明的字段，与壳级主题配置分开成卡，切换主题时内容随之变化。 */}
      <section className="s-card appearance-settings appearance-card appearance-card-tuning" aria-busy={Boolean(switching)} aria-label={t('settings.appearance.tuningCardAria')}>
        <div className="appearance-card-head">
          <div className="appearance-card-head-copy">
            <h2>{t('settings.appearance.tuningTitle')}</h2>
            <p className="hint">{activePack ? t('settings.appearance.tuningHintActive', { name: activePack.name }) : t('settings.appearance.tuningHintEmpty')}</p>
          </div>
        </div>
        <div className="appearance-section appearance-section-tuning" role="group" aria-label={t('settings.appearance.tuningCardAria')}>
          {appearance.appearance.diagnostics.some(item => item.code === 'home.recovery') && <div className="appearance-recovery" role="status"><p>{t('settings.appearance.recoveryNotice')}</p><Button variant="ghost" size="sm" disabled={retrying} onClick={async () => {
            await flush()
            setRetrying(true)
            try {
              if (!shellApi.retryHome) throw new Error('native recovery unavailable')
              await shellApi.retryHome()
              await useAppearanceStore.getState().refresh()
            } catch { setError(t('settings.appearance.retryFailed')) }
            finally { setRetrying(false) }
          }}>{retrying ? t('settings.appearance.retrying') : t('settings.appearance.retryTheme')}</Button></div>}
          {activePack && tuningSchema
            ? <ThemeSettingsFields embedded schema={tuningSchema} appearance={appearance.appearance} values={mergedValues} customFonts={appearance.customFonts} importingFont={importingFont} palettes={activePack.palettes} disabled={Boolean(switching)} onChange={queue} onCommit={() => void flush()} onPickMedia={field => void pickMedia(field)} onImportFont={field => void importFont(field)} onRemoveFont={font => void removeFont(font)} onResetColors={() => void resetColors()} onPreviewSplash={() => { void flush().then(() => window.dispatchEvent(new Event('enest:preview-splash'))) }} />
            : <p className="desc appearance-inline-status" role="status">{error ?? t('settings.appearance.loadingThemes')}</p>}
          {appearance.appearance.animation.requested !== appearance.appearance.animation.effective && <p className="desc appearance-inline-status">{t('settings.appearance.animationReduced')}</p>}
        </div>
        <div className="appearance-unified-footer">
          <span className="appearance-save-status" role="status" aria-live="polite">{saving ? t('settings.appearance.saving') : t('settings.appearance.savedHint')}</span>
          {activePack && <Button variant="ghost" size="sm" onClick={async () => { await flush(); try { await useAppearanceStore.getState().updateThemeProfile({ theme: appearance.profile.identity, reset: true }) } catch { setError(t('settings.appearance.resetThemeFailed')) } }}>{t('settings.appearance.resetTheme')}</Button>}
        </div>
      </section>
    </div>
  )
}
