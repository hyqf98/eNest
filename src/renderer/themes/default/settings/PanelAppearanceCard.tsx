/**
 * PanelAppearanceCard — 设置 → 主题「自由面板」分区（eNest 壳通用外观 + 功能开关）
 * 职责：
 *  - 功能开关（general.freePanel.enabled）：开启恢复布局、关闭释放面板内插件（保留布局）。
 *  - 开启后展示「新建面板 / 面板快捷键」与底板材质、不透明度（general.panelAppearance）。
 * 关键约束：
 *  - 壳级设置，不随主题 profile 变化；面板外观即时预览 + 300ms 防抖提交，
 *    失败时恢复宿主已确认值（与主题参数同一语义）。
 *  - 只渲染分区内容；外层卡片、标题与统一 footer 由 AppearanceSettingsSection 提供。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_PANEL_APPEARANCE, type PanelAppearance, type PanelBounds, type PanelMaterial } from '@shared/types/panel'
import { IS_MAC } from '@shared/platform'
import { shellApi } from '@renderer/services/shellApi'
import { notify } from '@renderer/services/notifyService'
import { useI18n } from '@renderer/hooks/useI18n'
import { Slider } from '@renderer/components/ui/Slider'
import { Button } from '@renderer/components/ui/Button'
import { Switch } from '@renderer/components/ui/Switch'
import { ShortcutRecorder } from './ShortcutRecorder'
import './appearanceSettings.css'

const PLATFORM_MATERIALS: PanelMaterial[] = ['none', 'blur', 'system']

/** 材质文案键：渲染时经 t() 取词，不再持有硬编码双语文案。 */
const MATERIAL_KEYS: Record<PanelMaterial, string> = {
  none: 'settings.panel.materialNone',
  blur: 'settings.panel.materialBlur',
  system: 'settings.panel.materialSystem'
}

export interface PanelAppearanceController {
  /** 预览用草稿：滑杆与材质按钮立即反映它 */
  draft: PanelAppearance
  loading: boolean
  saving: boolean
  error?: string
  update: (next: PanelAppearance) => void
  reset: () => void
  retry: () => void
}

function normalizeAppearance(raw: unknown): PanelAppearance {
  const value = (raw ?? {}) as Partial<PanelAppearance>
  const opacity = typeof value.opacity === 'number' && Number.isFinite(value.opacity)
    ? Math.min(1, Math.max(0, value.opacity))
    : DEFAULT_PANEL_APPEARANCE.opacity
  const material = PLATFORM_MATERIALS.includes(value.material as PanelMaterial)
    ? (value.material as PanelMaterial)
    : DEFAULT_PANEL_APPEARANCE.material
  return { opacity, material }
}

/** 面板外观的读取 / 防抖提交 / 失败回滚；由外观页统一持有，便于合并保存状态。 */
export function usePanelAppearance(): PanelAppearanceController {
  const { t } = useI18n()
  const confirmed = useRef<PanelAppearance>(DEFAULT_PANEL_APPEARANCE)
  const [draft, setDraft] = useState<PanelAppearance>(DEFAULT_PANEL_APPEARANCE)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const saves = useRef(Promise.resolve())
  const request = useRef(0)
  const version = useRef(0)
  const mounted = useRef(false)
  const pending = useRef<{ value: PanelAppearance; version: number } | null>(null)

  const refresh = useCallback(async () => {
    const revision = ++request.current
    const draftVersion = version.current
    try {
      await saves.current
      const settings = await shellApi.getSettings()
      if (!mounted.current || revision !== request.current) return
      const next = normalizeAppearance(settings.general?.panelAppearance)
      confirmed.current = next
      if (version.current === draftVersion && !pending.current) {
        setDraft(next)
        setError(undefined)
      }
    } catch {
      if (mounted.current && revision === request.current) setError(t('settings.panel.readFailed'))
    } finally {
      if (mounted.current && revision === request.current) setLoading(false)
    }
  }, [t])

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = undefined
    const change = pending.current
    pending.current = null
    if (!change) return saves.current
    saves.current = saves.current.then(async () => {
      try {
        await shellApi.setSettings({ general: { panelAppearance: change.value } })
        confirmed.current = change.value
        if (mounted.current && version.current === change.version) {
          setDraft(change.value)
          setError(undefined)
        }
      } catch {
        if (mounted.current && version.current === change.version) {
          setError(t('settings.panel.saveFailedRestore'))
          setDraft(confirmed.current)
        }
      } finally {
        if (mounted.current && version.current === change.version) setSaving(false)
      }
    })
    return saves.current
  }, [t])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const off = shellApi.onEvent(payload => {
      if (payload.type === 'settings-changed' && payload.generalKeys.includes('panelAppearance')) void refresh()
    })
    return () => {
      mounted.current = false
      request.current++
      off()
      // Leaving settings must not discard the last debounced edit.
      void flush()
    }
  }, [flush, refresh])

  const update = useCallback((value: PanelAppearance) => {
    const next = normalizeAppearance(value)
    pending.current = { value: next, version: ++version.current }
    setDraft(next)
    setSaving(true)
    setError(undefined)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { void flush() }, 300)
  }, [flush])

  const reset = useCallback(() => {
    update(DEFAULT_PANEL_APPEARANCE)
  }, [update])

  const retry = useCallback(() => { setLoading(true); void refresh() }, [refresh])

  return { draft, loading, saving, error, update, reset, retry }
}

