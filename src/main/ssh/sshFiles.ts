import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, readdir, rename, rm, mkdtemp } from 'node:fs/promises'
import { basename, dirname, join, posix } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import type { SFTPWrapper, Stats } from 'ssh2'
import { getSftp, requireOwnedSshSession } from '@main/ssh/sshSessionManager'
import { resolveLocalFileHandle, createLocalExport } from '@main/plugin/localFiles'
import { acquirePluginActivity } from '@main/plugin/activityRegistry'
import type { SshFileInfo, SshTransferTask, SshWorkbenchRequest } from '@shared/types/ssh-workbench'

const EDIT_LIMIT = 2 * 1024 * 1024
interface Checkpoint { temporary: string; size: number; mtime: number; completed?: boolean }
interface Task extends SshTransferTask { pluginId: string; abort: AbortController; request?: SshWorkbenchRequest; checkpoints?: Map<string, Checkpoint>; peer?: string }
const tasks = new Map<string, Task>()
const slots = new Map<string, { active: number; waiting: Array<() => void> }>()
async function transferSlot(pluginId: string, signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted()
  const pool = slots.get(pluginId) || { active: 0, waiting: [] }
  slots.set(pluginId, pool)
  if (pool.active >= 3) await new Promise<void>((resolve, reject) => {
    const granted = (): void => { signal.removeEventListener('abort', aborted); resolve() }
    const aborted = (): void => { const index = pool.waiting.indexOf(granted); if (index >= 0) pool.waiting.splice(index, 1); reject(new Error('传输已取消')) }
    pool.waiting.push(granted); signal.addEventListener('abort', aborted, { once: true })
  })
  else pool.active++
  return () => { const next = pool.waiting.shift(); if (next) next(); else { pool.active--; if (!pool.active) slots.delete(pluginId) } }
}
export function safeFileName(name: string): string {
  if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name)) throw new Error('文件名不能包含路径分隔符')
  return name
}
const remoteStat = (sftp: SFTPWrapper, path: string): Promise<Stats> => new Promise((resolve, reject) => sftp.lstat(path, (e, s) => e ? reject(e) : resolve(s)))
const remoteEntries = (sftp: SFTPWrapper, path: string) => new Promise<Array<{ filename: string; attrs: Stats }>>((resolve, reject) => sftp.readdir(path, (e, list) => e ? reject(e) : resolve(list.filter(x => x.filename !== '.' && x.filename !== '..'))))
const remoteMkdir = (sftp: SFTPWrapper, path: string): Promise<void> => new Promise((resolve, reject) => sftp.mkdir(path, e => e ? reject(e) : resolve()))
const remoteRename = (sftp: SFTPWrapper, source: string, destination: string): Promise<void> => new Promise((resolve, reject) => sftp.rename(source, destination, e => e ? reject(e) : resolve()))
const remoteUnlink = (sftp: SFTPWrapper, path: string): Promise<void> => new Promise((resolve, reject) => sftp.unlink(path, e => e ? reject(e) : resolve()))
async function existsRemote(sftp: SFTPWrapper, path: string): Promise<Stats | null> {
  try { return await remoteStat(sftp, path) } catch (e) { if ((e as { code?: number }).code === 2) return null; throw e }
}
function publicTask(task: Task): SshTransferTask {
  const { pluginId: _pluginId, abort: _abort, request: _request, checkpoints: _checkpoints, peer: _peer, ...value } = task
  return { ...value, canRetry: !!task.request && ['failed','cancelled'].includes(task.status), resumable: !!task.checkpoints?.size && !!task.request && ['failed','cancelled'].includes(task.status) }
}
export function listTransfers(pluginId: string): SshTransferTask[] { return [...tasks.values()].filter(t => t.pluginId === pluginId).map(publicTask) }
export function cancelTransfer(pluginId: string, id: string): boolean {
  const task = tasks.get(id)
  if (!task || task.pluginId !== pluginId) throw new Error('传输任务不存在')
  if (task.status === 'running' || task.status === 'queued') task.abort.abort()
  return true
}
export async function retryTransfer(pluginId: string, id: string, overwrite = false, candidateSessionId?: string, restart = false): Promise<SshTransferTask> {
  const task = tasks.get(id)
  if (!task || task.pluginId !== pluginId || !task.request || !['failed', 'cancelled'].includes(task.status)) throw new Error('该任务不能重试，请重新选择文件')
  const request = { ...task.request, overwrite: overwrite || task.request.overwrite }
  if (task.peer) {
    try { requireOwnedSshSession(pluginId, task.sessionId) }
    catch {
      const current = requireOwnedSshSession(pluginId, candidateSessionId || '')
      if (`${current.username}@${current.host}:${current.port}` !== task.peer) throw new Error('请先重新连接原服务器，再继续传输')
      request.sessionId = current.sessionId
    }
  }
  // Claim this checkpoint before awaiting handle/SFTP resolution; duplicate retries cannot race.
  const originalRequest = task.request
  task.request = undefined
  try {
    if (restart && task.checkpoints) {
      const sftp = task.direction === 'upload' ? await getSftp(requireOwnedSshSession(pluginId, String(request.sessionId))) : undefined
      for (const checkpoint of task.checkpoints.values()) if (!checkpoint.completed) {
        if (sftp) await remoteUnlink(sftp, checkpoint.temporary).catch(() => {})
        else await rm(checkpoint.temporary, { force: true }).catch(() => {})
      }
      task.checkpoints.clear()
    }
    return request.action === 'transfer.remoteCopy' ? await startRemoteCopy(pluginId, request) : await startTransfer(pluginId, request, task.checkpoints)
  }
  catch (error) { task.request = originalRequest; throw error }
}

