import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { PluginRuntimeScope } from './PluginRuntimeScope'
import { PluginBackendFiles } from './pluginBackendFiles'
import { PLUGIN_PERMISSIONS, type PluginPermission } from '@shared/types/plugin'
import type { LocalFilePickOptions } from '@shared/types/local-files'

const methods = new Set(['secret.resolve', 'permission.authorize', 'dialog.confirm', 'files.resolve', 'files.directoryTarget',
  'files.pick', 'files.save', 'files.exportDirectory', 'files.export', 'files.open', 'files.read', 'files.close', 'storage.get', 'storage.set', 'log.write'])
const text = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw new Error('Invalid backend capability argument')
  return value
}
const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/** Native host primitives only; protocols, business adapters and operation policy live in plugins. */
export class PluginBackendCapabilities {
  private abort = new AbortController()
  private exports = new Map<string, ReturnType<typeof setTimeout>>()
  private exportOpenings = 0
  private pending = new Set<Promise<unknown>>()
  private files: PluginBackendFiles

  constructor(private scope: PluginRuntimeScope, private assertCurrent: () => void) {
    this.files = new PluginBackendFiles(async handleId => {
      const { resolveLocalFileHandle } = await import('./localFiles')
      this.assertCurrent()
      return resolveLocalFileHandle(this.scope.owner.pluginId, handleId, 'read')
    }, assertCurrent)
  }

  supports(method: unknown): method is string { return typeof method === 'string' && methods.has(method) }
  beginClose(): void { this.abort.abort(new Error('Plugin backend is closing')) }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'files.close') return this.files.close(params.token)
    this.assertCurrent()
    const request = this.dispatch(method, params)
    if (method === 'files.exportDirectory') this.pending.add(request)
    try { const value = await request; this.assertCurrent(); return value }
    finally { this.pending.delete(request) }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.scope.owner.pluginId
    if (method === 'files.open') return this.files.open(params.handleId)
    if (method === 'files.read') return this.files.read(params)
    if (method === 'secret.resolve') {
      const { resolveSecret } = await import('@main/vault/secretVault')
      this.assertCurrent()
      return resolveSecret(id, text(params.ref, 512))
    }
    if (method === 'permission.authorize') {
      if (!(PLUGIN_PERMISSIONS as readonly unknown[]).includes(params.permission)) throw new Error('Unknown backend permission')
      const { authorizePluginPermission } = await import('./PluginPermissions')
      this.assertCurrent()
      await authorizePluginPermission(id, params.permission as PluginPermission, text(params.summary, 512), this.abort.signal)
      return true
    }
    if (method === 'dialog.confirm') {
      const title = text(params.title, 160), message = text(params.message, 512)
      const detail = params.detail === undefined || params.detail === '' ? '' : text(params.detail, 1000)
      const { confirmPluginOperation } = await import('./PluginPermissions')
      this.assertCurrent()
      try { await confirmPluginOperation(id, message, detail, { title, signal: this.abort.signal, requireVisible: true }); return true }
      catch (error) { if ((error as Error).message === 'operation cancelled') return false; throw error }
    }
    if (method === 'storage.get' || method === 'storage.set') {
      const storage = await import('@main/db/pluginStorage')
      this.assertCurrent()
      const key = text(params.key, 1024)
      if (method === 'storage.get') return storage.getPluginStorageValue(id, key)
      storage.setPluginStorageValue(id, key, params.value)
      return true
    }
    if (method === 'log.write') {
      const { logInfo, logWarn } = await import('@main/logs/logService')
      this.assertCurrent()
      if (!['info', 'warn'].includes(String(params.level))) throw new Error('Invalid backend log level')
      ;(params.level === 'info' ? logInfo : logWarn)(`plugin:${id}:${text(params.source, 64)}`, text(params.message, 16384))
      return true
    }
    if (method === 'files.exportDirectory') {
      if (this.exports.size + this.exportOpenings >= 32) throw new Error('Backend export directory limit reached')
      this.exportOpenings++
      let directory: string | undefined
      try {
        directory = await mkdtemp(join(tmpdir(), 'enest-backend-export-'))
        const canonical = await realpath(directory)
        this.assertCurrent()
        const timer = setTimeout(() => {
          void rm(canonical, { recursive: true, force: true }).then(() => this.exports.delete(canonical)).catch(() => {
            // Retain ownership after a failed TTL cleanup so disposal can retry.
          })
        }, 60 * 60 * 1000)
        timer.unref()
        this.exports.set(canonical, timer)
        return canonical
      } catch (error) { if (directory) await rm(directory, { recursive: true, force: true }); throw error }
      finally { this.exportOpenings-- }
    }
    const files = await import('./localFiles')
    this.assertCurrent()
    switch (method) {
      case 'files.resolve': {
        const access = params.access ?? 'read'
        if (access !== 'read' && access !== 'write') throw new Error('Invalid file access')
        return files.resolveLocalFileHandle(id, text(params.handleId, 512), access)
      }
      case 'files.directoryTarget': return files.resolveLocalDirectoryTarget(id, text(params.handleId, 512), text(params.name, 255))
      case 'files.pick': {
        const options = params.options ?? {}
        if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid file picker options')
        const input = options as LocalFilePickOptions
        if (input.kind !== undefined && !['file', 'directory', 'any'].includes(input.kind)
          || input.access !== undefined && !['read', 'write'].includes(input.access)
          || input.multiple !== undefined && typeof input.multiple !== 'boolean') throw new Error('Invalid file picker options')
        return files.pickLocalFiles(id, input, { signal: this.abort.signal, assertCurrent: this.assertCurrent })
      }
      case 'files.save': {
        const options = params.options ?? {}
        if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid save picker options')
        const defaultName = (options as { defaultName?: unknown }).defaultName
        return files.pickLocalSaveFile(id, defaultName === undefined ? {} : { defaultName: text(defaultName, 255) },
          { signal: this.abort.signal, assertCurrent: this.assertCurrent })
      }
      case 'files.export': {
        if (!Array.isArray(params.paths) || !params.paths.length || params.paths.length > 1000) throw new Error('Invalid export paths')
        const paths = await Promise.all(params.paths.map(path => realpath(text(path, 4096))))
        this.assertCurrent()
        if (paths.some(path => ![...this.exports.keys()].some(root => inside(root, path)))) throw new Error('Export path is outside this backend export scope')
        return files.createLocalExport(id, paths, { signal: this.abort.signal, assertCurrent: this.assertCurrent })
      }
      default: throw new Error('Unsupported backend capability')
    }
  }

  async dispose(): Promise<void> {
    this.beginClose()
    // In-flight creation must settle before the last resource enumeration.
    await Promise.allSettled([...this.pending])
    await this.files.dispose()
    const results = await Promise.allSettled([...this.exports].map(async ([directory, timer]) => {
      clearTimeout(timer)
      await rm(directory, { recursive: true, force: true })
      this.exports.delete(directory)
    }))
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
}