/** 自由面板分区：功能开关 + 开启后的外观与快捷键参数。 */
export function FreePanelFields({ state }: { state: PanelAppearanceController }) {
  const { t } = useI18n()
  const { loading, error, retry } = state
  const [enabled, setEnabled] = useState(false)
  const [hotkey, setHotkey] = useState('')
  /** 面板实况：数量、首个面板的宽高比与组件数，用于预览图。 */
  const [panels, setPanels] = useState<Array<{ id: string; bounds: PanelBounds; widgetCount: number }>>([])
  const [busy, setBusy] = useState(false)

  const refreshSwitch = useCallback(async () => {
    try {
      const settings = await shellApi.getSettings()
      const general = settings.general ?? {}
      setEnabled(general.freePanel?.enabled === true)
      // 主进程未配置时回平台默认；general.panelHotkey 存归一后的 accelerator。
      if (typeof general.panelHotkey === 'string' && general.panelHotkey) setHotkey(general.panelHotkey)
      else setHotkey(IS_MAC ? 'Command+Shift+P' : 'Ctrl+Shift+P')
      setPanels(shellApi.listPanels ? await shellApi.listPanels() : [])
    } catch {
      /* 读取失败保持当前值 */
    }
  }, [])

  useEffect(() => {
    void refreshSwitch()
    // 面板增删 / 设置变更后刷新数量与开关。
    const off = shellApi.onEvent?.(payload => {
      if (payload.type === 'panels-changed' || (payload.type === 'settings-changed' && payload.generalKeys.some(key => key === 'freePanel' || key === 'panelHotkey'))) {
        void refreshSwitch()
      }
    })
    return () => off?.()
  }, [refreshSwitch])

  const toggle = useCallback(async () => {
    if (busy) return
    setBusy(true)
    const next = !enabled
    setEnabled(next)
    try {
      await shellApi.setSettings({ general: { freePanel: { enabled: next } } })
      notify.info(next ? t('settings.panel.enabledNotify') : t('settings.panel.disabledNotify'))
    } catch (error) {
      setEnabled(!next)
      notify.error(error instanceof Error ? error.message : t('settings.panel.saveFailedNotify'))
    } finally {
      setBusy(false)
    }
  }, [busy, enabled, t])

  const create = useCallback(async () => {
    if (busy || !shellApi.createPanel) return
    setBusy(true)
    try {
      const result = await shellApi.createPanel()
      if (result.ok) { void refreshSwitch(); notify.success(t('settings.panel.panelCreated')) }
      else if (!result.cancelled && result.error) notify.error(result.error)
    } catch (error) {
      notify.error(error instanceof Error ? error.message : t('settings.panel.createFailed'))
    } finally {
      setBusy(false)
    }
  }, [busy, refreshSwitch, t])

  /** 录制完成：先探测占用，冲突则不提交；提交后主进程 applyPanelHotkeys 重注册。 */
  const applyHotkey = useCallback(async (next: string) => {
    if (!shellApi.setPanelHotkey) return
    try {
      const result = await shellApi.setPanelHotkey(next)
      if (result.ok) {
        setHotkey(result.hotkey)
        notify.success(t('settings.panel.hotkeyApplied', { key: result.hotkey }))
      } else {
        notify.warn(result.error ?? t('settings.panel.hotkeyRegisterFailed'))
        void refreshSwitch()
      }
    } catch (error) {
      notify.error(error instanceof Error ? error.message : t('settings.panel.hotkeySaveFailed'))
      void refreshSwitch()
    }
  }, [refreshSwitch, t])

  return (
    <div className="appearance-panel-fields">
      <div className="field">
        <div>
          <div className="label">{t('settings.panel.enable')}</div>
          <p className="desc">{t('settings.panel.enableDesc')}</p>
        </div>
        <Switch checked={enabled} onCheckedChange={() => void toggle()} disabled={busy || loading} aria-label={t('settings.panel.enable')} />
      </div>
      {enabled && (
        <>
          <PanelAppearanceFields state={state} panels={panels} />
          <div className="field">
            <div>
              <div className="label">{t('settings.panel.newPanel')}</div>
              <p className="desc">{t('settings.panel.newPanelDesc', { count: String(panels.length) })}</p>
            </div>
            <Button variant="primary" size="sm" onClick={() => void create()} disabled={busy}>
              {t('settings.panel.createPanel')}
            </Button>
          </div>
          <div className="field">
            <div>
              <div className="label">{t('settings.panel.panelHotkey')}</div>
              <p className="desc">{t('settings.panel.panelHotkeyDesc')}</p>
            </div>
            <ShortcutRecorder value={hotkey} label={t('settings.panel.panelHotkey')} onChange={acc => void applyHotkey(acc)} />
          </div>
        </>
      )}
      {!enabled && loading && <p className="desc appearance-inline-status" role="status">{t('settings.panel.readSettings')}</p>}
      {!enabled && error && <p className="desc appearance-inline-status is-error" role="alert">{error} <Button variant="ghost" size="sm" onClick={retry}>{t('settings.panel.retry')}</Button></p>}
    </div>
  )
}

