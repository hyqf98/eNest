/** DSH native release installation and rollback-safe, source-aware runtime changes. */
import { spawn } from 'node:child_process'
import { net } from 'electron'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pluginHost } from '@main/plugin/PluginHost'
import { getRuntimeScope, type PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { logWarn } from '@main/logs/logService'
import {
  clearActiveMarker, dataRuntimeRoot, DSH_PLUGIN_ID, dshDataDirs, ensureDshDirs, getActiveMarker,
  listInstalledRuntimes, resolveRuntime, resolveRuntimeSelection, runtimeIdentity, safeRuntimeVersion,
  setActiveMarker, validateRuntimeRoot, type DshRuntimeSelection, type ResolvedRuntime
} from '@main/dsh/dshRuntimeStore'
import { createBackup, restoreBackup } from '@main/dsh/dshProfileService'
import {
  ownDshChild, probeDshRuntime, restartDshProcesses, snapshotDshProcesses, stopAllDshAndWait, withDshMaintenance
} from '@main/dsh/dshRuntimeService'
import type { DshRemoteVersion, DshRuntimeVersion, DshWorkbenchEvent } from '@shared/types/dsh-workbench'

const BUNDLE_REPO = 'hyqf98/eNest_plugin'
const GITHUB_API = `https://api.github.com/repos/${BUNDLE_REPO}/releases?per_page=30`
const NPM_REGISTRY = 'https://registry.npmjs.org/@deepseek-ai%2fdsh'
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
const MAX_ARCHIVE_LIST_BYTES = 32 * 1024 * 1024
function platformTag(): string { return `${process.platform}-${process.arch}` }
function emit(pluginId: string, event: DshWorkbenchEvent): void { pluginHost.sendEvent(pluginId, { type: 'dsh.event', event }) }
function errorMessage(error: unknown): string { return String((error as Error)?.message ?? error) }
function operationScope(pluginId: string): PluginRuntimeScope {
  const scope = getRuntimeScope(pluginId)
  if (!scope || !scope.isCurrent() || scope.signal.aborted) throw new Error('plugin runtime is closing')
  return scope
}
function assertCurrent(scope: PluginRuntimeScope): void {
  if (!scope.isCurrent() || scope.signal.aborted) throw new Error('plugin runtime is closing; DSH operation cancelled')
}
async function fetchTimed(url: string, signal?: AbortSignal): Promise<Response> {
  return net.fetch(url, { headers: { accept: 'application/vnd.github+json' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) })
}
interface GithubAsset { name: string; browser_download_url: string; size: number; digest?: string }
interface DownloadableVersion extends DshRemoteVersion { checksumUrl?: string; assetName?: string }
function validAssetUrl(value: string, name: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash
      || !url.pathname.startsWith(`/${BUNDLE_REPO}/releases/download/`) || decodeURIComponent(url.pathname.split('/').pop()!) !== name) return undefined
    return url.href
  } catch { return undefined }
}
export function parseRuntimeChecksum(text: string, assetName?: string): string {
  const content = text.trim().replace(/^sha256:/i, '')
  if (/^[a-f0-9]{64}$/i.test(content)) return content.toLowerCase()
  for (const line of content.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})[ \t]+\*?(.+?)\s*$/i.exec(line)
    if (match && (!assetName || match[2].replace(/^\.\//, '') === assetName)) return match[1].toLowerCase()
  }
  throw new Error('sha256 边车格式或资产文件名不匹配')
}
export async function listRemoteVersions(pluginId: string, limit = 20): Promise<DownloadableVersion[]> {
  const signal = getRuntimeScope(pluginId)?.signal
  const json = async (url: string) => { const response = await fetchTimed(url, signal); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json() }
  const [releases, npmMeta] = await Promise.all([
    json(GITHUB_API).catch(error => { throw new Error(`DSH 原生版本列表获取失败: ${errorMessage(error)}`) }),
    json(NPM_REGISTRY).catch(() => null)
  ])
  if (!Array.isArray(releases)) throw new Error('DSH 原生版本列表响应格式错误')
  const meta = npmMeta as { time?: Record<string, string>; 'dist-tags'?: { latest?: string } } | null
  const result = new Map<string, DownloadableVersion>()
  if (Array.isArray(releases)) {
    for (const release of releases as Array<{ draft?: boolean; assets?: GithubAsset[]; published_at?: string }>) {
      if (release.draft) continue
      for (const asset of release.assets ?? []) {
        const suffix = `-${platformTag()}.tgz`
        if (!asset.name.startsWith('dsh-runtime-') || !asset.name.endsWith(suffix)) continue
        const version = asset.name.slice('dsh-runtime-'.length, -suffix.length)
        try { safeRuntimeVersion(version) } catch { continue }
        if (result.has(version)) continue // GitHub returns newest releases first.
        const assetUrl = validAssetUrl(asset.browser_download_url, asset.name)
        if (!assetUrl) continue
        const checksum = release.assets?.find(entry => entry.name === `${asset.name}.sha256`)
        const checksumUrl = checksum && validAssetUrl(checksum.browser_download_url, checksum.name)
        let sha256: string | undefined
        try { if (asset.digest) sha256 = parseRuntimeChecksum(asset.digest) } catch { /* sidecar required below */ }
        result.set(version, { version, date: release.published_at, assetUrl, checksumUrl, assetName: asset.name, sha256 })
      }
    }
  }
  const latest = meta?.['dist-tags']?.latest
  if (typeof latest === 'string' && !result.has(latest)) {
    try { safeRuntimeVersion(latest); result.set(latest, { version: latest, distTag: 'latest', date: meta?.time?.[latest] }) }
    catch { /* invalid registry metadata */ }
  }
  const selected = [...result.values()].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
    .slice(0, Math.max(1, Math.min(50, Number.isFinite(limit) ? Math.floor(limit) : 20)))
  // Explicit remote refresh resolves verification metadata for the UI; cap concurrent sidecar reads.
  let next = 0
  await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
    while (next < selected.length) {
      const entry = selected[next++]
      if (entry.sha256 || !entry.checksumUrl) continue
      try {
        const response = await fetchTimed(entry.checksumUrl, signal)
        if (response.ok) entry.sha256 = parseRuntimeChecksum(await response.text(), entry.assetName)
      } catch { /* Still show the remote release honestly, but it is not verified/installable. */ }
    }
  }))
  return selected
}
async function downloadToFile(pluginId: string, url: string, dest: string, sha256: string, scope: PluginRuntimeScope): Promise<void> {
  const signal = AbortSignal.any([scope.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)])
  const response = await net.fetch(url, { signal })
  if (!response.ok || !response.body) throw new Error(`下载失败: HTTP ${response.status}`)
  const total = Number(response.headers.get('content-length') ?? 0)
  if (total > MAX_ARCHIVE_BYTES) { await response.body.cancel(); throw new Error('runtime 下载超过大小限制') }
  const hash = createHash('sha256')
  let received = 0
  let lastReport = 0
  const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
  source.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (received > MAX_ARCHIVE_BYTES) { source.destroy(new Error('runtime 下载超过大小限制')); return }
    hash.update(chunk)
    if (Date.now() - lastReport > 400) {
      lastReport = Date.now()
      emit(pluginId, { type: 'runtime-progress', phase: 'download', detail: `${received}${total > 0 ? `/${total}` : ''} bytes`,
        percent: total > 0 ? Math.min(100, Math.round(received / total * 100)) : undefined })
    }
  })
  await pipeline(source, createWriteStream(dest, { flags: 'wx', mode: 0o600 }), { signal })
  assertCurrent(scope)
  if (hash.digest('hex') !== sha256) throw new Error('sha256 校验失败')
}
async function runTar(pluginId: string, args: string[], scope: PluginRuntimeScope): Promise<string> {
  assertCurrent(scope)
  const command = process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar'
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' } })
  const owned = ownDshChild(pluginId, child)
  let stdout = ''
  let stderr = ''
  let overflow = false
  child.stdout?.on('data', chunk => {
    stdout += String(chunk)
    if (stdout.length > MAX_ARCHIVE_LIST_BYTES) { overflow = true; stdout = ''; owned.stop() }
  })
  child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8192) })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const done = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    const code = await Promise.race([done, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { owned.stop(); reject(new Error('tar 操作超时')) }, 120_000)
      timer.unref()
    })])
    await owned.waitForExit()
    assertCurrent(scope)
    if (overflow || code !== 0) throw new Error(`tar 失败: ${overflow ? '资产文件数超过限制' : stderr.slice(-500) || code}`)
    return stdout
  } catch (error) { owned.stop(); await owned.waitForExit(); throw error }
  finally { if (timer) clearTimeout(timer) }
}
async function extractRuntime(pluginId: string, tgz: string, dest: string, scope: PluginRuntimeScope): Promise<void> {
  // Preflight before extraction: tar's own traversal warnings are not an installation boundary.
  const listing = await runTar(pluginId, ['-tzf', tgz], scope)
  const entries = listing.split(/\r?\n/).filter(Boolean)
  if (!entries.length || entries.length > 200_000) throw new Error('runtime 资产为空或文件过多')
  for (const original of entries) {
    const path = original.replace(/^(\.\/)+/, '').replace(/\/$/, '')
    if (!path || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path) || isAbsolute(path)
      || path.split('/').some(part => !part || part === '..' || part === '.') || /^[A-Za-z]:/.test(path)
      || !(path === 'package.json' || path === 'node_modules' || path.startsWith('node_modules/'))) {
      throw new Error(`runtime 资产含非法路径: ${original.slice(0, 200)}`)
    }
  }
  const verbose = await runTar(pluginId, ['-tvzf', tgz], scope)
  // Published assets are dereferenced. Reject links/devices rather than risk writes outside staging.
  if (verbose.split(/\r?\n/).filter(Boolean).some(line => !['-', 'd'].includes(line[0]))) throw new Error('runtime 资产包含链接或特殊文件，请使用重新构建的原生资产')
  await runTar(pluginId, ['-xzf', tgz, '-C', dest, '--no-same-owner', '--no-same-permissions'], scope)
}
export async function installRuntimeVersion(pluginId: string, version: string): Promise<void> {
  safeRuntimeVersion(version)
  return withDshMaintenance(pluginId, async () => {
    const scope = operationScope(pluginId)
    const { runtimeDir } = ensureDshDirs()
    const target = dataRuntimeRoot(version)
    if (existsSync(target)) { validateRuntimeRoot(target, version, true); return }
    const remote = (await listRemoteVersions(pluginId, 50)).find(entry => entry.version === version)
    assertCurrent(scope)
    if (!remote?.assetUrl || !remote.assetName) throw new Error(`版本 ${version} 无 ${platformTag()} 预编译资产（npm 参考版本不等于可下载的原生资产）`)
    let sha256 = remote.sha256
    if (!sha256) {
      if (!remote.checksumUrl) throw new Error(`版本 ${version} 缺少 sha256 校验资产，拒绝安装`)
      const response = await fetchTimed(remote.checksumUrl, scope.signal)
      if (!response.ok) throw new Error(`校验资产下载失败: HTTP ${response.status}`)
      sha256 = parseRuntimeChecksum(await response.text(), remote.assetName)
    }
    const work = mkdtempSync(join(runtimeDir, '.install-'))
    const tgz = join(work, 'runtime.tgz')
    const staging = join(work, 'runtime')
    try {
      emit(pluginId, { type: 'runtime-progress', phase: 'download-start', detail: remote.assetName })
      await downloadToFile(pluginId, remote.assetUrl, tgz, sha256, scope)
      mkdirSync(staging)
      emit(pluginId, { type: 'runtime-progress', phase: 'extract' })
      await extractRuntime(pluginId, tgz, staging, scope)
      validateRuntimeRoot(staging, version, true)
      assertCurrent(scope)
      // Same filesystem, atomic promotion. Never overwrite an active/partially installed version.
      if (existsSync(dataRuntimeRoot(version))) throw new Error(`版本 ${version} 安装目录已存在，请先检查或移除`)
      renameSync(staging, target)
      emit(pluginId, { type: 'runtime-progress', phase: 'installed', detail: version })
    } finally { rmSync(work, { recursive: true, force: true }) }
  })
}

