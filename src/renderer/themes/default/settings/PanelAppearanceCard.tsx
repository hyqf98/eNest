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
import { DEFAULT_PANEL_APPEARANCE, type PanelAppearance, type PanelMaterial } from '@shared/types/panel'
import { IS_MAC } from '@shared/platform'
import { shellApi } from '@renderer/services/shellApi'
import { notify } from '@renderer/services/notifyService'
import { Slider } from '@renderer/components/ui/Slider'
import { Button } from '@renderer/components/ui/Button'
import { Switch } from '@renderer/components/ui/Switch'
import { ShortcutRecorder } from './ShortcutRecorder'
import './appearanceSettings.css'

const PLATFORM_MATERIALS: PanelMaterial[] = ['none', 'blur', 'system']

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

const MATERIAL_LABELS: Record<PanelMaterial, string> = {
  none: '无',
  blur: '毛玻璃',
  system: '系统材质'
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

/** 面板外观的读取 / 防抖提交 / 失败回滚；由外观页统一持有，便于合并保存状态。 */
export function usePanelAppearance(): PanelAppearanceController {
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
      if (mounted.current && revision === request.current) setError('无法读取面板外观设置。')
    } finally {
      if (mounted.current && revision === request.current) setLoading(false)
    }
  }, [])

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
          setError('面板外观未保存，已恢复到已确认的设置。')
          setDraft(confirmed.current)
        }
      } finally {
        if (mounted.current && version.current === change.version) setSaving(false)
      }
    })
    return saves.current
  }, [])

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
  const { loading, error, retry } = state
  const [enabled, setEnabled] = useState(false)
  const [hotkey, setHotkey] = useState('')
  const [panelCount, setPanelCount] = useState(0)
  const [busy, setBusy] = useState(false)

  const refreshSwitch = useCallback(async () => {
    try {
      const settings = await shellApi.getSettings()
      const general = settings.general ?? {}
      setEnabled(general.freePanel?.enabled === true)
      // 主进程未配置时回平台默认；general.panelHotkey 存归一后的 accelerator。
      if (typeof general.panelHotkey === 'string' && general.panelHotkey) setHotkey(general.panelHotkey)
      else setHotkey(IS_MAC ? 'Command+Shift+P' : 'Ctrl+Shift+P')
      const panels = shellApi.listPanels ? await shellApi.listPanels() : []
      setPanelCount(panels.length)
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
      notify.info(next ? '自由面板已开启，可用快捷键或「新建面板」框选区域' : '自由面板已关闭，现有面板内的插件已释放（布局保留）')
    } catch (error) {
      setEnabled(!next)
      notify.error(error instanceof Error ? error.message : '自由面板设置未保存')
    } finally {
      setBusy(false)
    }
  }, [busy, enabled])

  const create = useCallback(async () => {
    if (busy || !shellApi.createPanel) return
    setBusy(true)
    try {
      const result = await shellApi.createPanel()
      if (result.ok) { void refreshSwitch(); notify.success('已创建自由面板，右键可添加组件') }
      else if (!result.cancelled && result.error) notify.error(result.error)
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '创建面板失败')
    } finally {
      setBusy(false)
    }
  }, [busy, refreshSwitch])

  /** 录制完成：先探测占用，冲突则不提交；提交后主进程 applyPanelHotkeys 重注册。 */
  const applyHotkey = useCallback(async (next: string) => {
    if (!shellApi.setPanelHotkey) return
    try {
      const result = await shellApi.setPanelHotkey(next)
      if (result.ok) {
        setHotkey(result.hotkey)
        notify.success(`面板快捷键已生效：${result.hotkey}`)
      } else {
        notify.warn(result.error ?? '快捷键注册失败，已保留原设置')
        void refreshSwitch()
      }
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '快捷键保存失败')
      void refreshSwitch()
    }
  }, [refreshSwitch])

  return (
    <div className="appearance-panel-fields">
      <div className="field">
        <div>
          <div className="label">启用自由面板</div>
          <p className="desc">在屏幕上框选区域，把插件拖进去自由组合成常驻小组件。关闭时释放面板内插件，布局保留到下次开启。</p>
        </div>
        <Switch checked={enabled} onCheckedChange={() => void toggle()} disabled={busy || loading} aria-label="启用自由面板" />
      </div>
      {enabled && (
        <>
          <PanelAppearanceFields state={state} />
          <div className="field">
            <div>
              <div className="label">新建面板</div>
              <p className="desc">当前活动面板：{panelCount} 个；快捷键可呼出全屏框选。</p>
            </div>
            <Button variant="primary" size="sm" onClick={() => void create()} disabled={busy}>
              框选并新建
            </Button>
          </div>
          <div className="field">
            <div>
              <div className="label">面板快捷键</div>
              <p className="desc">呼出框选新建面板的组合键。</p>
            </div>
            <ShortcutRecorder value={hotkey} label="面板快捷键" onChange={acc => void applyHotkey(acc)} />
          </div>
        </>
      )}
      {!enabled && loading && <p className="desc appearance-inline-status" role="status">正在读取设置…</p>}
      {!enabled && error && <p className="desc appearance-inline-status is-error" role="alert">{error} <Button variant="ghost" size="sm" onClick={retry}>重试</Button></p>}
    </div>
  )
}