/** 自由面板外观字段（材质 + 底板不透明度 + 面板缩略预览），只渲染字段本身，不含外层卡片。 */
function PanelAppearanceFields({ state, panels }: { state: PanelAppearanceController; panels: Array<{ id: string; bounds: PanelBounds; widgetCount: number }> }) {
  const { t } = useI18n()
  const { draft, loading, error, update, retry } = state
  const transparent = draft.opacity === 0 && draft.material === 'none'

  if (loading) return <p className="desc appearance-inline-status" role="status">{t('settings.panel.readSettings')}</p>

  return (
    <div className="appearance-panel-fields">
      {/* 面板缩略预览：按真实面板的宽高比与组件数绘制，底板浓度/材质跟随上面的控件实时变化。 */}
      <div className="field appearance-field-panel-preview">
        <div>
          <div className="label">{t('settings.panel.preview')}</div>
          <p className="desc">{t('settings.panel.previewDesc')}</p>
        </div>
        <PanelPreview appearance={draft} panels={panels} />
      </div>
      <div className="field">
        <div>
          <div className="label">{t('settings.panel.transparentBase')}</div>
          <p className="desc">{t('settings.panel.transparentBaseDesc')}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => update({ opacity: 0, material: 'none' })} disabled={transparent}>
          {transparent ? t('settings.panel.transparentNow') : t('settings.panel.setTransparent')}
        </Button>
      </div>
      <div className="field">
        <div>
          <div className="label">{t('settings.panel.material')}</div>
          <p className="desc">{t('settings.panel.materialDesc')}</p>
        </div>
        <div className="appearance-seg-row" role="radiogroup" aria-label={t('settings.panel.materialAria')}>
          {PLATFORM_MATERIALS.map(material => (
            <Button
              key={material}
              variant={draft.material === material ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => update({ ...draft, material })}
              aria-pressed={draft.material === material}
            >
              {t(MATERIAL_KEYS[material])}
            </Button>
          ))}
        </div>
      </div>
      <div className="field">
        <div>
          <div className="label">{t('settings.panel.opacity')}</div>
          <p className="desc">{t('settings.panel.opacityDesc', { value: String(Math.round(draft.opacity * 100)) })}</p>
        </div>
        <div className="appearance-opacity-row">
          <Slider
            aria-label={t('settings.panel.opacityAria')}
            value={[Math.round(draft.opacity * 100)]}
            min={0}
            max={100}
            step={1}
            onValueChange={(value) => {
              const percent = Array.isArray(value) ? value[0] : value
              update({ ...draft, opacity: Math.min(1, Math.max(0, percent / 100)) })
            }}
          />
        </div>
      </div>
      {error && <p className="desc appearance-inline-status is-error" role="alert">{error} <Button variant="ghost" size="sm" onClick={retry}>{t('settings.panel.retry')}</Button></p>}
    </div>
  )
}

