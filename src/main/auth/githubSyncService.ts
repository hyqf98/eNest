import { kvStore } from '@main/db/sqliteService'
import { getAppPathsGeneration, retainAppPaths } from '@main/paths/pathsService'
import { pluginHost } from '@main/plugin/PluginHost'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { getRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { getBackgroundMemoryOwners } from '@main/plugin/pluginBackgroundRuntime'
import { drainPrivateDocumentWrites } from '@main/plugin/pluginPrivateDocuments'
import { homeSurfaceManager } from '@main/home/HomeSurfaceManager'
import { withInstallLock } from '@main/plugin/PluginInstaller'
import { decodeSnapshot, encodeSnapshot, readSnapshot, restoreSnapshot } from '@main/plugin/portablePluginData'
import { sendShellEvent } from '@main/window/createShellWindow'
import type { GithubSyncState, SyncConflict, SyncDirection, SyncOutcome, SyncProgress, SyncReport, SyncRepository, SyncTransfer } from '@shared/types/githubSync'
import { getGithubAuthConfig } from './authConfig'
import { getGithubSyncSession, getProfileUser } from './githubAuthService'
import { blobSha, downloadSnapshot, findExistingSyncRepository, listPrivateRepositories, MAX_SYNC_PLUGINS, openIndex, resolveRepository, syncPluginId, syncRepoName, uploadSnapshot, type CloudIndex, type GithubSession } from './githubRepository'

interface Binding { repository: SyncRepository; automatic: boolean; base: Record<string, string>; report: SyncReport | null }
let active: Promise<unknown> | null = null
let batch: { id: number; repo: number; cancel: boolean; progress: SyncProgress | null } | null = null
const errorText = (error: unknown) => error instanceof Error ? error.message : '同步未完成，请重试。'
function account(id: unknown): number {
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || getProfileUser()?.githubId !== id) throw new Error('GitHub 账号已变化，请重新打开个人资料')
  return id
}
function binding(id: number): Binding | null {
  const raw = kvStore.kvGet(`github-sync:v1:${account(id)}`)
  if (!raw) return null
  const state: Binding = JSON.parse(raw)
  if (!Number.isSafeInteger(state?.repository?.id) || !state.repository.name || !state.base || typeof state.base !== 'object' || typeof state.automatic !== 'boolean') throw new Error('本机绑定信息无效，请断开后重新连接')
  return state
}
function persist(id: number, value: Binding) { kvStore.kvSet(`github-sync:v1:${account(id)}`, JSON.stringify(value)) }
function bound(id: number, repositoryId: unknown): Binding {
  const value = binding(id)
  if (!value || value.repository.id !== repositoryId) throw new Error('绑定仓库已变更，请刷新。')
  return value
}
async function exclusive<T>(run: () => Promise<T>): Promise<T> {
  if (active) throw new Error('另一个同步操作正在进行，请稍后重试。')
  const release = retainAppPaths()
  const task = Promise.resolve().then(run)
  active = task
  try { return await task } finally { active = null; release() }
}
export function waitForGithubSync() { return active?.catch(() => {}) }
async function sessionFor(id: number) {
  account(id)
  const session = await getGithubSyncSession()
  if (session.user.id !== id) throw new Error('GitHub 账号不匹配')
  return session
}
async function readBoundIndex(session: GithubSession, value: Binding) {
  const { name, id } = value.repository
  return openIndex(session, await resolveRepository(session, name, false, id))
}
export async function githubSyncState(id: number): Promise<GithubSyncState> {
  const value = binding(id)
  const state: GithubSyncState = { repository: value?.repository ?? null, autoRestore: value?.automatic ?? false, installationUrl: getGithubAuthConfig().installationUrl, cloud: [], report: value?.report ?? null, progress: null }
  if (value) {
    try { state.cloud = (await readBoundIndex(await sessionFor(id), value)).plugins }
    catch (error) { state.error = errorText(error) }
  }
  account(id)
  if (batch?.id === id && batch.repo === value?.repository.id) state.progress = batch.progress
  return state
}
export async function discoverGithubRepositories(id: number): Promise<string[]> { return listPrivateRepositories(await sessionFor(id)) }
export async function connectGithubRepository(id: number, input: unknown): Promise<void> {
  const name = syncRepoName(input)
  await exclusive(async () => {
    const old = binding(id), session = await sessionFor(id)
    const expectedId = old?.repository.name.toLowerCase() === name.toLowerCase() ? old.repository.id : undefined
    const repo = await resolveRepository(session, name, true, expectedId)
    const same = old?.repository.id === repo.id
    await openIndex(session, repo, !same)
    session.check()
    persist(id, { repository: { id: repo.id, name: repo.name }, automatic: same && old.automatic, base: same ? old.base : {}, report: same ? old.report : null })
  })
}
export function disconnectGithubRepository(id: number, repo: number) {
  if (active) throw new Error('请在同步结束后断开仓库')
  bound(id, repo)
  kvStore.kvSet(`github-sync:manual:${id}`, '1')
  kvStore.kvDelete(`github-sync:v1:${id}`)
}
export function cancelGithubSync(id: number, repo: number) {
  bound(id, repo)
  if (batch?.id === id && batch.repo === repo) batch.cancel = true
}

