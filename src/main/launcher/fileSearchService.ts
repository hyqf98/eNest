import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, relative, sep } from 'node:path'
import { dialog, shell } from 'electron'
import { trackNativeInteraction } from '@main/plugin/pluginInteractionPolicy'
import { settingsStore } from '@main/settings/SettingsStore'
import { getAppPathsGeneration } from '@main/paths/pathsService'
import type { FileSearchItem, FileSearchPreferenceRequest, FileSearchPreferences, FileSearchRequest, FileSearchResult } from '@shared/types/fileSearch'
import { getCachedApps } from './appScanner'
import { acceptedRoot, clearFileNameCache, localPath, pathKey, searchFileNames, within } from './fileNameProviders'

interface Target { path: string; canonical: string; device: number; inode: number; created: number; directory: boolean; executable: boolean }
interface Flight { abort: AbortController; targets: Map<string, Target>; current(): boolean; expiry: ReturnType<typeof setTimeout> }
const flights = new Map<number, Flight>()
let preferenceRevision = 0
export function fileSearchPreferences(): FileSearchPreferences {
  const stored = settingsStore.getFileSearchSettings()
  return { enabled: stored?.enabled === true, paused: stored?.paused === true,
    ...(process.platform === 'win32' && typeof stored?.everythingPort === 'number' && Number.isInteger(stored.everythingPort) && stored.everythingPort >= 1 && stored.everythingPort <= 65535 ? { everythingPort: stored.everythingPort } : {}),
    roots: Array.isArray(stored?.roots) ? stored.roots.filter(path => typeof path === 'string' && localPath(path)).slice(0, 8) : [] }
}

export function cancelFileSearch(owner: number): void {
  const flight = flights.get(owner)
  if (!flight) return
  flights.delete(owner); flight.abort.abort(); flight.targets.clear(); clearTimeout(flight.expiry)
}

export function resetFileSearch(): void {
  for (const owner of flights.keys()) cancelFileSearch(owner)
  clearFileNameCache()
}

export async function configureFileSearch(request: FileSearchPreferenceRequest, current: () => boolean): Promise<FileSearchPreferences> {
  if (!current()) throw new Error('Settings surface unavailable')
  const preferences = fileSearchPreferences(), revision = preferenceRevision, generation = getAppPathsGeneration()
  if (request?.operation === 'read') return preferences
  if (request?.operation === 'enable' && typeof request.value === 'boolean') preferences.enabled = request.value
  else if (request?.operation === 'everything' && process.platform === 'win32' && preferences.enabled && (request.port === null || Number.isInteger(request.port) && request.port >= 1 && request.port <= 65535)) {
    if (request.port === null) delete preferences.everythingPort
    else preferences.everythingPort = request.port
  }
  else if (request?.operation === 'add-root' && preferences.enabled && preferences.roots.length < 8) {
    const picked = await trackNativeInteraction(dialog.showOpenDialog({ title: '选择文件名检索的备用目录', properties: ['openDirectory'] }))
    if (picked.canceled || !picked.filePaths.length) return fileSearchPreferences()
    const root = await acceptedRoot(picked.filePaths[0])
    if (!root) throw new Error('请选择一个具体的文件夹，不能使用磁盘或整个用户目录')
    if (!preferences.roots.includes(root)) preferences.roots.push(root)
  } else if (request?.operation === 'remove-root' && Number.isSafeInteger(request.index) && request.index >= 0 && request.index < preferences.roots.length) preferences.roots.splice(request.index, 1)
  else if (request?.operation === 'pause' && typeof request.value === 'boolean') preferences.paused = request.value
  else if (request?.operation !== 'clear') throw new Error('Invalid file search preference')
  if (!current() || preferenceRevision !== revision || getAppPathsGeneration() !== generation) throw new Error('Settings changed; please retry')
  preferenceRevision++; resetFileSearch(); settingsStore.commitFileSearch(preferences)
  return preferences
}

