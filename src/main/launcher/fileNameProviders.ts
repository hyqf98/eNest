import { execFile, spawn } from 'node:child_process'
import { lstat, opendir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'
import { promisify } from 'node:util'
import type { FileSearchPreferences } from '@shared/types/fileSearch'
import { getAppPathsGeneration } from '@main/paths/pathsService'

interface Matches { paths: string[]; provider: string; limited?: boolean }
const MAX_CANDIDATES = 96
const MAX_NAMES = 20_000
const exec = promisify(execFile)
let spotlightStatus: { enabled: boolean; until: number } | undefined
const ignored = new Set(['node_modules', 'vendor', 'Library', 'AppData', '$RECYCLE.BIN', 'System Volume Information'])
const fold = (name: string) => name.normalize('NFC').toLowerCase()
export const pathKey = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
export const localPath = (path: string) => isAbsolute(path) && !/^[\\/]{2}|[\u0000-\u001f\u007f]/u.test(path)
export const within = (root: string, target: string) => { const tail = relative(root, target); return tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail) }

function lines(command: string, args: string[], separator: string, accept: (value: string) => string | undefined, signal: AbortSignal, env = process.env): Promise<string[]> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('cancelled'))
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env })
    const paths: string[] = [], decoder = new StringDecoder('utf8')
    let pending = '', size = 0, done = false
    const stop = (ok: boolean) => {
      if (done) return
      done = true; clearTimeout(timer); signal.removeEventListener('abort', cancel); child.kill()
      if (ok) resolve(paths); else reject(new Error('file index unavailable'))
    }
    const cancel = () => stop(false), timer = setTimeout(cancel, 2200)
    signal.addEventListener('abort', cancel, { once: true })
    const add = (line: string) => {
      let path: string | undefined
      try { path = accept(line) } catch { return }
      if (path && localPath(path) && path.length < 8192) paths.push(path)
    }
    child.stdout.on('data', (buffer: Buffer) => {
      if (done) return
      size += buffer.length
      if (size > 512 * 1024) { stop(paths.length > 0); return }
      const entries = (pending + decoder.write(buffer)).split(separator)
      pending = entries.pop() ?? ''
      for (const entry of entries) { add(entry); if (paths.length >= MAX_CANDIDATES) { stop(true); break } }
    })
    child.on('error', cancel)
    child.on('close', code => { if (!done) { add(pending + decoder.end()); stop(code === 0) } })
  })
}

