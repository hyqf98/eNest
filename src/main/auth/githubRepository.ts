import { createHash } from 'node:crypto'
import { isPackageId } from '@main/plugin/packageIdentity'
import { DEFAULT_SYNC_REPOSITORY, SYNC_SNAPSHOT_LIMIT, type CloudPlugin, type SyncRepository } from '@shared/types/githubSync'
import type { getGithubSyncSession } from './githubAuthService'
import { githubRequest } from './githubTransport'

export type GithubSession = Awaited<ReturnType<typeof getGithubSyncSession>>
interface RepoResponse { id: number; node_id: string; name: string; private: boolean; archived: boolean; disabled?: boolean; owner: { id: number; type: string } }
interface Repository extends SyncRepository { node: string }
interface Head { branch: string; oid: string; tree: string }
export interface CloudIndex { repository: Repository; head: Head; plugins: CloudPlugin[] }
const MARKER = '.enest-sync.json', DIRECTORY = '.enest-sync'
const FORMAT = 'enest.plugin-sync/v1'
const DESCRIPTION = 'Private plugin data synced by eNest'
const REPOSITORY_PAGES = 5, PAGE_SIZE = 100
export const MAX_SYNC_PLUGINS = 512
const HASH = /^[a-f0-9]{40}$/
const INSTALL_HINT = '登录仅验证身份。首次同步请在 GitHub 安装 eNest Desktop Sync；已安装则检查同步私库的内容读写和建库权限。不用注册应用，也不用开放全部仓库。'