/** 没有面板时用的示意尺寸：接近默认落位的小组件底板。 */
const PREVIEW_FALLBACK = { width: 720, height: 420, widgetCount: 3 }

/**
 * PanelPreview —— 面板缩略图
 *
 * 按真实面板的宽高比与组件数示意底板观感：底层是模拟桌面（CSS 无法采样真实桌面），
 * 其上叠底板层，浓度 = 设置的 opacity；材质影响底板层的不透明度与模糊，与真实面板
 * 上「毛玻璃/系统材质衰减底板」的观感保持一致。组件只是轮廓块，帮助判断间距与疏密。
 */
function PanelPreview({ appearance, panels }: {
  appearance: PanelAppearance
  panels: Array<{ id: string; bounds: PanelBounds; widgetCount: number }>
}) {
  const { t } = useI18n()
  const source = panels.length
    ? panels.reduce((widest, panel) => panel.bounds.width * panel.bounds.height > widest.bounds.width * widest.bounds.height ? panel : widest)
    : null
  const width = source?.bounds.width ?? PREVIEW_FALLBACK.width
  const height = source?.bounds.height ?? PREVIEW_FALLBACK.height
  const widgetCount = source?.widgetCount ?? PREVIEW_FALLBACK.widgetCount
  // 缩略图里超过 4 个组件就只画 4 个 + "+N"：再密就看不出疏密了。
  const MAX_CELLS = 4
  const shown = Math.min(widgetCount, MAX_CELLS)
  const overflow = Math.max(0, widgetCount - MAX_CELLS)
  const cells = Array.from({ length: shown }, (_, index) => index)
  // 组件按两列除以行数均分可用高度，永远不撑破底板（用 aspect-ratio 会在窄高面板里溢出裁切）。
  const rows = Math.max(1, Math.ceil(shown / 2))

  return (
    <div className="panel-preview" aria-hidden>
      <div
        className="panel-preview-frame"
        style={{ aspectRatio: `${width} / ${height}` }}
        data-material={appearance.material}
      >
        <div className="panel-preview-desktop" />
        <div className="panel-preview-base" style={{ ['--preview-opacity' as never]: String(appearance.opacity) }} />
        {shown === 0
          ? <div className="panel-preview-widgets"><span className="panel-preview-empty">{t('settings.panel.emptyPanel')}</span></div>
          : <div className="panel-preview-widgets" style={{ ['--preview-rows' as never]: String(rows) }}>
              {cells.map(index => (
                <span key={index} className="panel-preview-widget">
                  <i aria-hidden />
                  <b aria-hidden />
                  <b aria-hidden />
                </span>
              ))}
              {overflow > 0 && <span className="panel-preview-more">+{overflow}</span>}
            </div>}
      </div>
      <p className="panel-preview-caption">
        {source ? t('settings.panel.previewCaption', { width: String(width), height: String(height), count: String(widgetCount) }) : t('settings.panel.previewCaptionEmpty')}
      </p>
    </div>
  )
}
