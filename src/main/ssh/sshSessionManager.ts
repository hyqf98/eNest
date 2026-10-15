/** Legacy SSH IPC facade. Protocol drivers and all session state live in the requesting plugin. */
import { callSshBackend, releaseSshBackend } from './sshBackendClient'
import { pickLocalFiles } from '@main/plugin/localFiles'
import type { LocalFileHandle, LocalFilePickOptions } from '@shared/types/local-files'
import type { SshConnectInput, SshSessionInfo, SshExecInput, SshExecResult, SshMetricsSample, SshCompletionResult, SftpListInput, SftpDownloadInput, SftpUploadInput, SftpEntry, SftpTransferResult } from '@shared/types/ssh-db'

export const sshConnect = (id: string, input: SshConnectInput): Promise<SshSessionInfo> => callSshBackend(id, 'ssh.connect', [input])
export const sshWrite = (id: string, sessionId: string, data: string): Promise<boolean> => callSshBackend(id, 'ssh.write', [sessionId, data])
export const sshResize = (id: string, sessionId: string, cols: number, rows: number): Promise<boolean> => callSshBackend(id, 'ssh.resize', [sessionId, cols, rows])
export const sshDisconnect = (id: string, sessionId: string): Promise<boolean> => callSshBackend(id, 'ssh.disconnect', [sessionId])
export const sshListSessions = (id: string): Promise<SshSessionInfo[]> => callSshBackend(id, 'ssh.listSessions', [])
export const sshExec = (id: string, input: SshExecInput): Promise<SshExecResult> => callSshBackend(id, 'ssh.exec', [input])
export const sshMetricsStart = (id: string, sessionId: string, intervalMs?: number): Promise<{ ok: boolean; intervalMs: number }> => callSshBackend(id, 'ssh.metrics.start', [sessionId, intervalMs])
export const sshMetricsStop = (id: string, sessionId: string): Promise<boolean> => callSshBackend(id, 'ssh.metrics.stop', [sessionId])
export const sshMetricsLatest = (id: string, sessionId: string): Promise<SshMetricsSample | null> => callSshBackend(id, 'ssh.metrics.latest', [sessionId])
export const sshCompletionSuggest = (id: string, input: { sessionId: string; line: string; cursor?: number; cwd?: string; history?: string[]; snippets?: Array<{ title: string; command: string }> }): Promise<SshCompletionResult> => callSshBackend(id, 'ssh.completion.suggest', [input])
export const sshSftpList = (id: string, input: SftpListInput): Promise<SftpEntry[]> => callSshBackend(id, 'ssh.sftp.list', [input])
export const sshSftpDownload = (id: string, input: SftpDownloadInput): Promise<SftpTransferResult> => callSshBackend(id, 'ssh.sftp.download', [input])
export const sshSftpUpload = (id: string, input: SftpUploadInput): Promise<SftpTransferResult> => callSshBackend(id, 'ssh.sftp.upload', [input])
export const sshSftpMkdir = (id: string, sessionId: string, path: string): Promise<boolean> => callSshBackend(id, 'ssh.sftp.mkdir', [sessionId, path])
export const sshSftpRename = (id: string, sessionId: string, path: string, newPath: string): Promise<boolean> => callSshBackend(id, 'ssh.sftp.rename', [sessionId, path, newPath])
export const sshSftpDelete = (id: string, sessionId: string, path: string, recursive?: boolean): Promise<boolean> => callSshBackend(id, 'ssh.sftp.delete', [sessionId, path, recursive])
export const sshSftpChmod = (id: string, sessionId: string, path: string, mode: string | number): Promise<boolean> => callSshBackend(id, 'ssh.sftp.chmod', [sessionId, path, mode])
export const sshPickLocalFile = async (id: string, options?: LocalFilePickOptions): Promise<LocalFileHandle | null> => (await pickLocalFiles(id, options))[0] ?? null
export const releaseSshSessions = releaseSshBackend