/** Server-to-server copy streams through the host without persisting file contents locally. */
export async function startRemoteCopy(pluginId: string, request: SshWorkbenchRequest): Promise<SshTransferTask> {
  const sourceId = String(request.sourceSessionId || ''), targetId = String(request.sessionId || '')
  const sourceSession = requireOwnedSshSession(pluginId, sourceId), targetSession = requireOwnedSshSession(pluginId, targetId)
  if (sourceId === targetId) throw new Error('同一会话请使用远程复制操作')
  const [sourceSftp, targetSftp] = await Promise.all([getSftp(sourceSession), getSftp(targetSession)])
  if (requireOwnedSshSession(pluginId, sourceId) !== sourceSession || requireOwnedSshSession(pluginId, targetId) !== targetSession) throw new Error('SSH 会话已关闭')
  const source = String(request.path || ''), destination = String(request.destination || '')
  if (!source || !destination) throw new Error('缺少来源或目标路径')
  const task: Task = { id: randomUUID(), pluginId, sessionId: targetId, direction: 'copy', source, destination, status: 'queued', transferred: 0, total: 0, startedAt: Date.now(), abort: new AbortController(), request: { ...request } }
  tasks.set(task.id, task)
  const release = acquirePluginActivity(pluginId, task.id, '跨服务器复制'), cancel = (): void => task.abort.abort()
  sourceSession.cleanup ??= new Set(); targetSession.cleanup ??= new Set()
  sourceSession.cleanup.add(cancel); targetSession.cleanup.add(cancel)
  const copy = async (from: string, to: string, depth = 0): Promise<void> => {
    task.abort.signal.throwIfAborted()
    if (depth > 64) throw new Error('目录层级超过 64 层')
    const stat = await remoteStat(sourceSftp, from), exists = await existsRemote(targetSftp, to)
    if (stat.isSymbolicLink()) throw new Error(`跨服务器不跟随符号链接：${from}`)
    if (stat.isDirectory()) {
      if (exists && !exists.isDirectory()) throw new Error(`目标类型冲突：${to}`)
      if (!exists) await remoteMkdir(targetSftp, to)
      for (const entry of await remoteEntries(sourceSftp, from)) await copy(posix.join(from, safeFileName(entry.filename)), posix.join(to, entry.filename), depth + 1)
    } else if (stat.isFile()) {
      if (exists && (!request.overwrite || !exists.isFile())) throw new Error(`目标已存在：${to}`)
      task.total += stat.size
      const temporary = `${to}.enest-${task.id}.part`
      try {
        const input = sourceSftp.createReadStream(from), output = targetSftp.createWriteStream(temporary, { flags: 'wx', mode: stat.mode & 0o777 })
        input.on('data', (chunk: Buffer | string) => { task.transferred += Buffer.byteLength(chunk) })
        await pipeline(input, output, { signal: task.abort.signal })
        const after = await remoteStat(sourceSftp, from)
        if (after.size !== stat.size || after.mtime !== stat.mtime) throw new Error(`复制期间来源已变化，请重试：${from}`)
        if (exists) await new Promise<void>((resolve, reject) => targetSftp.ext_openssh_rename(temporary, to, e => e ? reject(e) : resolve()))
        else await remoteRename(targetSftp, temporary, to)
      } finally { await remoteUnlink(targetSftp, temporary).catch(() => {}) }
    } else throw new Error(`不支持复制特殊文件：${from}`)
  }
  void (async () => {
    let releaseSlot = (): void => {}
    try { releaseSlot = await transferSlot(pluginId, task.abort.signal); task.abort.signal.throwIfAborted(); task.status = 'running'; await copy(source, destination); task.status = 'completed' }
    catch (error) { task.status = task.abort.signal.aborted ? 'cancelled' : 'failed'; task.error = (error as Error).message }
    finally { releaseSlot(); sourceSession.cleanup?.delete(cancel); targetSession.cleanup?.delete(cancel); release(); trimTasks(pluginId) }
  })()
  return publicTask(task)
}

