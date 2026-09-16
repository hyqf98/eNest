/**
 * QuickSettingsSection — 设置 → 快捷启动
 * 启用开关、热键录制列表、本地应用重新扫描。
 */
import { useCallback, useEffect, useState } from 'react'
import { shellApi } from '../services/shellApi'
import { toastStore } from '../hooks/useToast'
import { HotkeyRecorder } from './HotkeyRecorder'

export function QuickSettingsSection() {
  const [enabled, setEnabled] = useState(true)
  const [hotkeys, setHotkeys] = useState<string[]>(['Alt+Space'])
  const [platform, setPlatform] = useState('darwin')
  const [appCount, setAppCount] = useState<number | null>(null)
  const [scanning, setScanning] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        if (shellApi.quickGetConfig) {
          const cfg = await shellApi.quickGetConfig()
          if (cancelled) return
          setEnabled(cfg.enabled)
          setHotkeys(cfg.hotkeys)
          setPlatform(cfg.platform)
        }
        if (shellApi.quickScanApps) {
          const apps = await shellApi.quickScanApps(false)
          if (!cancelled) setAppCount(apps.apps.length)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const applyHotkeys = useCallback(async (nextEnabled: boolean, nextHotkeys: string[]) => {
    if (!shellApi.quickSetHotkeys) return
    setEnabled(nextEnabled)
    setHotkeys(nextHotkeys)
    const result = await shellApi.quickSetHotkeys({ enabled: nextEnabled, hotkeys: nextHotkeys })
    if (result.failed.length > 0) {
      toastStore
        .getState()
        .push(
          result.registered.length > 0
            ? `部分快捷键占用：${result.failed.join('、')}`
            : `快捷键全部占用：${result.failed.join('、')}`,
          result.registered.length > 0 ? 'warn' : 'error'
        )
    } else {
      toastStore.getState().push('快捷键已更新', 'success')
    }
    setHotkeys(result.hotkeys)
    setEnabled(result.enabled)
  }, [])

  const handleRescan = useCallback(() => {
    if (!shellApi.quickScanApps) return
    setScanning(true)
    void shellApi
      .quickScanApps(true)
      .then((r) => {
        setAppCount(r.apps.length)
        toastStore
          .getState()
          .push(r.complete ? `已扫描 ${r.apps.length} 个应用` : `扫描部分完成：${r.apps.length}`)
      })
      .finally(() => setScanning(false))
  }, [])

  return (
    <div className="s-card">
      <h2>快捷启动</h2>
      <p className="hint">全局呼出命令面板，搜索本地应用与插件指令。macOS 默认 Option+Space。</p>

      <div className="field">
        <div>
          <div className="label">启用全局快捷键</div>
          <p className="desc">关闭后仍可通过托盘或后续入口打开小窗</p>
        </div>
        <button
          type="button"
          className={`switch${enabled ? ' on' : ''}`}
          aria-pressed={enabled}
          onClick={() => void applyHotkeys(!enabled, hotkeys)}
        />
      </div>

      <div className="field">
        <div>
          <div className="label">触发快捷键</div>
          <p className="desc">可录制多个；任一生效。被系统或其他软件占用时会提示。</p>
        </div>
        {loading ? (
          <span>加载中…</span>
        ) : (
          <HotkeyRecorder
            value={hotkeys}
            platform={platform}
            onChange={(next) => void applyHotkeys(enabled, next)}
          />
        )}
      </div>

      <div className="field">
        <div>
          <div className="label">本地应用</div>
          <p className="desc">
            {appCount === null ? '尚未扫描' : `已索引 ${appCount} 个应用`}
          </p>
        </div>
        <button type="button" className="btn btn-ghost" onClick={handleRescan} disabled={scanning}>
          {scanning ? '扫描中…' : '重新扫描'}
        </button>
      </div>
    </div>
  )
}
