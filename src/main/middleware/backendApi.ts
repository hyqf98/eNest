/** Compatibility RPC contract. Implementations and drivers belong to the plugin backend. */
import type { MwConnectionConfig, MwSessionInfo, MwTestResult } from '@shared/types/mw-workbench'

export interface MiddlewareBackendApi {
  mwOpen(pluginId: string, input: { sessionKey: string; config: MwConnectionConfig }): Promise<MwSessionInfo>
  mwTest(pluginId: string, config: MwConnectionConfig): Promise<MwTestResult>
  mwClose(pluginId: string, sessionKey: string): Promise<boolean>
}