export async function fileInfo(pluginId: string, sessionId: string, path: string): Promise<SshFileInfo> {
  const sftp = await getSftp(requireOwnedSshSession(pluginId, sessionId)), stats = await remoteStat(sftp, path)
  return { path, name: posix.basename(path), type: stats.isSymbolicLink() ? 'link' : stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : 'other', size: stats.size, mtime: stats.mtime * 1000, mode: stats.mode, uid: stats.uid, gid: stats.gid }
}
export async function readRemoteFile(pluginId: string, sessionId: string, path: string): Promise<{ content: string; mtime: number; hash: string }> {
  const sftp = await getSftp(requireOwnedSshSession(pluginId, sessionId)), stats = await remoteStat(sftp, path)
  if (!stats.isFile() || stats.size > EDIT_LIMIT) throw new Error('仅支持编辑不超过 2 MB 的普通文本文件；大文件请下载')
  const content = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0
    const stream = sftp.createReadStream(path)
    stream.on('data', (chunk: Buffer) => { size += chunk.length; if (size > EDIT_LIMIT) stream.destroy(new Error('文件已增长，超过编辑大小限制')); else chunks.push(chunk) })
    stream.on('error', reject).on('end', () => resolve(Buffer.concat(chunks)))
  })
  if (content.includes(0)) throw new Error('这是二进制文件，请下载后打开')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(content)
  return { content: text, mtime: stats.mtime * 1000, hash: createHash('sha256').update(content).digest('hex') }
}
export async function writeRemoteFile(pluginId: string, sessionId: string, request: SshWorkbenchRequest): Promise<{ hash: string }> {
  const path = String(request.path || ''), content = String(request.content ?? '')
  if (!path || Buffer.byteLength(content) > EDIT_LIMIT) throw new Error('文件路径为空或内容超过 2 MB')
  const sftp = await getSftp(requireOwnedSshSession(pluginId, sessionId)), previous = await existsRemote(sftp, path)
  if (previous && !previous.isFile()) throw new Error('目标不是普通文件')
  if (previous && request.expectedHash) {
    const latest = await readRemoteFile(pluginId, sessionId, path)
    if (latest.hash !== request.expectedHash) throw new Error('服务器上的文件已被修改，请重新加载后合并修改')
  } else if (previous && !request.overwrite) throw new Error('文件已存在')
  const temporary = `${path}.enest-${randomUUID()}.tmp`
  try {
    await new Promise<void>((resolve, reject) => {
      const stream = sftp.createWriteStream(temporary, { mode: previous ? previous.mode & 0o777 : 0o600 })
      stream.on('error', reject).on('close', () => resolve())
      stream.end(content, 'utf8')
    })
    if (previous) {
      await new Promise<void>((resolve, reject) => sftp.ext_openssh_rename(temporary, path, e => e ? reject(new Error(`服务器不支持原子替换，原文件未修改：${e.message}`)) : resolve()))
    } else await remoteRename(sftp, temporary, path)
    return { hash: createHash('sha256').update(content).digest('hex') }
  } finally { await remoteUnlink(sftp, temporary).catch(() => {}) }
}

