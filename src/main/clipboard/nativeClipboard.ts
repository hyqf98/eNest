/** Only this module talks to the bundled fixed-operation platform helper. */
import { app, ClipboardItem, clipboard } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { ClipboardCapabilities, ClipboardSourceApp } from '@shared/types/plugin-tools'
import { parseFileUris, formatFileUris } from '@main/clipboard/clipboardFormats'

let helper: ChildProcessWithoutNullStreams | null = null, sequence = 0, failedUntil = 0
const pending = new Map<number, { child: ChildProcessWithoutNullStreams; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
let target: { token: string; name: string; capturedAt: number } | null = null
let captureRevision = 0
let permissionRequest: Promise<ClipboardCapabilities> | null = null
export function isNativeClipboardBusy(): boolean { return permissionRequest !== null }
type RestoreQuick = () => void | Promise<void>
export interface PasteOwner { isCurrent(): boolean; beforePaste(): void | RestoreQuick }
let beforePaste: (() => void | RestoreQuick) | undefined
export function bindBeforePaste(callback: () => void | RestoreQuick): void { beforePaste = callback }
function rejectPending(error: Error, child?: ChildProcessWithoutNullStreams): void {
  for (const request of [...pending.values()]) if (!child || request.child === child) request.reject(error)
}
function connect(): ChildProcessWithoutNullStreams {
  if (helper && !helper.killed) return helper
  if (Date.now() < failedUntil) throw new Error('系统剪贴板辅助程序不可用')
  const dir = app.isPackaged ? join(process.resourcesPath, 'native') : join(app.getAppPath(), 'native/bin')
  const file = join(dir, process.platform === 'win32' ? 'clipboard-helper.ps1' : 'clipboard-helper')
  if (!existsSync(file)) { failedUntil = Date.now() + 30000; throw new Error('系统剪贴板辅助程序未构建') }
  helper = process.platform === 'win32'
    ? spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, stdio: 'pipe' })
    : spawn(file, [], { stdio: 'pipe' })
  const child = helper
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    if (line.length > 2 * 1024 * 1024) return
    try {
      const message = JSON.parse(line), request = pending.get(message.id)
      if (!request || request.child !== child) return
      pending.delete(message.id); clearTimeout(request.timer)
      if (message.error) request.reject(new Error(String(message.error)))
      else request.resolve(message.result)
    } catch { /* invalid output is not executable */ }
  })
  child.stderr.resume()
  const close = () => {
    if (helper === child) { helper = null; failedUntil = Date.now() + 5000 }
    rejectPending(new Error('系统剪贴板辅助程序已退出'), child); lines.close()
  }
  child.on('error', close); child.on('exit', close)
  return child
}
async function request<T>(command: string, values: Record<string, unknown> = {}, timeout = 3000, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  const child = connect(), id = ++sequence
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return
      settled = true; pending.delete(id); clearTimeout(timer); signal?.removeEventListener('abort', cancel)
      if (error) reject(error); else resolve(value as T)
    }
    const cancel = () => { child.kill(); finish(new Error('插件操作已取消')) }
    const timer = setTimeout(() => { child.kill(); finish(new Error('系统接口响应超时')) }, timeout)
    pending.set(id, { child, resolve: value => finish(undefined, value), reject: error => finish(error), timer })
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) { cancel(); return }
    child.stdin.write(JSON.stringify({ id, command, ...values }) + '\n', error => { if (error) finish(error) })
  })
}
export async function nativeCapabilities(): Promise<ClipboardCapabilities> {
  if (permissionRequest) return permissionRequest
  try { return await request<ClipboardCapabilities>('capabilities') }
  catch (error) { return { files: process.platform === 'linux', sourceApp: false, paste: false, permissionRequired: false, reason: (error as Error).message } }
}
export function requestNativePermission(): Promise<ClipboardCapabilities> {
  if (!permissionRequest) permissionRequest = request<ClipboardCapabilities>('requestPermission', {}, 15000).finally(() => { permissionRequest = null })
  return permissionRequest
}
export async function capturePasteTarget(): Promise<void> {
  const revision = ++captureRevision
  target = null
  if (permissionRequest) return
  try { const value = await request<{ token: string; name: string } | null>('target', {}, 900); if (revision === captureRevision && value?.token && !/^(enest|electron)$/i.test(value.name)) target = { ...value, capturedAt: Date.now() } } catch { /* copying remains available */ }
}
export async function pasteToOriginal(signal?: AbortSignal, owner?: PasteOwner): Promise<{ pasted: boolean; reason?: string }> {
  signal?.throwIfAborted()
  if (owner && !owner.isCurrent()) return { pasted: false, reason: '插件入口已变化，已取消回贴' }
  const captured = target
  if (!captured || Date.now() - captured.capturedAt > 30 * 60000) return { pasted: false, reason: '未找到呼出前的应用，请手动粘贴' }
  const capability = await nativeCapabilities()
  if (!capability.paste) return { pasted: false, reason: capability.reason || (capability.permissionRequired ? '需要在系统设置中允许辅助功能' : '当前桌面不支持安全回贴') }
  signal?.throwIfAborted()
  if (owner && !owner.isCurrent()) return { pasted: false, reason: '插件入口已变化，已取消回贴' }
  if (target !== captured) return { pasted: false, reason: '回贴目标已变化，请手动粘贴' }
  const token = captured.token, restore = owner ? owner.beforePaste() : beforePaste?.()
  signal?.throwIfAborted()
  if (owner && !owner.isCurrent()) return { pasted: false, reason: '插件入口已变化，已取消回贴' }
  let result: { pasted: boolean; reason?: string }
  try { result = await request('paste', { target: token }, 3000, signal) }
  catch (error) { result = { pasted: false, reason: (error as Error).message } }
  if (!signal?.aborted && (!owner || owner.isCurrent()) && !result.pasted && restore) await Promise.resolve(restore()).catch(() => {})
  return result
}
export async function nativeClipboardSource(): Promise<ClipboardSourceApp | null> {
  if (permissionRequest) return null
  try { return await request('source') } catch { return null }
}
export async function readNativeFiles(): Promise<string[]> {
  if (permissionRequest) return []
  if (process.platform !== 'linux') { try { return await request<string[]>('readFiles') } catch { return [] } }
  try {
    for (const item of await clipboard.read()) {
      for (const type of item.types) if (type === 'text/uri-list' || type === 'x-special/gnome-copied-files') {
        const value = await item.getType(type)
        if (value instanceof Blob) return parseFileUris(await value.text())
      }
    }
  } catch { /* desktop clipboard access is capability-dependent */ }
  try { return await request<string[]>('readFiles') } catch { return [] }
}
export async function writeNativeFiles(paths: string[], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (!paths.length) throw new Error('没有可复制的文件')
  if (permissionRequest) await permissionRequest
  signal?.throwIfAborted()
  if (process.platform !== 'linux') { if (!(await request<boolean>('writeFiles', { paths }, 3000, signal))) throw new Error('系统拒绝复制文件'); return }
  const content = formatFileUris(paths)
  try { await clipboard.write([new ClipboardItem({ 'text/uri-list': new Blob([content], { type: 'text/uri-list' }) })]) }
  catch { signal?.throwIfAborted(); if (!(await request<boolean>('writeFiles', { paths }, 3000, signal))) throw new Error('系统拒绝复制文件') }
}
export function disposeNativeClipboard(): void { captureRevision++; helper?.kill(); helper = null; target = null; rejectPending(new Error('应用正在退出')) }