function isBusyPlugin(id: string) {
  return pluginHost.isOpened(id) || !!getRuntimeScope(id) || homeSurfaceManager.getMemoryOwners().some(owner => owner.pluginId === id) || getBackgroundMemoryOwners().some(owner => owner.pluginId === id)
}
async function transferPlugin(session: GithubSession, value: Binding, index: CloudIndex, pluginId: string, direction: SyncDirection, resolve?: SyncConflict): Promise<SyncOutcome> {
  const result = (status: SyncOutcome['status'], message?: string, conflict?: SyncConflict): SyncOutcome => ({ pluginId, status, message, conflict })
  return withInstallLock(pluginId, async () => {
    session.check()
    const descriptor = pluginRegistry.getInstalledDescriptors().find(item => item.id === pluginId)
    if (!descriptor) return result('skipped', '本机尚未安装该插件，不会自动安装。')
    if (isBusyPlugin(pluginId) || pluginHost.isBlockedForOpen(pluginId)) return result('skipped', '插件正在使用，请关闭或释放插件资源后重试。')
    const remote = index.plugins.find(item => item.pluginId === pluginId)
    if (direction === 'restore' && !remote) return result('skipped', '云端没有该插件的快照。')
    const release = pluginHost.blockPlugin(pluginId, 'sync plugin data')
    const check = () => {
      session.check()
      if (isBusyPlugin(pluginId) || pluginRegistry.getBuildRevision(pluginId) !== descriptor.buildRevision) throw new Error('插件运行状态或版本已变化，已停止同步。')
    }
    try {
      await drainPrivateDocumentWrites(pluginId)
      const snapshot = await readSnapshot(pluginId, check), bytes = encodeSnapshot(snapshot), local = blobSha(bytes), cloud = remote?.sha ?? null
      const empty = !snapshot.storage.length && !snapshot.files.length
      if (local === cloud) { value.base[pluginId] = local; return result('unchanged') }
      const previous = value.base[pluginId]
      const safe = direction === 'upload' ? (cloud === null ? !previous : previous === cloud && !empty) : previous ? previous === local : empty
      if (resolve ? resolve.local !== local || resolve.remote !== cloud : !safe) return result('conflict', '本机与云端版本不同，保留了两边的数据。', { local, remote: cloud })
      if (direction === 'upload') {
        if (empty && !remote) return result('skipped', '没有可同步的插件数据。')
        await uploadSnapshot(session, index, { pluginId, bytes: bytes.length, sha: local }, bytes)
      } else {
        const next = decodeSnapshot(await downloadSnapshot(session, index, remote!), pluginId)
        check()
        await restoreSnapshot(snapshot, next, check)
      }
      check()
      value.base[pluginId] = direction === 'upload' ? local : cloud!
      return result('done')
    } finally { release() }
  })
}
async function transfer(id: number, value: Binding, direction: SyncDirection, selection?: string[], resolve?: SyncConflict): Promise<SyncReport> {
  batch = { id, repo: value.repository.id, cancel: false, progress: null }
  try { return await runBatch(id, value, direction, selection, resolve) }
  finally { batch = null }
}
async function runBatch(id: number, value: Binding, direction: SyncDirection, selection?: string[], resolve?: SyncConflict): Promise<SyncReport> {
  const session = await sessionFor(id), index = await readBoundIndex(session, value)
  const pluginIds = selection ?? index.plugins.map(entry => entry.pluginId)
  const report: SyncReport = { direction, completedAt: Date.now(), items: [] }
  for (const pluginId of pluginIds) {
    session.check()
    if (batch!.cancel) { report.cancelled = true; break }
    batch!.progress = { done: report.items.length, total: pluginIds.length, pluginId }
    sendShellEvent({ type: 'github-sync-progress', accountId: id, repositoryId: index.repository.id, ...batch!.progress })
    let item: SyncOutcome
    try { item = await transferPlugin(session, value, index, pluginId, direction, resolve) }
    catch (error) { session.check(); item = { pluginId, status: 'error', message: errorText(error) } }
    session.check()
    report.items.push(item)
    persist(id, { ...value, report })
  }
  report.completedAt = Date.now()
  persist(id, { ...value, report })
  return report
}
function completed(id: number, repo: number) { if (getProfileUser()?.githubId === id) sendShellEvent({ type: 'github-sync-finished', accountId: id, repositoryId: repo }) }

