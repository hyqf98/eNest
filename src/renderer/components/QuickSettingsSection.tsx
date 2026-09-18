/**
 * QuickSettingsSection — 设置 → 快捷启动
 * 启用开关 + 三张触发键卡片；点击哪张，就只注册哪一枚（互斥）。
 */
import { useCallback, useEffect, useState } from 'react'
import { shellApi } from '@renderer/services/shellApi'
import { toastStore } from '@renderer/hooks/useToast'
import { HotkeyPresetCards } from './HotkeyPresetCards'

export function QuickSettingsSection() {
  const [enabled, setEnabled] = useState(true)
  const [hotkeys, setHotkeys] = useState<string[]>(['Alt+Space', 'Control+Space'])
  const [activeHotkey, setActiveHotkey] = useState('Alt+Space')
  const [platform, setPlatform] = useState('darwin')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        if (!shellApi.quickGetConfig) return
        const cfg = await shellApi.quickGetConfig()
        if (cancelled) return
        setEnabled(cfg.enabled)
        const filled = [...(cfg.hotkeys ?? [])]
        if (!filled.includes('Alt+Space')) filled.unshift('Alt+Space')
        if (!filled.includes('Control+Space')) filled.push('Control+Space')
        setHotkeys(filled)
        const active =
          cfg.activeHotkey && filled.includes(cfg.activeHotkey)
            ? cfg.activeHotkey
            : (filled.find((h) => !!h) ?? '')
        setActiveHotkey(active)
        setPlatform(cfg.platform)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const applyHotkeys = useCallback(
    async (nextEnabled: boolean, nextHotkeys: string[], nextActive: string) => {
      if (!shellApi.quickSetHotkeys) return
      setEnabled(nextEnabled)
      setHotkeys(nextHotkeys)
      setActiveHotkey(nextActive)
      const result = await shellApi.quickSetHotkeys({
        enabled: nextEnabled,
        hotkeys: nextHotkeys,
        activeHotkey: nextActive
      })
      if (result.failed.length > 0 && result.registered.length === 0) {
        toastStore.getState().push(`快捷键注册失败：${result.failed.join('、')}`, 'error')
      } else if (result.failed.length > 0) {
        toastStore
          .getState()
          .push(`已切换；若无效可能是被占用：${result.failed.join('、')}`, 'warn')
      } else {
        toastStore
          .getState()
          .push(`已生效：${result.activeHotkey || nextActive}`, 'success')
      }
      setHotkeys(result.hotkeys)
      setEnabled(result.enabled)
      if (result.activeHotkey) setActiveHotkey(result.activeHotkey)
    },
    []
  )

  return (
    <div className="s-card">
      <h2>快捷启动</h2>
      <p className="hint">
        全局呼出命令面板，搜索本地应用与插件指令。点击卡片设为当前生效快捷键（仅注册选中的这一枚）。
      </p>

      <div className="field">
        <div>
          <div className="label">启用全局快捷键</div>
          <p className="desc">关闭后仍可通过托盘或后续入口打开小窗</p>
        </div>
        <button
          type="button"
          className={`switch${enabled ? ' on' : ''}`}
          aria-pressed={enabled}
          onClick={() => void applyHotkeys(!enabled, hotkeys, activeHotkey)}
        />
      </div>

      <div className="quick-hotkey-block">
        <div className="quick-hotkey-head">
          <div className="label">触发快捷键</div>
          <p className="desc">点选哪一张，就只有那一枚生效。支持 Ctrl / Alt / Shift / ⌘。</p>
        </div>
        {loading ? (
          <div className="hotkey-cards">
            {[0, 1, 2].map((i) => (
              <div key={i} className="hotkey-card empty loading" />
            ))}
          </div>
        ) : (
          <HotkeyPresetCards
            hotkeys={hotkeys}
            platform={platform}
            activeHotkey={activeHotkey}
            onChange={(next, nextActive) => void applyHotkeys(enabled, next, nextActive)}
          />
        )}
      </div>
    </div>
  )
}