async function identify(path: string): Promise<Target | undefined> {
  const canonical = await realpath(path)
  if (!localPath(canonical)) return
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) return
  const executable = /\.(?:app|exe|msi|msix|msixbundle|msp|bat|cmd|com|cpl|msc|pif|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|reg|scr|lnk|url|hta|jar|desktop|command|sh|pkg|scpt|workflow|webloc|inetloc)$/iu.test(path) || !info.isDirectory() && process.platform !== 'win32' && Boolean(info.mode & 0o111)
  return { path, canonical, device: info.dev, inode: info.ino, created: info.birthtimeMs, directory: info.isDirectory(), executable }
}

async function unchanged(target: Target): Promise<boolean> {
  const next = await identify(target.path).catch(() => undefined)
  return !!next && next.canonical === target.canonical && next.device === target.device && next.inode === target.inode && next.created === target.created && next.directory === target.directory && next.executable === target.executable
}

export async function handleFileSearch(owner: number, request: FileSearchRequest, current: () => boolean): Promise<FileSearchResult> {
  const preferences = fileSearchPreferences()
  if (!preferences.enabled) { cancelFileSearch(owner); return { status: 'off' } }
  if (request?.operation === 'status') return { status: 'ready' }
  if (request?.operation === 'cancel') { cancelFileSearch(owner); return { status: 'ready' } }
  if (!current()) { cancelFileSearch(owner); return { status: 'stale' } }
  if (request?.operation === 'open' || request?.operation === 'reveal') {
    const flight = flights.get(owner), target = flight?.targets.get(request.id)
    const valid = () => current() && !!flight && flights.get(owner) === flight && flight.current() && !flight.abort.signal.aborted
    if (!target || !valid() || !await unchanged(target) || !valid()) return { status: 'stale' }
    try {
      if (request.operation === 'reveal') shell.showItemInFolder(target.canonical)
      else {
        if (target.executable) {
          const confirmation = await trackNativeInteraction(dialog.showMessageBox({ type: 'warning', message: `打开可执行文件「${basename(target.path)}」？`, detail: target.canonical, buttons: ['取消', '打开'], defaultId: 0, cancelId: 0 }))
          if (confirmation.response !== 1 || !valid() || !await unchanged(target) || !valid()) return { status: 'stale' }
        }
        if (await shell.openPath(target.canonical)) return { status: 'failed' }
      }
      return { status: 'ready' }
    } catch { return { status: 'failed' } }
  }
  cancelFileSearch(owner)
  if (request?.operation !== 'query' || typeof request.query !== 'string' || request.scope !== 'mixed' && request.scope !== 'files') return { status: 'failed' }
  const query = request.query.trim()
  if (!query || query.length > 128 || /[\u0000-\u001f\u007f]/u.test(query)) return { status: 'ready', items: [] }
  const abort = new AbortController(), expiry = setTimeout(() => cancelFileSearch(owner), 120_000)
  expiry.unref()
  const generation = getAppPathsGeneration()
  const flight: Flight = { abort, expiry, targets: new Map(), current: () => current() && generation === getAppPathsGeneration() }
  flights.set(owner, flight)
  const valid = () => flight.current() && !abort.signal.aborted && flights.get(owner) === flight
  try {
    const { paths, provider, limited } = await searchFileNames(query, preferences, abort.signal)
    const seen = new Set(request.scope === 'mixed' ? getCachedApps()?.apps.map(item => pathKey(item.path)) : [])
    const limit = request.scope === 'mixed' ? 3 : 32, items: FileSearchItem[] = []
    let more = false
    for (const path of paths) {
      if (!valid()) return { status: 'stale' }
      if (seen.has(pathKey(path))) continue
      const target = await identify(path).catch(() => undefined)
      if (!target || seen.has(pathKey(target.canonical)) || provider === 'selected-folders' && !preferences.roots.some(root => within(root, target.canonical))) continue
      seen.add(pathKey(target.canonical))
      if (items.length === limit) { more = true; break }
      const id = randomUUID(), parent = dirname(path), home = homedir()
      items.push({ id, name: basename(path), kind: target.directory ? 'directory' : 'file', parent: within(home, parent) ? relative(home, parent) ? `~${sep}${relative(home, parent)}` : '~' : parent })
      flight.targets.set(id, target)
    }
    return valid() ? { status: 'ready', provider, items, more, limited } : { status: 'stale' }
  } catch { return valid() ? { status: 'unavailable', items: [] } : { status: 'stale' } }
}
