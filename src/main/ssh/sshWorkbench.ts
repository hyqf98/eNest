import { createServer, createConnection, type Server, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { requireOwnedSshSession, sshWrite, sshRespondAuth } from '@main/ssh/sshSessionManager'
import { shellQuote, remotePlatform, systemSnapshot, listProcesses, listPorts, signalProcess, listServices, serviceAction, dockerOperation } from '@main/ssh/sshSystem'
import { fileInfo, readRemoteFile, writeRemoteFile, startTransfer, startRemoteCopy, listTransfers, cancelTransfer, retryTransfer, renameBatch, copyOrMoveRemote, prepareRemoteDrag } from '@main/ssh/sshFiles'
import { listTrustedHosts, removeTrustedHost } from '@main/ssh/sshTrust'
import { importSshConfig } from '@main/ssh/sshConfig'
import type { SshWorkbenchRequest } from '@shared/types/ssh-workbench'

export function sshWorkbenchPermission(action: string): 'ssh.exec' | 'ssh.sftp' | 'ssh.session' | undefined {
  if (['files.stat','files.read','files.write','files.renameBatch','files.copy','files.move','files.prepareDrag','transfer.upload','transfer.download','transfer.remoteCopy','transfer.list','transfer.cancel','transfer.retry'].includes(action)) return 'ssh.sftp'
  if (['auth.respond','config.import','trust.list','trust.remove','tunnel.list','tunnel.open','tunnel.close','shell.integrate'].includes(action)) return 'ssh.session'
  if (['system.snapshot','system.processes','system.ports','system.services','system.docker','process.signal','service.action','docker.action'].includes(action)) return 'ssh.exec'
  return undefined
}

interface Tunnel { id: string; pluginId: string; sessionId: string; direction: 'local' | 'remote'; localPort: number; remoteHost: string; remotePort: number; close: () => void }
const tunnels = new Map<string, Tunnel>()
function publicTunnel(t: Tunnel) { const { close: _close, pluginId: _pluginId, ...value } = t; return value }
async function openTunnel(pluginId: string, request: SshWorkbenchRequest) {
  const sessionId = String(request.sessionId || ''), session = requireOwnedSshSession(pluginId, sessionId)
  const assertCurrent = (): void => { if (requireOwnedSshSession(pluginId, sessionId) !== session || session.status !== 'connected') throw new Error('SSH 会话已关闭') }
  const localPort = Number(request.localPort), remotePort = Number(request.remotePort)
  const remoteHost = String(request.remoteHost || '127.0.0.1')
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535 || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535 || !remoteHost || /[\s\0]/.test(remoteHost)) throw new Error('隧道地址或端口无效')
  const sockets = new Set<Socket>(), id = randomUUID()
  let server: Server | undefined
  let closeExtra = (): void => {}
  const close = (): void => { server?.close(); closeExtra(); for (const socket of sockets) socket.destroy(); tunnels.delete(id); session.cleanup?.delete(close) }
  const direction = request.direction === 'remote' ? 'remote' : 'local'
  if (direction === 'local') {
    server = createServer(socket => {
      sockets.add(socket); socket.on('error', () => {}).on('close', () => sockets.delete(socket))
      session.client.forwardOut('127.0.0.1', socket.localPort || 0, remoteHost, remotePort, (error, channel) => {
        if (error) { socket.destroy(); return }
        try { assertCurrent() } catch { channel.destroy(); socket.destroy(); return }
        channel.on('error', () => socket.destroy()); socket.pipe(channel).pipe(socket)
      })
    })
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(localPort, '127.0.0.1', () => { server!.removeListener('error', reject); server!.on('error', () => close()); resolve() }) })
    try { assertCurrent() } catch (error) { close(); throw error }
  } else {
    // Reverse tunnels bind only to remote loopback; they never expose a public port.
    await new Promise<void>((resolve, reject) => session.client.forwardIn('127.0.0.1', remotePort, error => error ? reject(error) : resolve()))
    try { assertCurrent() } catch (error) { session.client.unforwardIn('127.0.0.1', remotePort, () => {}); throw error }
    const listener: Parameters<typeof session.client.on>[1] = (...args: unknown[]) => {
      const info = args[0] as { destPort: number }
      if (info.destPort !== remotePort) return
      try { assertCurrent() } catch { (args[2] as () => void)(); return }
      const accept = args[1] as () => import('ssh2').ClientChannel
      const channel = accept(), socket = createConnection({ host: '127.0.0.1', port: localPort })
      sockets.add(socket); socket.on('error', () => channel.destroy()).on('close', () => sockets.delete(socket))
      channel.on('error', () => socket.destroy()); socket.pipe(channel).pipe(socket)
    }
    session.client.on('tcp connection', listener as never)
    closeExtra = () => { session.client.removeListener('tcp connection', listener as never); session.client.unforwardIn('127.0.0.1', remotePort, () => {}) }
  }
  const tunnel: Tunnel = { id, pluginId, sessionId, direction, localPort, remoteHost, remotePort, close }
  tunnels.set(id, tunnel); session.cleanup ??= new Set(); session.cleanup.add(close)
  return publicTunnel(tunnel)
}

