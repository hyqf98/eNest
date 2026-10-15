import { callSshBackend } from './sshBackendClient'
import type { SshWorkbenchRequest } from '@shared/types/ssh-workbench'

export function sshWorkbenchPermission(action: string): 'ssh.exec' | 'ssh.sftp' | 'ssh.session' | undefined {
  if (['files.stat','files.read','files.write','files.renameBatch','files.copy','files.move','files.prepareDrag','transfer.upload','transfer.download','transfer.remoteCopy','transfer.list','transfer.cancel','transfer.retry'].includes(action)) return 'ssh.sftp'
  if (['auth.respond','config.import','trust.list','trust.remove','tunnel.list','tunnel.open','tunnel.close','shell.integrate'].includes(action)) return 'ssh.session'
  if (['system.snapshot','system.processes','system.ports','system.services','system.docker','process.signal','service.action','docker.action'].includes(action)) return 'ssh.exec'
  return undefined
}

export const sshWorkbench = (pluginId: string, request: SshWorkbenchRequest): Promise<unknown> => callSshBackend(pluginId, 'ssh.workbench', [request])