const windowsQuery = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$conn=New-Object -ComObject ADODB.Connection;try {$conn.Open('Provider=Search.CollatorDSO.1;Extended Properties="Application=Windows";');$text=$env:ENEST_FILE_NAME.Replace("'","''").Replace('[','[[]').Replace('%','[%]').Replace('_','[_]');$sql="SELECT TOP 96 System.ItemPathDisplay FROM SystemIndex WHERE System.ItemUrl LIKE 'file:%' AND System.FileName LIKE '%$text%'";$rows=$conn.Execute($sql);while(!$rows.EOF){[Console]::WriteLine($rows.Fields.Item(0).Value);$rows.MoveNext()};$rows.Close()}finally{if($conn.State -eq 1){$conn.Close()}}`

async function nativeNames(query: string, signal: AbortSignal, everythingPort?: number): Promise<Matches> {
  const filename = fold(query), literal = (path: string) => fold(basename(path)).includes(filename) ? path : undefined
  if (process.platform === 'darwin') {
    const escaped = query.replace(/[\\"*?]/gu, character => `\\${character}`)
    const paths = await lines('/usr/bin/mdfind', ['-0', `kMDItemFSName == "*${escaped}*"cd`], '\0', literal, signal)
    if (paths.length) return { provider: 'Spotlight', paths }
    if (!spotlightStatus || spotlightStatus.until < Date.now()) {
      let enabled = true
      try {
        const { stdout } = await exec('/usr/bin/mdutil', ['-s', '/'], { timeout: 700, maxBuffer: 8192, signal, env: { ...process.env, LC_ALL: 'C' } })
        enabled = !/indexing (?:and searching )?disabled|spotlight server is disabled/i.test(stdout)
      } catch { if (signal.aborted) throw new Error('cancelled') }
      spotlightStatus = { enabled, until: Date.now() + 60_000 }
    }
    if (!spotlightStatus.enabled) throw new Error('Spotlight disabled')
    return { provider: 'Spotlight', paths }
  }
  if (process.platform === 'win32') {
    if (everythingPort !== undefined) {
      try {
        const { everythingFileNames } = await import('./everythingFileNames')
        return { paths: await everythingFileNames(query, everythingPort, MAX_CANDIDATES, signal), provider: 'Everything' }
      } catch { if (signal.aborted) throw new Error('cancelled') }
    }
    const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    return { provider: 'Windows Search', paths: await lines(powershell, ['-NoProfile', '-NonInteractive', '-Command', windowsQuery], '\n', path => literal(path.replace(/\r$/, '')), signal, { ...process.env, ENEST_FILE_NAME: query }) }
  }
  for (const [tool, provider] of [['localsearch', 'LocalSearch'], ['tracker3', 'Tracker'], ['baloosearch6', 'Baloo'], ['baloosearch', 'Baloo']] as const) {
    if (signal.aborted) throw new Error('cancelled')
    const token = query.match(/[\p{L}\p{N}]+/u)?.[0]
    if (!token) continue
    const args = provider === 'Baloo' ? ['--limit', String(MAX_CANDIDATES), `filename:${token}`] : ['search', '--files', '--disable-fts', '--limit', String(MAX_CANDIDATES), token]
    try {
      return { provider, paths: await lines(`/usr/bin/${tool}`, args, '\n', line => {
        const entry = line.trim()
        return entry.startsWith('file:///') ? literal(fileURLToPath(entry)) : provider === 'Baloo' && entry.startsWith('/') ? literal(entry) : undefined
      }, signal, { ...process.env, LC_ALL: 'C', NO_COLOR: '1' }) }
    } catch { if (signal.aborted) throw new Error('cancelled') }
  }
  throw new Error('no system file index')
}

export async function acceptedRoot(path: string): Promise<string | undefined> {
  if (!localPath(path)) return
  const canonical = await realpath(path)
  const info = await lstat(canonical)
  if (!localPath(canonical) || dirname(canonical) === canonical || within(canonical, homedir()) || !info.isDirectory() || info.dev !== (await lstat(dirname(canonical))).dev) return
  return canonical
}

interface RootCache { key: string; created: number; names: string[]; capped: boolean }
let selectedCache: RootCache | undefined
export function clearFileNameCache(): void { selectedCache = undefined; spotlightStatus = undefined }

async function selectedNames(query: string, preferences: FileSearchPreferences, signal: AbortSignal): Promise<Matches> {
  if (!preferences.roots.length || preferences.paused) throw new Error('no selected folders')
  let cache = selectedCache
  const key = JSON.stringify([getAppPathsGeneration(), preferences.roots])
  if (cache?.key !== key || Date.now() - cache.created > 60_000) {
    const names: string[] = [], queue: Array<{ root: string; path: string; depth: number }> = []
    const deadline = Date.now() + 1500
    let scanned = 0, bytes = 0, capped = false, readable = false
    for (const root of preferences.roots) if (await acceptedRoot(root).catch(() => undefined) === root) queue.push({ root, path: root, depth: 0 })
    for (let index = 0; index < queue.length; index++) {
      if (signal.aborted) throw new Error('cancelled')
      if (scanned >= MAX_NAMES || bytes > 4 * 1024 * 1024 || Date.now() >= deadline) { capped = true; break }
      const { root, path, depth } = queue[index]
      try {
        if (await realpath(path) !== path || !within(root, path)) continue
        const directory = await opendir(path)
        readable = true
        for await (const entry of directory) {
          if (signal.aborted) throw new Error('cancelled')
          if (++scanned >= MAX_NAMES || Date.now() >= deadline) { capped = true; break }
          if (entry.name.startsWith('.') || ignored.has(entry.name) || entry.isSymbolicLink() || !entry.isFile() && !entry.isDirectory()) continue
          const target = join(path, entry.name)
          bytes += Buffer.byteLength(target)
          if (bytes > 4 * 1024 * 1024) { capped = true; break }
          names.push(target)
          if (entry.isDirectory() && depth < 8 && !entry.name.endsWith('.app')) queue.push({ root, path: target, depth: depth + 1 })
          else if (entry.isDirectory() && depth >= 8) capped = true
        }
      } catch { if (signal.aborted) throw new Error('cancelled') }
    }
    if (signal.aborted || !readable) throw new Error('selected folders unavailable')
    cache = { key, created: Date.now(), names, capped }; selectedCache = cache
  }
  const term = fold(query), paths: string[] = []
  for (const path of cache.names) if (fold(basename(path)).includes(term)) { paths.push(path); if (paths.length === MAX_CANDIDATES) break }
  return { paths, provider: 'selected-folders', limited: cache.capped }
}

export async function searchFileNames(query: string, preferences: FileSearchPreferences, signal: AbortSignal): Promise<Matches> {
  const nativeSignal = AbortSignal.any([signal, AbortSignal.timeout(preferences.everythingPort ? 3800 : 3000)])
  try { return await nativeNames(query, nativeSignal, preferences.everythingPort) }
  catch { if (signal.aborted) throw new Error('cancelled'); return selectedNames(query, preferences, signal) }
}
