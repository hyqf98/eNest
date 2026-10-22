/** Read the host-resolved animation level; settings are owned by the theme schema. */
import { getAnimLevel } from '@renderer/gsap/marketMotion'
import { useSyncExternalStore } from 'react'
export { useReducedMotion } from './useReducedMotion'

export function useAnimationLevel() {
  const level = useSyncExternalStore(subscribe, readLevel, () => 'medium' as const)
  return { level, getLevel: getAnimLevel }
}

function readLevel(): 'low' | 'medium' | 'high' {
  const value = document.documentElement.dataset.anim
  return value === 'low' || value === 'high' ? value : 'medium'
}

function subscribe(listener: () => void): () => void {
  const observer = new MutationObserver(listener)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-anim'] })
  return () => observer.disconnect()
}
