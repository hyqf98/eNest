/**
 * PanelAppearanceFields — 设置 → 外观「主题配置」卡内的自由面板外观分区（eNest 壳通用外观）
 * 职责：调节自由面板的底板不透明度与材质（无 / 毛玻璃 / 系统材质）。
 * 关键约束：
 *  - 这是壳级设置，写入 general.panelAppearance（主题 profile 的字段由主题声明，互不混用）。
 *  - 即时预览：改动先更新本地 draft，300ms 防抖后经 setSettings 提交并以宿主持久化为准；
 *    失败时恢复到宿主的已确认值（与主题参数同一语义）。
 *  - 只渲染字段：外层卡片、分区标题与统一 footer 由 AppearanceSettingsSection 提供。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_PANEL_APPEARANCE, type PanelAppearance, type PanelMaterial } from '@shared/types/panel'
import { shellApi } from '@renderer/services/shellApi'
import { notify } from '@renderer/services/notifyService'
import { Slider } from '@renderer/components/ui/Slider'
import { Button } from '@renderer/components/ui/Button'
import './appearanceSettings.css'

const PLATFORM_MATERIALS: PanelMaterial[] = ['none', 'blur', 'system']

function normalizeAppearance(raw: unknown): PanelAppearance {
  const value = (raw ?? {}) as Partial<PanelAppearance>
  const opacity = typeof value.opacity === 'number' && Number.isFinite(value.opacity)
    ? Math.min(1, Math.max(0.3, value.opacity))
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
  const [confirmed, setConfirmed] = useState<PanelAppearance>(DEFAULT_PANEL_APPEARANCE)
  const [draft, setDraft] = useState<PanelAppearance>(DEFAULT_PANEL_APPEARANCE)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const saves = useRef(Promise.resolve())
  const request = useRef(0)

  const refresh = useCallback(async (revert = false) => {
    const revision = ++request.current
    try {
      const settings = await shellApi.getSettings()
      if (revision !== request.current) return
      const next = normalizeAppearance(settings.general?.panelAppearance)
      setConfirmed(next)
      if (revert) setDraft(next)
    } catch {
      if (revision === request.current) setError('无法读取面板外观设置。')
    } finally {
      if (revision === request.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /**
   * 预览 + 防抖提交：draft 立刻生效在预览方块上，
   * 300ms 无操作后经 setSettings 提交，失败恢复宿主持久值。
   */
  const update = useCallback((next: PanelAppearance) => {
    setDraft(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = undefined
      saves.current = saves.current.catch(() => undefined).then(async () => {
        setSaving(true)
        try {
          await shellApi.setSettings({ general: { panelAppearance: next } })
          setConfirmed(next)
          setError(undefined)
        } catch {
          setError('面板外观未保存，已恢复到已确认的设置。')
          setDraft(confirmed)
        } finally {
          setSaving(false)
        }
      })
    }, 300)
  }, [confirmed])

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const reset = useCallback(() => {
    update(DEFAULT_PANEL_APPEARANCE)
    notify.info('面板外观已恢复默认')
  }, [update])

  const retry = useCallback(() => { void refresh(true) }, [refresh])

  return { draft, loading, saving, error, update, reset, retry }
}

/** 自由面板外观字段（材质 + 底板不透明度），只渲染字段本身，不含外层卡片。 */
export function PanelAppearanceFields({ state }: { state: PanelAppearanceController }) {
  const { draft, loading, error, update, retry } = state

  if (loading) return <p className="desc appearance-inline-status" role="status">正在读取设置…</p>

  return (
    <div className="appearance-panel-fields">
      <div className="field">
        <div>
          <div className="label">材质</div>
          <p className="desc">「无」只保留半透明纯色底板，性能开销最小。</p>
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
          <p className="desc">{Math.round(draft.opacity * 100)}%{draft.material === 'none' ? ' · 值越低越透' : ' · 影响底板色调浓度'}</p>
        </div>
        <div className="appearance-opacity-row">
          <Slider
            aria-label="面板底板不透明度"
            value={[Math.round(draft.opacity * 100)]}
            min={30}
            max={100}
            step={1}
            onValueChange={(value) => {
              const percent = Array.isArray(value) ? value[0] : value
              update({ ...draft, opacity: Math.min(1, Math.max(0.3, percent / 100)) })
            }}
          />
          {/* 实时预览：材质 + 浓度组合的小样（opacity 经 CSS 变量驱动底板层，整体不透明） */}
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
