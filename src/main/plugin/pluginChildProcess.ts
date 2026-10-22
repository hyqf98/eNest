import type { ChildProcess } from 'node:child_process'
import { getRuntimeScope } from './PluginRuntimeScope'
import { registerPluginProcess } from './pluginOwnedProcesses'
import type { PluginProcessKind } from '@shared/types/pluginMemory'

/** Attach host-created one-shot commands to their runtime, including close-before-spawn. */
export function ownPluginChild(pluginId: string, child: ChildProcess, kind: Exclude<PluginProcessKind, 'renderer'>): void {
  const scope = getRuntimeScope(pluginId)
  let exited = false
  let stopping = false
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let resolveExit!: () => void
  const exit = new Promise<void>(resolve => { resolveExit = resolve })
  const stop = () => {
    stopping = true
    if (exited || child.exitCode !== null || child.signalCode !== null) return
    try { child.kill('SIGTERM') } catch { /* retry after spawn */ }
    if (!child.pid || killTimer) return
    killTimer = setTimeout(() => {
      if (!exited && child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL') } catch { /* exit owns cleanup */ }
      }
    }, 250)
    killTimer.unref()
  }
  const shutdown = async () => {
    stop()
    if (exited) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([exit, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('plugin child exit not confirmed')), 1200) })])
    } finally { if (timer) clearTimeout(timer) }
  }
  const unregister = registerPluginProcess({ pluginId, generation: scope?.owner.generation, kind,
    getPid: () => exited ? undefined : child.pid, stop: shutdown })
  let detach = () => {}
  const finished = () => {
    if (exited) return
    exited = true
    if (killTimer) clearTimeout(killTimer)
    scope?.signal.removeEventListener('abort', stop)
    detach(); unregister(); resolveExit()
  }
  child.once('exit', finished)
  child.once('error', () => { if (child.pid === undefined) finished(); else stop() })
  child.once('spawn', () => { if (stopping || scope?.signal.aborted) stop() })
  scope?.signal.addEventListener('abort', stop, { once: true })
  detach = scope?.addDisposer(shutdown) ?? detach
  if (!scope?.isCurrent() || scope.signal.aborted) stop()
}