/** Directory transfers preserve the source and never follow symlinks. */
export async function startTransfer(pluginId: string, request: SshWorkbenchRequest, checkpoints = new Map<string, Checkpoint>()): Promise<SshTransferTask> {
  const sessionId = String(request.sessionId || ''), session = requireOwnedSshSession(pluginId, sessionId)
  const sftp = await getSftp(session), upload = request.action === 'transfer.upload'
  const local = await resolveLocalFileHandle(pluginId, String(request.localHandleId || ''), upload ? 'read' : 'write')
  if (requireOwnedSshSession(pluginId, sessionId) !== session || session.status !== 'connected') throw new Error('SSH 会话已关闭')
  const remote = String(upload ? request.destination : request.path)
  if (!remote || remote === 'undefined') throw new Error('缺少远程路径')
  const targetLocal = upload ? '' : join(local, safeFileName(posix.basename(remote)))
  const task: Task = { id: randomUUID(), pluginId, sessionId, direction: upload ? 'upload' : 'download', source: upload ? local : remote, destination: upload ? remote : targetLocal, status: 'queued', transferred: 0, total: 0, startedAt: Date.now(), abort: new AbortController(), request: { ...request }, checkpoints, peer: `${session.username}@${session.host}:${session.port}` }
  tasks.set(task.id, task)
  const release = acquirePluginActivity(pluginId, task.id, upload ? '上传文件' : '下载文件')
  const cancel = (): void => task.abort.abort()
  session.cleanup ??= new Set(); session.cleanup.add(cancel)
  void (async () => {
    let releaseSlot = (): void => {}
    try {
      releaseSlot = await transferSlot(pluginId, task.abort.signal)
      task.abort.signal.throwIfAborted()
      task.status = 'running'
      if (upload) await uploadPath(sftp, local, remote, task, !!request.overwrite)
      else await downloadPath(sftp, remote, targetLocal, task, !!request.overwrite)
      task.status = 'completed'
      task.checkpoints?.clear()
    } catch (error) { task.status = task.abort.signal.aborted ? 'cancelled' : 'failed'; task.error = (error as Error).message }
    finally { releaseSlot(); session.cleanup?.delete(cancel); release(); trimTasks(pluginId) }
  })()
  return publicTask(task)
}
function trimTasks(pluginId: string): void {
  const complete = [...tasks.values()].filter(x => x.pluginId === pluginId && x.status !== 'running' && x.status !== 'queued')
  for (const t of complete.slice(0, Math.max(0, complete.length - 100))) tasks.delete(t.id)
}
async function hashReadable(stream: Readable, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256'), aborted = (): void => { stream.destroy(new Error('传输已取消')) }
  signal.throwIfAborted(); signal.addEventListener('abort', aborted, { once: true })
  try { for await (const chunk of stream) { signal.throwIfAborted(); hash.update(chunk) }; return hash.digest('hex') }
  finally { signal.removeEventListener('abort', aborted) }
}
async function verifyPrefix(sftp: SFTPWrapper, remote: string, local: string, size: number, task: Task): Promise<void> {
  if (!size) return
  const [remoteHash, localHash] = await Promise.all([
    hashReadable(sftp.createReadStream(remote, { start: 0, end: size - 1 }), task.abort.signal),
    hashReadable(createReadStream(local, { start: 0, end: size - 1 }), task.abort.signal)
  ])
  if (remoteHash !== localHash) throw new Error('续传校验不一致，来源或临时文件已变化；请重新开始')
}
function checkpointFor(task: Task, key: string, destination: string, size: number, mtime: number): Checkpoint {
  task.checkpoints ??= new Map()
  let checkpoint = task.checkpoints.get(key)
  if (checkpoint && (checkpoint.size !== size || checkpoint.mtime !== mtime)) throw new Error('来源文件已变化，不能使用原断点；请重新开始')
  if (!checkpoint) { checkpoint = { temporary: `${destination}.enest-${task.id}.part`, size, mtime }; task.checkpoints.set(key, checkpoint) }
  return checkpoint
}
async function uploadPath(sftp: SFTPWrapper, source: string, destination: string, task: Task, overwrite: boolean): Promise<void> {
  task.abort.signal.throwIfAborted()
  const stat = await lstat(source), existing = await existsRemote(sftp, destination)
  if (stat.isSymbolicLink()) throw new Error(`符号链接未上传：${basename(source)}`)
  if (stat.isDirectory()) {
    if (existing && !existing.isDirectory()) throw new Error(`目标类型冲突：${destination}`)
    if (!existing) await remoteMkdir(sftp, destination)
    for (const name of await readdir(source)) await uploadPath(sftp, join(source, name), posix.join(destination, safeFileName(name)), task, overwrite)
    return
  }
  if (!stat.isFile()) throw new Error(`不支持的文件类型：${source}`)
  const key = `${source}=>${destination}`, checkpoint = checkpointFor(task, key, destination, stat.size, stat.mtimeMs)
  task.total += stat.size
  if (checkpoint.completed) {
    if (!existing?.isFile() || existing.size !== stat.size) throw new Error('已传输的目标文件发生变化，请重新开始')
    await verifyPrefix(sftp, destination, source, stat.size, task); task.transferred += stat.size; return
  }
  if (existing && (!overwrite || !existing.isFile())) throw new Error(`目标已存在：${destination}`)
  const temporary = checkpoint.temporary, part = await existsRemote(sftp, temporary)
  if (part && (!part.isFile() || part.size > stat.size)) throw new Error('续传临时文件异常，请重新开始')
  const offset = part?.size || 0
  await verifyPrefix(sftp, temporary, source, offset, task)
  task.transferred += offset
  try {
    if (offset < stat.size || !part) {
      const input = createReadStream(source, { start: offset }), output = sftp.createWriteStream(temporary, { flags: part ? 'r+' : 'wx', start: offset, mode: stat.mode & 0o777 })
      input.on('data', (chunk: Buffer | string) => { task.transferred += Buffer.byteLength(chunk) })
      await pipeline(input, output, { signal: task.abort.signal })
    }
    task.abort.signal.throwIfAborted()
    const after = await lstat(source)
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('上传期间来源文件已变化，请重新开始')
    if (existing) await new Promise<void>((resolve, reject) => sftp.ext_openssh_rename(temporary, destination, e => e ? reject(e) : resolve()))
    else await remoteRename(sftp, temporary, destination)
    checkpoint.completed = true
  } finally { if (checkpoint.completed || !task.request) await remoteUnlink(sftp, temporary).catch(() => {}) }
}
async function downloadPath(sftp: SFTPWrapper, source: string, destination: string, task: Task, overwrite: boolean): Promise<void> {
  task.abort.signal.throwIfAborted()
  const stat = await remoteStat(sftp, source)
  const existing = await lstat(destination).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e })
  if (stat.isSymbolicLink()) throw new Error(`符号链接未下载：${source}`)
  if (existing?.isSymbolicLink()) throw new Error(`目标是符号链接：${destination}`)
  if (stat.isDirectory()) {
    if (existing && !existing.isDirectory()) throw new Error(`目标类型冲突：${destination}`)
    await mkdir(destination, { recursive: true })
    for (const entry of await remoteEntries(sftp, source)) await downloadPath(sftp, posix.join(source, safeFileName(entry.filename)), join(destination, entry.filename), task, overwrite)
    return
  }
  if (!stat.isFile()) throw new Error(`不支持的文件类型：${source}`)
  const key = `${source}=>${destination}`, checkpoint = checkpointFor(task, key, destination, stat.size, stat.mtime)
  task.total += stat.size
  if (checkpoint.completed) {
    if (!existing?.isFile() || existing.size !== stat.size) throw new Error('已传输的目标文件发生变化，请重新开始')
    await verifyPrefix(sftp, source, destination, stat.size, task); task.transferred += stat.size; return
  }
  if (existing && (!overwrite || !existing.isFile())) throw new Error(`目标已存在：${destination}`)
  await mkdir(dirname(destination), { recursive: true })
  const temporary = checkpoint.temporary, part = await lstat(temporary).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e })
  if (part && (!part.isFile() || part.isSymbolicLink() || part.size > stat.size)) throw new Error('续传临时文件异常，请重新开始')
  const offset = part?.size || 0
  await verifyPrefix(sftp, source, temporary, offset, task)
  task.transferred += offset
  try {
    if (offset < stat.size || !part) {
      const input = sftp.createReadStream(source, { start: offset }), output = createWriteStream(temporary, { flags: part ? 'r+' : 'wx', start: offset, mode: stat.mode & 0o777 })
      input.on('data', (chunk: Buffer | string) => { task.transferred += Buffer.byteLength(chunk) })
      await pipeline(input, output, { signal: task.abort.signal })
    }
    task.abort.signal.throwIfAborted()
    const after = await remoteStat(sftp, source)
    if (after.size !== stat.size || after.mtime !== stat.mtime) throw new Error('下载期间来源文件已变化，请重新开始')
    await rename(temporary, destination); checkpoint.completed = true
  } finally { if (checkpoint.completed || !task.request) await rm(temporary, { force: true }).catch(() => {}) }
}
export async function prepareRemoteDrag(pluginId: string, request: SshWorkbenchRequest): Promise<{ exportId: string }> {
  const sessionId = String(request.sessionId || ''), session = requireOwnedSshSession(pluginId, sessionId), sftp = await getSftp(session)
  const directory = await mkdtemp(join(tmpdir(), 'enest-ssh-drag-')), paths: string[] = []
  const release = acquirePluginActivity(pluginId, directory, '准备拖出文件')
  try {
    if (requireOwnedSshSession(pluginId, sessionId) !== session || session.status !== 'connected') throw new Error('SSH 会话已关闭')
    for (const source of request.paths || []) {
      const destination = join(directory, safeFileName(posix.basename(source)))
      const task: Task = { id: randomUUID(), pluginId, sessionId, direction: 'download', source, destination, status: 'running', transferred: 0, total: 0, startedAt: Date.now(), abort: new AbortController() }
      tasks.set(task.id, task)
      const cancel = (): void => task.abort.abort()
      session.cleanup ??= new Set(); session.cleanup.add(cancel)
      try { await downloadPath(sftp, source, destination, task, false); task.status = 'completed' }
      catch (e) { task.status = task.abort.signal.aborted ? 'cancelled' : 'failed'; task.error = (e as Error).message; throw e }
      finally { session.cleanup?.delete(cancel) }
      paths.push(destination)
    }
    if (!paths.length) throw new Error('请选择文件')
    const result = await createLocalExport(pluginId, paths)
    const cleanup = setTimeout(() => { void rm(directory, { recursive: true, force: true }).catch(() => {}) }, 60 * 60 * 1000)
    cleanup.unref()
    return result
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
  finally { release() }
}
export async function renameBatch(pluginId: string, sessionId: string, entries: Array<{ path: string; name: string }>): Promise<Array<{ path: string; newPath: string; error?: string }>> {
  const sftp = await getSftp(requireOwnedSshSession(pluginId, sessionId)), targets = new Set<string>()
  for (const entry of entries) {
    const target = posix.join(posix.dirname(entry.path), safeFileName(entry.name))
    if (targets.has(target)) throw new Error('批量名称重复')
    targets.add(target)
    if (target !== entry.path && await existsRemote(sftp, target)) throw new Error(`目标已存在：${target}`)
  }
  const results: Array<{ path: string; newPath: string; error?: string }> = []
  for (const entry of entries) {
    const newPath = posix.join(posix.dirname(entry.path), entry.name)
    try { if (entry.path !== newPath) await remoteRename(sftp, entry.path, newPath); results.push({ path: entry.path, newPath }) }
    catch (e) { results.push({ path: entry.path, newPath, error: (e as Error).message }) }
  }
  return results
}

export async function copyOrMoveRemote(pluginId: string, request: SshWorkbenchRequest): Promise<Array<{ path: string; destination: string; error?: string }>> {
  const sessionId = String(request.sessionId || ''), sftp = await getSftp(requireOwnedSshSession(pluginId, sessionId)), destination = String(request.destination || '')
  if (!destination || !(await remoteStat(sftp, destination)).isDirectory()) throw new Error('请选择目标文件夹')
  const canonicalDestination = await new Promise<string>((resolve, reject) => sftp.realpath(destination, (e, p) => e ? reject(e) : resolve(p)))
  const results: Array<{ path: string; destination: string; error?: string }> = []
  const copy = async (source: string, target: string, depth = 0): Promise<void> => {
    if (depth > 64) throw new Error('目录层级过深')
    if (await existsRemote(sftp, target)) throw new Error(`目标已存在：${target}`)
    const stat = await remoteStat(sftp, source)
    if (stat.isSymbolicLink()) {
      const link = await new Promise<string>((resolve, reject) => sftp.readlink(source, (e, p) => e ? reject(e) : resolve(p)))
      await new Promise<void>((resolve, reject) => sftp.symlink(link, target, e => e ? reject(e) : resolve()))
    } else if (stat.isDirectory()) {
      await remoteMkdir(sftp, target)
      for (const entry of await remoteEntries(sftp, source)) await copy(posix.join(source, safeFileName(entry.filename)), posix.join(target, entry.filename), depth + 1)
    } else if (stat.isFile()) await pipeline(sftp.createReadStream(source), sftp.createWriteStream(target, { flags: 'wx', mode: stat.mode & 0o777 }))
    else throw new Error('不支持复制特殊文件')
  }
  const release = acquirePluginActivity(pluginId, randomUUID(), '远程文件操作')
  try {
    const paths = [...new Set(request.paths || [])].filter(p => !(request.paths || []).some(parent => parent !== p && p.startsWith(parent.replace(/\/$/, '') + '/')))
    for (const source of paths) {
      const target = posix.join(destination, safeFileName(posix.basename(source)))
      try {
        const canonicalSource = await new Promise<string>((resolve, reject) => sftp.realpath(source, (e, p) => e ? reject(e) : resolve(p)))
        if (canonicalDestination === canonicalSource || canonicalDestination.startsWith(canonicalSource.replace(/\/$/, '') + '/')) throw new Error('不能移动或复制到自身或其子目录')
        if (request.action === 'files.move') {
          if (await existsRemote(sftp, target)) throw new Error('目标已存在')
          await remoteRename(sftp, source, target)
        } else await copy(source, target)
        results.push({ path: source, destination: target })
      } catch (e) { results.push({ path: source, destination: target, error: (e as Error).message }) }
    }
  } finally { release() }
  return results
}
