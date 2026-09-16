/**
 * useAnimationLevel — 动画效果强度（low / medium / high）
 * 独立 zustand store：hydrate 启动时从 shellApi 拉取；
 * setLevel 写入设置、同步 root[data-anim] 与 GSAP 默认值，即时生效。
 * 依赖：shellApi、marketMotion.applyLevelToDefaults。
 */
import { create } from 'zustand'
import type { AnimationLevel } from '@shared/types/plugin'
import { shellApi } from '@renderer/services/shellApi'
import { applyLevelToDefaults, getAnimLevel } from '@renderer/gsap/marketMotion'

function isLevel(v: unknown): v is AnimationLevel {
  return v === 'low' || v === 'medium' || v === 'high'
}

/** 将 level 应用到 DOM + GSAP */
function applyToDom(level: AnimationLevel): void {
  document.documentElement.dataset.anim = level
  applyLevelToDefaults(level)
}

interface AnimationLevelState {
  level: AnimationLevel
  hydrated: boolean
  hydrate: () => Promise<void>
  setLevel: (level: AnimationLevel) => Promise<void>
}

export const useAnimationLevelStore = create<AnimationLevelState>((set, get) => ({
  level: 'medium',
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return
    try {
      const settings = await shellApi.getSettings()
      const raw = settings.general?.animationLevel
      const level: AnimationLevel = isLevel(raw) ? raw : 'medium'
      applyToDom(level)
      set({ level, hydrated: true })
    } catch {
      applyToDom('medium')
      set({ level: 'medium', hydrated: true })
    }
  },

  setLevel: async (level) => {
    set({ level })
    applyToDom(level)
    try {
      await shellApi.setSettings({ general: { animationLevel: level } })
    } catch {
      /* 忽略写入失败，UI 已乐观更新 */
    }
  },
}))

/** 便捷 hook：读写当前动画强度 */
export function useAnimationLevel() {
  const level = useAnimationLevelStore((s) => s.level)
  const setLevel = useAnimationLevelStore((s) => s.setLevel)
  const hydrate = useAnimationLevelStore((s) => s.hydrate)
  return { level, setLevel, hydrate, getLevel: getAnimLevel }
}
