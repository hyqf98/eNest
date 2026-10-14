/** Isolated middleware (mw.*) entry point. No BrowserWindow, vault or shell imports. */
import * as service from '@main/middleware/mwService'

const port = process.parentPort
if (!port) throw new Error('middleware service requires an Electron utility parent')
const methods: Record<string, (...args: never[]) => unknown> = {
  mwWorkbenchService: service.mwWorkbenchService,
  mwTest: service.mwTest, mwOpen: service.mwOpen, mwClose: service.mwClose,
  mwListSessions: service.mwListSessions, releaseMwSessions: service.releaseMwSessions
}
port.on('message', async ({ data }) => {
  // 事件推送：mwService 内 ctx.emit 发出的 mw.data / mw.error 不匹配 pending id，直接透传主进程
  if (data && typeof data === 'object' && typeof (data as { event?: unknown }).event === 'string') {
    port.postMessage(data)
    return
  }
  const { id, pluginId, method, args = [], proxy } = data ?? {}
  if (!Number.isInteger(id) || typeof pluginId !== 'string' || !Object.hasOwn(methods, method)) return
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    if (typeof proxy?.[key] === 'string') process.env[key] = proxy[key]
    else delete process.env[key]
  }
  try {
    const result = await methods[method]!(pluginId as never, ...args as never[])
    // Ensure a result cannot allocate an unbounded IPC message in the main process.
    const bytes = Buffer.byteLength(JSON.stringify(result, (_, value) => typeof value === 'bigint' ? value.toString() : value) ?? '')
    if (bytes > 8 * 1024 * 1024) throw new Error('middleware result exceeds 8 MiB; narrow the query')
    port.postMessage({ id, ok: true, data: result })
  } catch (error) {
    port.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})