export async function syncGithubPlugins(input: SyncTransfer): Promise<SyncReport> {
  if (!input || !['restore', 'upload'].includes(input.direction) || !Array.isArray(input.pluginIds) || !input.pluginIds.length || input.pluginIds.length > MAX_SYNC_PLUGINS || !input.pluginIds.every(syncPluginId) || new Set(input.pluginIds).size !== input.pluginIds.length) throw new Error('无效的插件同步选择')
  if (input.resolve !== undefined && (!input.resolve || input.pluginIds.length !== 1 || !/^[a-f0-9]{40}$/.test(input.resolve.local) || input.resolve.remote !== null && !/^[a-f0-9]{40}$/.test(input.resolve.remote))) throw new Error('无效的冲突版本')
  return exclusive(async () => {
    const value = bound(input.accountId, input.repositoryId)
    try { return await transfer(input.accountId, value, input.direction, input.pluginIds, input.resolve) }
    finally { completed(input.accountId, input.repositoryId) }
  })
}
export async function setGithubAutoRestore(id: number, repo: number, enabled: boolean) {
  if (typeof enabled !== 'boolean') throw new Error('无效的自动恢复设置')
  return exclusive(async () => {
    const value = bound(id, repo)
    value.automatic = enabled
    persist(id, value)
    try { if (enabled) await transfer(id, value, 'restore') }
    finally { completed(id, repo) }
  })
}
export function restoreGithubOnLogin(): void {
  const id = getProfileUser()?.githubId, generation = getAppPathsGeneration()
  if (!id || active) return
  const previous = binding(id)
  if (!previous && !kvStore.kvGet(`github-sync:manual:${id}`)) {
    void (async () => {
      const session = await sessionFor(id), repo = await findExistingSyncRepository(session)
      session.check()
      if (!repo || active || binding(id) || kvStore.kvGet(`github-sync:manual:${id}`)) return
      persist(id, { repository: { name: repo.name, id: repo.id }, automatic: false, base: {}, report: null })
      completed(id, repo.id)
    })().catch(() => {})
    return
  }
  if (!previous?.automatic) return
  void exclusive(async () => {
    const value = binding(id)
    if (!value?.automatic) return
    try { await transfer(id, value, 'restore') }
    catch (error) {
      if (getAppPathsGeneration() === generation && getProfileUser()?.githubId === id) persist(id, { ...value, report: { direction: 'restore', completedAt: Date.now(), items: [{ pluginId: '', status: 'error', message: errorText(error) }] } })
    } finally { completed(id, value.repository.id) }
  }).catch(() => {})
}