/** 自由面板外观字段（材质 + 底板不透明度），只渲染字段本身，不含外层卡片。 */
function PanelAppearanceFields({ state }: { state: PanelAppearanceController }) {
  const { draft, loading, error, update, retry } = state
  const transparent = draft.opacity === 0 && draft.material === 'none'

  if (loading) return <p className="desc appearance-inline-status" role="status">正在读取设置…</p>

  return (
    <div className="appearance-panel-fields">
      <div className="field">
        <div>
          <div className="label">透明底板</div>
          <p className="desc">默认只显示组件自身的外观。透明区域仍可拖动和右键，不会点击穿透。</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => update({ opacity: 0, material: 'none' })} disabled={transparent}>
          {transparent ? '已透明' : '设为透明'}
        </Button>
      </div>
      <div className="field">
        <div>
          <div className="label">材质</div>
          <p className="desc">仅作用于整块面板底板，不改动组件自身的背景。「无」关闭原生材质，仍可调整底板浓度。</p>
        </div>
        <div className="appearance-seg-row" role="radiogroup" aria-label="面板材质">
          {PLATFORM_MATERIALS.map(material => (
            <Button
              key={material}
              variant={draft.material === material ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => update({ ...draft, material })}
              aria-pressed={draft.material === material}
            >
              {MATERIAL_LABELS[material]}
            </Button>
          ))}
        </div>
      </div>
      <div className="field">
        <div>
          <div className="label">底板不透明度</div>
          <p className="desc">{Math.round(draft.opacity * 100)}% · 调整底板色调与描边。毛玻璃和系统材质在 0% 时仍保留，可用「设为透明」一并关闭。</p>
        </div>
        <div className="appearance-opacity-row">
          <Slider
            aria-label="面板底板不透明度"
            value={[Math.round(draft.opacity * 100)]}
            min={0}
            max={100}
            step={1}
            onValueChange={(value) => {
              const percent = Array.isArray(value) ? value[0] : value
              update({ ...draft, opacity: Math.min(1, Math.max(0, percent / 100)) })
            }}
          />
          <span
            className={`panel-preview-swatch material-${draft.material}`}
            style={{ ['--preview-opacity' as never]: String(draft.opacity) }}
            aria-hidden
          />
        </div>
      </div>
      {error && <p className="desc appearance-inline-status is-error" role="alert">{error} <Button variant="ghost" size="sm" onClick={retry}>重试</Button></p>}
    </div>
  )
}
