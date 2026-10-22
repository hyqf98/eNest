import { useSyncExternalStore } from 'react'

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia('(prefers-reduced-motion: reduce)')
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/** Read-only OS preference, safe to reuse inside an isolated theme workspace. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe,
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    () => false)
}