export const INTEGRATION = `if [ -n "$BASH_VERSION" ]; then
  __enest_prompt(){ __enest_code=$?; printf '\\033]133;D;%s\\007\\033]7;file://localhost%s\\007\\033]133;A\\007' "$__enest_code" "$PWD"; return "$__enest_code"; }
  if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a'* ]]; then
    case ";\${PROMPT_COMMAND[*]};" in *__enest_prompt*) ;; *) PROMPT_COMMAND=(__enest_prompt "\${PROMPT_COMMAND[@]}");; esac
  else
    case "$PROMPT_COMMAND" in *__enest_prompt*) ;; *) PROMPT_COMMAND="__enest_prompt\${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac
  fi
  case "$PS1" in *'133;B'*) ;; *) PS1="$PS1"'\\[\\e]133;B\\a\\]';; esac
  case "$PS0" in *'133;C'*) ;; *) PS0='\\e]133;C\\a'"$PS0";; esac
elif [ -n "$ZSH_VERSION" ]; then
  __enest_precmd(){ printf '\\033]133;D;%s\\007\\033]7;file://localhost%s\\007\\033]133;A\\007' "$?" "$PWD"; }
  __enest_preexec(){ printf '\\033]133;C\\007'; }
  typeset -ga precmd_functions preexec_functions
  (( \${precmd_functions[(Ie)__enest_precmd]} )) || precmd_functions+=(__enest_precmd)
  (( \${preexec_functions[(Ie)__enest_preexec]} )) || preexec_functions+=(__enest_preexec)
  [[ "$PROMPT" == *'133;B'* ]] || PROMPT="$PROMPT"$'%{\\e]133;B\\a%}'
fi`

export async function sshWorkbench(pluginId: string, request: SshWorkbenchRequest): Promise<unknown> {
  const action = String(request?.action || ''), sessionId = String(request?.sessionId || '')
  if (action === 'auth.respond') return sshRespondAuth(pluginId, String(request.id || ''), request.answers || null)
  if (action === 'config.import') return importSshConfig(pluginId, String(request.localHandleId || ''))
  if (action === 'trust.list') return listTrustedHosts(pluginId)
  if (action === 'trust.remove') { if (!request.confirmed) throw new Error('请先确认移除服务器信任'); return removeTrustedHost(pluginId, String(request.name || '')) }
  if (action === 'transfer.list') return listTransfers(pluginId)
  if (action === 'transfer.cancel') return cancelTransfer(pluginId, String(request.id || ''))
  if (action === 'transfer.retry') return retryTransfer(pluginId, String(request.id || ''), !!request.overwrite && !!request.confirmed, sessionId, request.operation === 'restart')
  if (action === 'tunnel.list') return [...tunnels.values()].filter(t => t.pluginId === pluginId).map(publicTunnel)
  if (action === 'tunnel.close') {
    const tunnel = tunnels.get(String(request.id || ''))
    if (!tunnel || tunnel.pluginId !== pluginId) throw new Error('隧道不存在')
    tunnel.close(); return true
  }
  requireOwnedSshSession(pluginId, sessionId)
  switch (action) {
    case 'system.snapshot': return systemSnapshot(pluginId, sessionId)
    case 'system.processes': return listProcesses(pluginId, sessionId)
    case 'system.ports': return listPorts(pluginId, sessionId)
    case 'system.services': return listServices(pluginId, sessionId)
    case 'system.docker': return dockerOperation(pluginId, sessionId, 'list')
    case 'process.signal':
      if (!request.confirmed) throw new Error('请先确认结束进程')
      return signalProcess(pluginId, sessionId, Number(request.pid), String(request.startTime || ''), request.signal === 'KILL' ? 'KILL' : 'TERM')
    case 'service.action':
      if (!request.confirmed) throw new Error('请先确认服务操作')
      return serviceAction(pluginId, sessionId, String(request.name || ''), String(request.operation || ''))
    case 'docker.action':
      if (!['logs', 'inspect'].includes(String(request.operation)) && !request.confirmed) throw new Error('请先确认容器操作')
      return dockerOperation(pluginId, sessionId, String(request.operation || ''), request.id)
    case 'shell.integrate': {
      if (await remotePlatform(pluginId, sessionId) === 'win32') throw new Error('Windows 终端使用原生 shell 补全；临时增强提示支持 Bash / Zsh')
      // Explicit UI action at an idle shell prompt. No user rc files are changed.
      sshWrite(pluginId, sessionId, 'eval ' + shellQuote(INTEGRATION) + '\r')
      return true
    }
    case 'files.stat': return fileInfo(pluginId, sessionId, String(request.path || '.'))
    case 'files.read': return readRemoteFile(pluginId, sessionId, String(request.path || ''))
    case 'files.write': return writeRemoteFile(pluginId, sessionId, request)
    case 'files.renameBatch': return renameBatch(pluginId, sessionId, request.entries || [])
    case 'files.copy': case 'files.move': return copyOrMoveRemote(pluginId, request)
    case 'files.prepareDrag': return prepareRemoteDrag(pluginId, request)
    case 'transfer.upload': case 'transfer.download': return startTransfer(pluginId, request)
    case 'transfer.remoteCopy': return startRemoteCopy(pluginId, request)
    case 'tunnel.open': return openTunnel(pluginId, request)
    default: throw new Error(`不支持的 SSH 操作：${action}`)
  }
}