export interface SwitchDshRuntimeInput extends DshRuntimeSelection { restart?: boolean }
export interface DshRuntimeChangeResult { backupId: string; application: 'stopped' | 'restarted'; message: string }
async function healthCheck(pluginId: string, runtime: ResolvedRuntime, scope: PluginRuntimeScope): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), 'enest-dsh-health-'))
  const home = join(work, 'home')
  mkdirSync(home)
  try {
    assertCurrent(scope)
    const actual = await probeDshRuntime(pluginId, runtime, home)
    if (runtime.version && actual !== runtime.version && !actual.split(/\s+/).some(part => part.replace(/^v/, '') === runtime.version)) {
      throw new Error(`健康检查版本不匹配（期望 ${runtime.version}，实际 ${actual}）`)
    }
  } finally { rmSync(work, { recursive: true, force: true }) }
}
function restoreMarker(previous: DshRuntimeSelection | null): void {
  if (previous) setActiveMarker(previous)
  else clearActiveMarker()
}
async function changeRuntime(pluginId: string, input: SwitchDshRuntimeInput, install: boolean): Promise<DshRuntimeChangeResult> {
  safeRuntimeVersion(input.version)
  if (!['data', 'bundled', 'system'].includes(input.source)) throw new Error('非法 runtime 来源')
  return withDshMaintenance(pluginId, async () => {
    const scope = operationScope(pluginId)
    const previous = getActiveMarker()
    const snapshot = snapshotDshProcesses(pluginId)
    const label = runtimeIdentity(input)
    emit(pluginId, { type: 'runtime-progress', phase: 'upgrade-start', detail: `目标 ${label}` })
    await stopAllDshAndWait(pluginId)
    assertCurrent(scope)
    ensureDshDirs()
    const backupId = await createBackup('home', `运行时变更前快照 → ${label}`)
    let committed = false
    try {
      if (install) await installRuntimeVersion(pluginId, input.version)
      const target = resolveRuntimeSelection(input)
      emit(pluginId, { type: 'runtime-progress', phase: 'health-check', detail: label })
      await healthCheck(pluginId, target, scope)
      assertCurrent(scope)
      setActiveMarker(input)
      committed = true
      if (input.restart) await restartDshProcesses(pluginId, snapshot)
      emit(pluginId, { type: 'runtime-progress', phase: 'activated', detail: label })
      emit(pluginId, { type: 'runtime-progress', phase: 'upgrade-done', detail: label })
      return { backupId, application: input.restart ? 'restarted' : 'stopped',
        message: input.restart ? '运行时已切换并重新启动原进程；就绪状态以进程握手为准' : '运行时已切换且健康检查通过；进程保持停止，下次启动生效' }
    } catch (error) {
      const detail = errorMessage(error)
      emit(pluginId, { type: 'runtime-progress', phase: 'rollback', detail: `${detail}；恢复备份 ${backupId}` })
      logWarn('dsh', `运行时变更失败，回滚: ${detail}`)
      const failures: string[] = []
      // Never mutate home while an unconfirmed child may still be writing to it.
      let stopped = false
      try { await stopAllDshAndWait(pluginId); stopped = true } catch (stopError) { failures.push(errorMessage(stopError)) }
      if (stopped) {
        if (committed) { try { restoreMarker(previous) } catch (markerError) { failures.push(`标记: ${errorMessage(markerError)}`) } }
        try { await restoreBackup(backupId, 'home') } catch (restoreError) { failures.push(`数据: ${errorMessage(restoreError)}`) }
      }
      if (failures.length) throw new Error(`运行时变更失败: ${detail}；回滚未完成: ${failures.join('；')}（备份 ${backupId} 保留）`)
      throw new Error(`运行时变更失败已回滚: ${detail}（备份 ${backupId} 保留，进程已停止）`)
    }
  })
}
export async function switchDshRuntime(pluginId: string, input: SwitchDshRuntimeInput): Promise<DshRuntimeChangeResult> {
  return changeRuntime(pluginId, input, false)
}
export async function activateRuntimeVersion(pluginId: string, version: string): Promise<DshRuntimeChangeResult> {
  return switchDshRuntime(pluginId, { source: 'data', version })
}
export async function oneClickUpgrade(pluginId: string, version: string): Promise<DshRuntimeChangeResult> {
  return changeRuntime(pluginId, { version, source: 'data' }, true)
}
export async function removeRuntimeVersion(version: string, pluginId = DSH_PLUGIN_ID): Promise<void> {
  safeRuntimeVersion(version)
  return withDshMaintenance(pluginId, async () => {
    operationScope(pluginId)
    const marker = getActiveMarker()
    const active = resolveRuntime()
    if (marker?.source === 'data' && marker.version === version || active.source === 'data' && active.version === version) {
      throw new Error(`版本 data:${version} 正在使用，先切换到其他来源/版本再移除`)
    }
    const target = dataRuntimeRoot(version)
    if (!existsSync(target)) throw new Error(`版本 ${version} 未安装`)
    if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory()) throw new Error('非法 runtime 目录')
    // Quiesce before unlinking even if an older process predates the current selection marker.
    await stopAllDshAndWait(pluginId)
    dataRuntimeRoot(version)
    rmSync(target, { recursive: true, force: false })
  })
}
export function installedVersions(): DshRuntimeVersion[] { return listInstalledRuntimes() }
export function backupsDiskUsage(): { bytes: number; count: number } {
  const { backupDir } = dshDataDirs()
  if (!existsSync(backupDir)) return { bytes: 0, count: 0 }
  let bytes = 0
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(path, depth + 1)
      else { try { bytes += statSync(path).size } catch { /* ignore inaccessible entries */ } }
    }
  }
  walk(backupDir, 0)
  return { bytes, count: readdirSync(backupDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).length }
}
