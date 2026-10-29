import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { CustomFontMeta, ThemeMode } from '@shared/types/plugin'
import type { ResolvedAppearance, ThemeIdentity, ThemeProfilePatch, ThemeSettingValue, ThemeSettingsField } from '@shared/types/appearance'
import { appearanceStyleProperties, composeFontStacks, themeProfileKey } from '@shared/theme/appearance'
import { useAppearanceStore } from '@renderer/hooks/useAppearance'
import { shellApi } from '@renderer/services/shellApi'
import { Button } from '@renderer/components/ui/Button'
import { Segmented } from '@renderer/components/ui/Segmented'
import { ThemeSelectionCards } from './ThemeSelectionCards'
import { ThemeSettingsFields } from './ThemeSettingsFields'
import { FreePanelFields, usePanelAppearance } from './PanelAppearanceCard'
import './appearanceSettings.css'

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
 * 设置 → 外观的唯一一张卡：主题配置（深浅模式与全部已安装主题）
 * → 自由面板外观（壳级 general.panelAppearance）→ 主题参数（当前主题声明的字段）→ 统一 footer。
 */
export function AppearanceSettingsSection() {
  const appearance = useAppearanceStore(useShallow(({ appearance, profile, packs, customFonts, hydrated }) => ({ appearance, profile, packs, customFonts, hydrated })))
  const panel = usePanelAppearance()
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
  // Global navigation is edited only in Settings > General, never by a theme's form.
  const tuningSchema = activePack ? {
    ...activePack.settings,
    groups: activePack.settings.groups.map(group => ({
      ...group,
      fields: group.fields.filter(field => field.binding.target !== 'layout' || !['tabStyle', 'tabOpacity', 'tabAutoHide'].includes(field.binding.key)),
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
        setError('设置未保存，已恢复到宿主确认的外观。')
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
    void useAppearanceStore.getState().hydrate().catch(() => setError('无法读取外观设置，请重试。'))
    return () => { void flushRef.current() }
  }, [])

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
    catch { setError('主题切换失败，仍保留已确认的主题。') }
    finally { setSwitching(current => current === key ? null : current) }
  }

  const setMode = async (mode: ThemeMode) => {
    await flush()
    try { await useAppearanceStore.getState().setMode(mode) }
    catch { setError('颜色模式未保存，请重试。') }
  }

  const pickMedia = async (field: ThemeSettingsField) => {
    const theme = { ...appearance.profile.identity }
    await flush()
    try {
      if (!shellApi.pickAppearanceMedia) throw new Error('native media import unavailable')
      const media = await shellApi.pickAppearanceMedia({ imageOnly: field.binding.target === 'splash' })
      if (media) await useAppearanceStore.getState().updateThemeProfile({ theme, values: mediaValues(field, media) })
    } catch { setError('背景导入失败，原背景未更改。') }
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
    } catch { setError('字体导入失败，当前字体未更改。') }
    finally { setImportingFont(null) }
  }

  const removeFont = async (font: CustomFontMeta) => {
    await flush()
    try {
      if (!shellApi.removeAppearanceFont) throw new Error('native font management unavailable')
      await shellApi.removeAppearanceFont(font.id)
      await useAppearanceStore.getState().refresh()
    } catch { setError('字体未删除，请重试。') }
  }

  const resetColors = async () => {
    await flush()
    try {
      const colors = Object.fromEntries(Object.keys(appearance.profile.colors[appearance.appearance.mode] ?? {}).map(key => [key, null]))
      await useAppearanceStore.getState().updateThemeProfile({ theme: appearance.profile.identity, colors: { [appearance.appearance.mode]: colors } })
    } catch { setError('当前配色未恢复，请重试。') }
  }

  const reload = () => {
    setError(undefined)
    void useAppearanceStore.getState().refresh().catch(() => setError('无法读取外观设置，请重试。'))
  }

  return (
    <div className="appearance-settings-stack">
      {/* 一张卡承载三段：主题选择 / 自由面板外观（壳级）/ 主题参数（当前主题声明）。两个语义 class 保留为分区锚点。 */}
      <section className="s-card appearance-settings appearance-card appearance-card-switch appearance-card-tuning" aria-busy={Boolean(switching)} aria-label="主题配置">
        <div className="appearance-card-head">
          <div className="appearance-card-head-copy">
            <h2>主题配置</h2>
            <p className="hint">
              {appearance.packs.length > 1
                ? `已安装 ${appearance.packs.length} 个主题，安装插件带来的主题也会出现在这里，选中即刻生效。`
                : '当前只有内置主题；安装带主题的插件后，它会出现在这里，选中即可切换。'}
            </p>
          </div>
          <Segmented ariaLabel="颜色模式" value={appearance.appearance.requestedMode} onChange={mode => void setMode(mode)} options={[
            { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }, { value: 'system', label: '跟随系统' },
          ]} />
        </div>
        {!appearance.hydrated
          ? <p className="desc appearance-inline-status" role="status">{error ?? '正在读取主题…'}</p>
          : appearance.packs.length > 0
            ? <ThemeSelectionCards packs={appearance.packs} selected={appearance.profile.identity} mode={appearance.appearance.mode} pendingKey={switching} disabled={Boolean(switching) || importingFont !== null} onSelect={identity => void activate(identity)} />
            : <div className="appearance-empty" role="status">
              <p>还没有可用的主题。</p>
              <Button variant="ghost" size="sm" onClick={reload}>重新读取</Button>
            </div>}

        {/* eNest 壳通用：自由面板开关 + 外观（不随主题 profile 走，写 general.freePanel / general.panelAppearance）。 */}
        <div className="appearance-section appearance-section-panel" role="group" aria-label="自由面板">
          <div className="appearance-section-head">
            <div className="appearance-section-head-row">
              <h3 className="appearance-section-title">自由面板</h3>
              <div className="appearance-group-tools">
                <Button variant="ghost" size="sm" disabled={panel.loading} onClick={panel.reset}>恢复默认</Button>
              </div>
            </div>
            <p className="hint">把插件固定成桌面小组件；所有面板共用的底板材质与不透明度（材质由系统提供：毛玻璃 = 桌面级模糊，系统材质 = 更重的浮窗质感）。</p>
          </div>
          <FreePanelFields state={panel} />
        </div>

        <div className="appearance-section appearance-section-tuning" role="group" aria-label="主题参数">
          <div className="appearance-section-head">
            <h3 className="appearance-section-title">主题参数</h3>
            <p className="hint">{activePack ? `以下参数来自「${activePack.name}」，切换主题后会换成新主题支持的设置。` : '当前没有可调整的主题参数。'}</p>
          </div>
          {appearance.appearance.diagnostics.some(item => item.code === 'home.recovery') && <div className="appearance-recovery" role="status"><p>主题或配套首页暂不可用，已安全回退到默认主题；原主题的调整仍保留。</p><Button variant="ghost" size="sm" disabled={retrying} onClick={async () => {
            await flush()
            setRetrying(true)
            try {
              if (!shellApi.retryHome) throw new Error('native recovery unavailable')
              await shellApi.retryHome()
              await useAppearanceStore.getState().refresh()
            } catch { setError('重试未成功，继续使用当前安全主题。') }
            finally { setRetrying(false) }
          }}>{retrying ? '正在重试…' : '重试原主题'}</Button></div>}
          {activePack && tuningSchema
            ? <ThemeSettingsFields embedded schema={tuningSchema} appearance={appearance.appearance} values={mergedValues} customFonts={appearance.customFonts} importingFont={importingFont} palettes={activePack.palettes} disabled={Boolean(switching)} onChange={queue} onCommit={() => void flush()} onPickMedia={field => void pickMedia(field)} onImportFont={field => void importFont(field)} onRemoveFont={font => void removeFont(font)} onResetColors={() => void resetColors()} onPreviewSplash={() => { void flush().then(() => window.dispatchEvent(new Event('enest:preview-splash'))) }} />
            : <p className="desc appearance-inline-status" role="status">{error ?? '正在读取主题…'}</p>}
          {appearance.appearance.animation.requested !== appearance.appearance.animation.effective && <p className="desc appearance-inline-status">当前已按无障碍或运行性能限制减少动态效果；你保存的动画强度未改变。</p>}
        </div>

        <div className="appearance-unified-footer">
          <span className="appearance-save-status" role="status" aria-live="polite">{error || (saving || panel.saving ? '正在保存…' : '调整即时预览，保存后同步所有窗口与已开面板。')}</span>
          {activePack && <Button variant="ghost" size="sm" onClick={async () => { await flush(); try { await useAppearanceStore.getState().updateThemeProfile({ theme: appearance.profile.identity, reset: true }) } catch { setError('恢复默认失败，请重试。') } }}>恢复本主题默认</Button>}
        </div>
      </section>
    </div>
  )
}
