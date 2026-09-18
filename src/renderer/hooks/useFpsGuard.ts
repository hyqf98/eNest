/**
 * useFpsGuard — 高动画档 FPS 守卫（high 自动降级 medium）
 * 职责：仅当动画档位为 high 时启用 rAF 采样；滑动窗口（逐秒桶 × 5 秒）统计帧率，
 * 连续 5 秒平均 FPS < 45 → 自动降为 medium 并发 info 通知。
 * 防抖：降级后本次「high 会话」内不再重复触发；用户手动改回 high 视为新会话，允许再次降级。
 * 降级路径与 useAnimationLevel.setLevel 完全一致（store set + data-anim + shellApi.setSettings 落盘）。
 * 挂载：AppBackground（壳子常驻组件，quick 小窗不渲染）。依赖 useAnimationLevelStore、notifyService。
 */
import { useEffect } from 'react'
import { useAnimationLevelStore } from '@renderer/hooks/useAnimationLevel'
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

export function useFpsGuard(): void {
  const level = useAnimationLevelStore((s) => s.level)

  useEffect(() => {
    // 仅 high 档启用；medium/low 直接不采样（零开销）
    if (level !== 'high') return

    let raf = 0
    let running = true
    /** 滑动窗口：最近 WINDOW_SECONDS 个 1s 桶 */
    const windowBuckets: FpsBucket[] = []
    let current: FpsBucket | null = null
    let degraded = false

    const degrade = () => {
      if (degraded) return
      degraded = true
      void useAnimationLevelStore.getState().setLevel('medium')
      notify.info(
        '检测到画面帧率偏低，已自动将动画效果从「高」降为「中」；可在 设置 → 动画效果 中改回。',
        { duration: 5200 },
      )
    }

    const sample = (ts: number) => {
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

    // 页面隐藏时暂停采样（rAF 本身会节流，这里显式停掉避免后台回来跳桶）
    const onVisibility = () => {
      if (document.hidden) {
        running = false
        cancelAnimationFrame(raf)
        // 丢弃隐藏期间的桶，避免恢复时误判
        windowBuckets.length = 0
        current = null
      } else if (!running) {
        running = true
        raf = requestAnimationFrame(sample)
      }
    }

    raf = requestAnimationFrame(sample)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      running = false
      degraded = false
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVisibility)
    }
    // 依赖 level：降级为 medium 后本 effect 重启，条件不满足即零开销；
    // 用户手动改回 high 时重新进入（fresh degraded 标记），允许再次降级
  }, [level])
}
