/** A user-selected local file capability, scoped to the calling plugin. */
export interface LocalFileHandle {
  id: string
  name: string
  kind: 'file' | 'directory'
  size: number
  displayPath: string
}

export interface LocalFilePickOptions {
  kind?: 'file' | 'directory' | 'any'
  multiple?: boolean
  /** Read is the default; write selection explicitly grants content changes. */
  access?: 'read' | 'write'
}

export type PluginInputContext = 'workbench' | 'terminal' | 'editor' | 'overlay'
