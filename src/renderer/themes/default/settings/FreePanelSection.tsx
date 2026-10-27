/**
 * FreePanelSection — 设置 → 通用里的自由面板开关
 * 职责：功能开关（写入 general.freePanel.enabled）、「新建面板」入口、快捷键提示、当前面板数量。
 * 模块隔离：只经 shellApi 读写 general 设置与面板通道，不触碰主进程内部状态。
 * 开关行为由主进程 syncFreePanelSetting 决定：开启恢复布局、关闭释放面板内插件（保留布局）。
 */
import { useCallback, useEffect, useState } from 'react'
import { shellApi } from '@renderer/services/shellApi'
import { notify } from '@renderer/services/notifyService'
import { Switch } from '@renderer/components/ui/Switch'
import { Button } from '@renderer/components/ui/Button'
import { ShortcutRecorder } from './ShortcutRecorder'

export function FreePanelSection() {
  const [enabled, setEnabled] = useState(false)
  const [hotkey, setHotkey] = useState('')
  const [panelCount, setPanelCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const settings = await shellApi.getSettings()
      const general = settings.general ?? {}
      setEnabled(general.freePanel?.enabled === true)
      // 主进程未配置时回 platform 默认；general.panelHotkey 存归一后的 accelerator。
      if (typeof general.panelHotkey === 'string' && general.panelHotkey) setHotkey(general.panelHotkey)
      else setHotkey(window.navigator.platform.toLowerCase().includes('mac') ? 'Command+Shift+P' : 'Ctrl+Shift+P')
      const panels = shellApi.listPanels ? await shellApi.listPanels() : []
      setPanelCount(panels.length)
    } catch {
      /* 读取失败保持当前值 */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    // 面板增删 / 设置变更后刷新数量与开关。
    const off = shellApi.onEvent?.(payload => {
      if (payload.type === 'panels-changed' || (payload.type === 'settings-changed' && payload.generalKeys.some(key => key === 'freePanel' || key === 'panelHotkey'))) {
        void refresh()
      }
    })
    return () => off?.()
  }, [refresh])

  const toggle = useCallback(async () => {
    if (busy) return
    setBusy(true)
    const next = !enabled
    setEnabled(next)
    try {
      await shellApi.setSettings({ general: { freePanel: { enabled: next } } })
      notify.info(next ? '自由面板已开启，可用快捷键或「新建面板」框选区域' : '自由面板已关闭，现有面板内的插件已释放（布局保留）')
    } catch {
      setEnabled(!next)
    } finally {
      setBusy(false)
    }
  }, [busy, enabled])

  const create = useCallback(async () => {
    if (busy || !shellApi.createPanel) return
    setBusy(true)
    try {
      const result = await shellApi.createPanel()
      if (result.ok) { setPanelCount(count => count + 1); notify.success('已创建自由面板，右键可添加组件') }
      else if (!result.cancelled && result.error) notify.error(result.error)
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '创建面板失败')
    } finally {
      setBusy(false)
    }
  }, [busy])

  /** 录制完成：先探测占用（复用壳级 probe），冲突则不提交；提交后主进程 applyPanelHotkeys 重注册。 */
  const applyHotkey = useCallback(async (next: string) => {
    if (!shellApi.setPanelHotkey) return
    try {
      // 主进程归一 + 占用检测 + 重注册，返回真实结果；设置页只展示宿主确认后的键。
      const result = await shellApi.setPanelHotkey(next)
      if (result.ok) {
        setHotkey(result.hotkey)
        notify.success(`面板快捷键已生效：${result.hotkey}`)
      } else {
        notify.warn(result.error ?? '快捷键注册失败，已保留原设置')
        void refresh()
      }
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '快捷键保存失败')
      void refresh()
    }
  }, [refresh])

  return (
    <section className="s-card" aria-label="自由面板">
      <h2>自由面板</h2>
      {loading ? (
        <p className="desc" role="status">正在读取设置…</p>
      ) : (
        <>
          <div className="field">
            <div>
              <div className="label">启用自由面板</div>
              <p className="desc">在屏幕上框选区域，把插件拖进去自由组合成常驻小组件。关闭时释放面板内插件，布局保留到下次开启。</p>
            </div>
            <Switch checked={enabled} onCheckedChange={() => void toggle()} disabled={busy} aria-label="启用自由面板" />
          </div>
          {enabled && (
            <>
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
        </>
      )}
    </section>
  )
}
