import type { ShellApi } from '@shared/types/shellApi'
import { createLazyPreviewShellApi, createNativeShellApi } from './shellApiAdapters'

export type { ShellApi } from '@shared/types/shellApi'
export type { ShellSettingsData } from '@shared/types/shellSettings'

const rawShell = window.enestShell ?? window.enestQuickHost
export const shellApi: ShellApi = rawShell ? createNativeShellApi(rawShell)
  : import.meta.env.DEV
    ? createLazyPreviewShellApi(async () => (await import('@test/fixtures/browser-preview/mockShellApi')).createMockApi())
    : createNativeShellApi({})

export const isMockShell = import.meta.env.DEV && !rawShell
