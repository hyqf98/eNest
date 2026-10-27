/**
 * PanelAppearanceCard — 设置 → 外观 里的面板材质卡（eNest 壳通用外观）
 * 职责：调节自由面板的底板不透明度与材质（无 / 毛玻璃 / 系统材质）。
 * 关键约束：
 *  - 这是壳级设置，写入 general.panelAppearance（主题 profile 的字段由主题声明，互不混用）。
 *  - 即时预览：改动先发 preview（本地 DOM），确认后经 setSettings 提交并以宿主持久化为准；
 *    失败时恢复到宿主的已确认值（与主题参数卡同一语义）。
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

export function PanelAppearanceCard() {
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
  const queue = useCallback((next: PanelAppearance) => {
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

  return (
    <section className="s-card appearance-settings appearance-card" aria-label="面板外观">
      <div className="appearance-card-head">
        <div className="appearance-card-head-copy">
          <h2>自由面板外观</h2>
          <p className="hint">所有面板共用的底板材质与不透明度；材质由系统提供（毛玻璃 = 桌面级模糊，系统材质 = 更重的浮窗质感）。</p>
        </div>
      </div>
      {loading ? (
        <p className="desc appearance-inline-status" role="status">正在读取设置…</p>
      ) : (
        <>
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
                  onClick={() => queue({ ...draft, material })}
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
                  queue({ ...draft, opacity: Math.min(1, Math.max(0.3, percent / 100)) })
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
          {error && <p className="desc appearance-inline-status is-error" role="alert">{error} <Button variant="ghost" size="sm" onClick={() => void refresh(true)}>重试</Button></p>}
          <div className="appearance-unified-footer">
            <span className="appearance-save-status" role="status" aria-live="polite">{error || (saving ? '正在保存…' : '调整即时生效，保存后同步所有已开面板。')}</span>
            <Button variant="ghost" size="sm" onClick={() => {
              queue(DEFAULT_PANEL_APPEARANCE)
              notify.info('面板外观已恢复默认')
            }}>恢复默认</Button>
          </div>
        </>
      )}
    </section>
  )
}
