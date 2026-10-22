/**
 * useFpsGuard — 高动画档 FPS 守卫（仅降低本次运行的有效强度）
 * 职责：仅 high 档、允许动态效果且窗口可见并聚焦时启用 rAF 采样；滑动窗口（逐秒桶 × 5 秒）统计帧率，
 * 连续 5 秒平均 FPS < 45 → 请求宿主运行时性能限制，不改写用户保存的动画强度。
 * 隐藏、失焦和减少动态效果时停止采样；退出时释放监听器。
 */
import { useEffect } from 'react'
import { useReducedMotion } from '@renderer/hooks/useAnimationLevel'
import { useAppearanceStore } from '@renderer/hooks/useAppearance'
import { shellApi } from '@renderer/services/shellApi'
import { notify } from '@renderer/services/notifyService'

/** 触发降级的平均 FPS 阈值 */
const FPS_THRESHOLD = 45
/** 滑动窗口长度（秒）：窗口填满（≥5 个整秒桶）前不判定，避免冷启动抖动误降级 */
const WINDOW_SECONDS = 5

interface FpsBucket {
  /** 桶起始时间戳（ms） */
  start: number
  /** 桶内帧数 */
  frames: number
}

export function useFpsGuard(enabled = true): void {
  const level = useAppearanceStore((s) => s.appearance.animation.effective)
  const reducedMotion = useReducedMotion()

  useEffect(() => {
    // 静态/低中档与减少动态效果均不采样。
    if (level !== 'high' || !enabled || reducedMotion) return

    let raf = 0
    let running = false
    let focused = document.hasFocus()
    /** 滑动窗口：最近 WINDOW_SECONDS 个 1s 桶 */
    const windowBuckets: FpsBucket[] = []
    let current: FpsBucket | null = null
    let degraded = false
    let disposed = false

    const degrade = () => {
      if (degraded) return
      degraded = true
      running = false
      if (!shellApi.setAppearancePerformanceLimited) return
      void shellApi.setAppearancePerformanceLimited(true).then(snapshot => {
        if (disposed) return
        useAppearanceStore.getState().applySnapshot(snapshot)
        notify.info('检测到画面帧率偏低，已暂时减少动态效果；你保存的动画强度未改变。', { duration: 5200 })
      }).catch(() => undefined)
    }

    const sample = (ts: number) => {
      raf = 0
      if (!running) return

      // 逐秒分桶
      if (!current || ts - current.start >= 1000) {
        if (current) {
          windowBuckets.push(current)
          // 保持滑动窗口长度
          while (windowBuckets.length > WINDOW_SECONDS) windowBuckets.shift()
        }
        current = { start: ts, frames: 0 }
      }
      current.frames += 1

      // 窗口填满后逐秒判定：5 桶总帧数 / 5 秒 = 平均 FPS
      if (windowBuckets.length === WINDOW_SECONDS && current.frames > 0) {
        const total = windowBuckets.reduce((sum, b) => sum + b.frames, 0) + current.frames
        const elapsed =
          (current.start + Math.min(1000, ts - current.start) - windowBuckets[0].start) / 1000
        const avgFps = total / Math.max(0.5, elapsed)
        if (avgFps < FPS_THRESHOLD) {
          degrade()
          return
        }
      }

      raf = requestAnimationFrame(sample)
    }

    // Hidden or unfocused windows must not sample, nor count idle time as slow frames.
    const syncActivity = () => {
      if (document.hidden || !focused || degraded) {
        running = false
        if (raf) cancelAnimationFrame(raf)
        raf = 0
        windowBuckets.length = 0
        current = null
      } else if (!running) {
        running = true
        raf = requestAnimationFrame(sample)
      }
    }
    const onFocus = () => { focused = true; syncActivity() }
    const onBlur = () => { focused = false; syncActivity() }

    document.addEventListener('visibilitychange', syncActivity)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    syncActivity()

    return () => {
      disposed = true
      running = false
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      document.removeEventListener('visibilitychange', syncActivity)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
    // Effective low releases the sampler; persisted requested intensity is untouched.
  }, [level, enabled, reducedMotion])
}
