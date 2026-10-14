import type { PluginInputContext } from '@shared/types/local-files'

export function quickInputAction(
  input: { type: string; key: string; control?: boolean; meta?: boolean; shift?: boolean; alt?: boolean; isComposing?: boolean },
  context: PluginInputContext
): 'search' | 'dismiss' | 'pin' | null {
  if (input.type !== 'keyDown' || input.isComposing || context !== 'workbench') return null
  if (input.shift || input.alt) return null
  const modifier = input.control || input.meta
  if (input.key.toLowerCase() === 'k' && modifier) return 'search'
  if (input.key === 'Escape' && !modifier) return 'dismiss'
  if (input.key === 'Enter' && modifier) return 'pin'
  return null
}
