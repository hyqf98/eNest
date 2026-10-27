import type { IpcMainInvokeEvent } from 'electron'
import { getTrustedSurfaceRole, handleShellIpc } from '@main/ipc/ipcSecurity'
import { listMcpTools } from '@main/mcp/mcpCatalog'
import { registerMcpPluginBridge } from '@main/mcp/mcpDispatcher'
import { mcpService } from '@main/mcp/mcpService'
import { IpcChannels } from '@shared/types/ipc'
import type { McpCatalogQuery, McpConfiguration } from '@shared/types/mcpSettings'

let registered = false

function assertNativeSettingsSender(event: IpcMainInvokeEvent): void {
  if (getTrustedSurfaceRole(event.sender.id) !== 'shell') throw new Error('IPC denied: MCP settings require the native shell')
}

export function registerMcpHandlers(): void {
  if (registered) return
  registered = true
  registerMcpPluginBridge()

  handleShellIpc(IpcChannels.ShellMcpStatus, event => {
    assertNativeSettingsSender(event)
    return mcpService.getStatus()
  })
  handleShellIpc(IpcChannels.ShellMcpConfigure, (event, input: McpConfiguration) => {
    assertNativeSettingsSender(event)
    return mcpService.configure(input)
  })
  handleShellIpc(IpcChannels.ShellMcpCopyConnection, event => {
    assertNativeSettingsSender(event)
    return mcpService.copyConnectionConfig()
  })
  handleShellIpc(IpcChannels.ShellMcpRotateToken, event => {
    assertNativeSettingsSender(event)
    return mcpService.rotateToken()
  })
  handleShellIpc(IpcChannels.ShellMcpCatalog, (event, query?: McpCatalogQuery) => {
    assertNativeSettingsSender(event)
    return listMcpTools(query)
  })
}