class GithubError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
function isStatus(error: unknown, status: number) { return error instanceof GithubError && error.status === status }
function validId(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }
export function syncPluginId(value: unknown): value is string { return typeof value === 'string' && value.length <= 180 && isPackageId(value) }
export function syncRepoName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z\d._-]{1,100}$/i.test(value) || /^\.+$|\.git$/i.test(value)) throw new Error('仓库名须为 1–100 个英文字母、数字、点、下划线或短横线，不含账号、路径或 .git 后缀')
  return value
}
export function blobSha(bytes: Buffer): string { return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') }

async function request(session: GithubSession, path: string, body?: unknown, rawLimit?: number, method = body === undefined ? 'GET' : 'POST', graphQuery = false) {
  const response = await githubRequest(`https://api.github.com${path}`, { method, signal: session.signal, headers: {
      Authorization: `Bearer ${session.token}`, Accept: rawLimit === undefined ? 'application/vnd.github+json' : 'application/vnd.github.raw+json',
      'User-Agent': 'eNest', 'Cache-Control': 'no-cache', 'X-GitHub-Api-Version': '2022-11-28', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, { timeoutMs: 45_000, limit: rawLimit ?? 2 * 1024 * 1024, graphQuery, check: session.check })
  session.check()
  if (!response.ok) {
    const status = response.status
    throw new GithubError(status, status === 401 ? 'GitHub 授权已失效，请退出并重新登录。' : status === 429 || status === 403 && response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0'
      ? 'GitHub 请求限额已达，请稍后重试。' : status === 403 || status === 404 ? `GitHub ${status}。${INSTALL_HINT}`
        : status === 409 || status === 422 ? `GitHub ${status}：仓库或分支可能已变化，请刷新后重试。` : `GitHub 请求失败（${status}），请重试。`)
  }
  return response
}
async function json<T>(session: GithubSession, path: string, body?: unknown, method?: string, graphQuery = false): Promise<T> {
  const { bytes } = await request(session, path, body, undefined, method, graphQuery)
  return JSON.parse(bytes.toString('utf8')) as T
}
async function graph<T>(session: GithubSession, query: string, variables: object): Promise<T> {
  const result = await json<{ data?: T; errors?: { type?: string }[] }>(session, '/graphql', { query, variables }, 'POST', query.startsWith('query('))
  if (!result.data || result.errors?.length) throw new Error(result.errors?.some(error => error.type === 'FORBIDDEN') ? INSTALL_HINT : 'GitHub 未确认操作：请刷新以检查远端版本、分支保护或应用权限。')
  return result.data
}
function repoPath(session: GithubSession, name: string) { return `/repos/${encodeURIComponent(session.user.login)}/${encodeURIComponent(syncRepoName(name))}` }
function privateRepo(session: GithubSession, item: RepoResponse, name: string, expectedId?: number): Repository {
  if (!item || item.private !== true || item.owner?.type !== 'User' || item.owner.id !== session.user.id) throw new Error('只允许使用当前 GitHub 账号拥有的私有仓库；不会向公开仓库写入。')
  if (!validId(item.id) || expectedId !== undefined && item.id !== expectedId || !item.node_id || syncRepoName(item.name).toLowerCase() !== name.toLowerCase() || item.archived || item.disabled) throw new Error('目标仓库已更换、归档或停用，请重新选择。')
  return { id: item.id, node: item.node_id, name: item.name }
}
export async function resolveRepository(session: GithubSession, name: string, create: boolean, expectedId?: number): Promise<Repository> {
  const path = repoPath(session, name)
  try { return privateRepo(session, await json<RepoResponse>(session, path), name, expectedId) }
  catch (error) { if (!create || expectedId !== undefined || !isStatus(error, 404)) throw error }
  let created: RepoResponse
  try { created = await json(session, '/user/repos', { name, private: true, auto_init: true, description: DESCRIPTION }) }
  catch (error) {
    if (!isStatus(error, 422)) throw error
    try { return privateRepo(session, await json<RepoResponse>(session, path), name) }
    catch (retry) { if (!isStatus(retry, 404)) throw retry; throw new Error(`仓库名称不可用或同名仓库尚未授权，未写入任何插件数据。${INSTALL_HINT}`) }
  }
  const verified = privateRepo(session, created, name)
  try { return privateRepo(session, await json<RepoResponse>(session, path), name, verified.id) }
  catch (error) {
    session.check()
    if (isStatus(error, 404)) throw new GithubError(404, `GitHub 已创建私库 ${session.user.login}/${verified.name}，但 eNest 还不能读取它。请在应用的仓库访问设置中只添加这个私库，再用原名重试。尚未上传插件数据。`)
    throw error
  }
}
async function repositoryChoices(session: GithubSession) {
  const repositories = new Map<number, { id: number; name: string; suggested: boolean }>()
  let complete = false
  for (let page = 1; page <= REPOSITORY_PAGES; page++) {
    const { bytes, headers } = await request(session, `/user/repos?affiliation=owner&visibility=private&sort=full_name&direction=asc&per_page=${PAGE_SIZE}&page=${page}`)
    const rows = JSON.parse(bytes.toString('utf8')) as (RepoResponse & { description?: string })[]
    if (!Array.isArray(rows) || rows.length > PAGE_SIZE) throw new Error('无法确认 GitHub 仓库列表，请直接输入仓库名。')
    for (const row of rows) {
      if (validId(row.id) && row.private === true && row.owner?.id === session.user.id && row.owner.type === 'User' && !row.archived && !row.disabled) repositories.set(row.id, { id: row.id, name: row.name, suggested: row.description === DESCRIPTION })
    }
    const links = headers.get('link')
    const more = links === null ? rows.length === PAGE_SIZE : /;\s*rel="next"/i.test(links)
    if (!more) { complete = true; break }
  }
  return { choices: [...repositories.values()].sort((left, right) => Number(right.suggested) - Number(left.suggested)), complete }
}
export async function listPrivateRepositories(session: GithubSession): Promise<string[]> {
  return (await repositoryChoices(session)).choices.map(row => row.name)
}
export async function findExistingSyncRepository(session: GithubSession): Promise<Repository | null> {
  const { choices, complete } = await repositoryChoices(session)
  if (!complete) return null
  const candidates = choices.length === 1 ? choices : choices.filter(row => row.suggested || row.name.toLowerCase() === DEFAULT_SYNC_REPOSITORY)
  if (candidates.length !== 1) return null
  const repo = await resolveRepository(session, candidates[0].name, false, candidates[0].id)
  await openIndex(session, repo)
  return repo
}

async function readHead(session: GithubSession, repo: Repository): Promise<Head | null> {
  const { node } = await graph<{ node: { name: string; isPrivate: boolean; isArchived: boolean; isEmpty: boolean; owner: { login: string }; defaultBranchRef: { id: string; target: { oid: string; tree?: { oid: string } } } | null } | null }>(session,
    'query($id: ID!) { node(id:$id) { ... on Repository { name isPrivate isArchived isEmpty owner { login } defaultBranchRef { id target { oid ... on Commit { tree { oid } } } } } } }', { id: repo.node })
  if (!node || !node.isPrivate || node.isArchived || node.owner.login.toLowerCase() !== session.user.login.toLowerCase() || node.name !== repo.name) throw new Error('仓库已不可访问、改名或不再是本人的私库，已停止同步。')
  if (!node.defaultBranchRef) {
    if (!node.isEmpty) throw new Error('无法读取此私库的默认分支，请检查仓库访问权限。')
    return null
  }
  const { id, target } = node.defaultBranchRef
  if (!id || !HASH.test(target?.oid) || !target.tree || !HASH.test(target.tree.oid)) throw new Error('GitHub 分支信息无效')
  return { branch: id, oid: target.oid, tree: target.tree.oid }
}
function marker(session: GithubSession, repository: Repository, plugins: CloudPlugin[]) {
  return Buffer.from(JSON.stringify({ format: FORMAT, accountId: session.user.id, repositoryId: repository.id, plugins }) + '\n')
}
function parseMarker(bytes: Buffer, session: GithubSession, repo: Repository): CloudPlugin[] {
  const data = JSON.parse(bytes.toString('utf8'))
  if (data?.format !== FORMAT || data.accountId !== session.user.id || data.repositoryId !== repo.id || !Array.isArray(data.plugins) || data.plugins.length > MAX_SYNC_PLUGINS) throw new Error('该仓库的 eNest 同步标记不匹配，未改动仓库。')
  const ids = new Set<string>()
  return data.plugins.map((entry: CloudPlugin) => {
    if (!entry || !syncPluginId(entry.pluginId) || ids.has(entry.pluginId) || !HASH.test(entry.sha) || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes > SYNC_SNAPSHOT_LIMIT) throw new Error('云端插件清单无效，已停止同步。')
    ids.add(entry.pluginId)
    return { pluginId: entry.pluginId, sha: entry.sha, bytes: entry.bytes }
  })
}
async function commit(session: GithubSession, repo: Repository, head: Head, files: { path: string; contents: string }[], message: string): Promise<Head> {
  const latest = await readHead(session, repo)
  if (latest?.branch !== head.branch || latest.oid !== head.oid) throw new Error('云端分支已有新提交，请刷新后重试；未覆盖远端。')
  const result = await graph<{ createCommitOnBranch?: { commit?: { oid: string; tree: { oid: string } } } }>(session,
    'mutation($input:CreateCommitOnBranchInput!){createCommitOnBranch(input:$input){commit{oid tree{oid}}}}', {
      input: { branch: { id: head.branch }, expectedHeadOid: head.oid, message: { headline: message }, fileChanges: { additions: files } },
    })
  const oid = result.createCommitOnBranch?.commit?.oid
  if (!oid || !HASH.test(oid)) throw new Error('无法确认提交结果，请刷新后再试。')
  return { ...head, oid, tree: result.createCommitOnBranch!.commit!.tree.oid }
}
export async function openIndex(session: GithubSession, repo: Repository, initialize = false): Promise<CloudIndex> {
  const head = await readHead(session, repo), path = repoPath(session, repo.name)
  const readTree = async (oid: string) => {
    const result = await json<{ truncated: boolean; tree: { path: string; mode: string; type: string; sha: string; size?: number }[] }>(session, `${path}/git/trees/${oid}`)
    if (result.truncated || !Array.isArray(result.tree)) throw new Error('目录清单不完整，无法确认同步空间。')
    return result.tree
  }
  if (head) {
    const root = await readTree(head.tree), control = root.find(file => file.path === MARKER), folder = root.find(file => file.path === DIRECTORY)
    if (folder && (folder.type !== 'tree' || !HASH.test(folder.sha) || !control)) throw new Error('同步目录名称被占用；未改动仓库。')
    if (control) {
      if (control.mode !== '100644' || !HASH.test(control.sha)) throw new Error('同步标记不是普通文件')
      const { bytes } = await request(session, `${path}/git/blobs/${control.sha}`, undefined, 256 * 1024)
      if (blobSha(bytes) !== control.sha) throw new Error('同步标记内容不一致')
      const plugins = parseMarker(bytes, session, repo), actual = folder ? await readTree(folder.sha) : []
      const files = new Map(actual.map(file => [file.path, file]))
      if (actual.length !== plugins.length || plugins.some(entry => {
        const file = files.get(`${entry.pluginId}.json`)
        return !file || file.mode !== '100644' || file.sha !== entry.sha || file.size !== entry.bytes
      })) throw new Error('远端快照或同步目录被其他程序修改，与清单不符。为保留现有数据，已停止同步。')
      return { repository: repo, head, plugins }
    }
  }
  if (!initialize) throw new Error('未找到已绑定的同步清单，不会自动重建；请核对 GitHub 仓库和访问权限。')
  const contents = marker(session, repo, []).toString('base64')
  if (head) {
    const next = await commit(session, repo, head, [{ path: MARKER, contents }], 'Initialize eNest sync')
    return { repository: repo, head: next, plugins: [] }
  }
  await json(session, `${path}/contents/${MARKER}`, { message: 'Initialize eNest sync', content: contents }, 'PUT')
  return openIndex(session, repo)
}
export async function uploadSnapshot(session: GithubSession, index: CloudIndex, entry: CloudPlugin, bytes: Buffer): Promise<void> {
  const plugins = [...index.plugins.filter(item => item.pluginId !== entry.pluginId), entry]
  if (plugins.length > MAX_SYNC_PLUGINS) throw new Error('云端插件数量超过限制')
  const head = await commit(session, index.repository, index.head, [
    { path: `${DIRECTORY}/${entry.pluginId}.json`, contents: bytes.toString('base64') },
    { path: MARKER, contents: marker(session, index.repository, plugins).toString('base64') },
  ], `Sync ${entry.pluginId}`)
  index.head = head; index.plugins = plugins
}
export async function downloadSnapshot(session: GithubSession, index: CloudIndex, entry: CloudPlugin): Promise<Buffer> {
  const { bytes } = await request(session, `${repoPath(session, index.repository.name)}/git/blobs/${entry.sha}`, undefined, entry.bytes)
  if (bytes.length !== entry.bytes || blobSha(bytes) !== entry.sha) throw new Error('快照与同步清单不匹配，不会覆盖本机数据。')
  return bytes
}
