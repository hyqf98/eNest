import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/types/ipc'
import { assertSurfaceSender, getTrustedSurfaceRole } from '@main/ipc/ipcSecurity'
import { logWarn } from '@main/logs/logService'
import type { HomeAction } from '@shared/types/home'
import type { WorkspaceNavigationAck } from '@shared/types/workspace'
import { sendShellEvent } from '@main/window/createShellWindow'
import {
  bindHomeContents,
  getHomeCatalog,
  getHomeConfig,
  getHomeDetail,
  runHomeAction,
  searchHome,
  type HomeActionContext
} from './homeDataService'
import type { HomeSurfaceManager } from './HomeSurfaceManager'
import { normalizeWorkspaceRoute } from './workspaceRoute'

class HomeStateError extends Error {}

export function registerHomeIpc(manager: HomeSurfaceManager): void {
  manager.onContents(contents => bindHomeContents(contents, () => manager.isContentsActive(contents.id)))
  const handle = (channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      assertSurfaceSender(event, channel)
      try { return await listener(event, ...args) }
      catch (error) {
        if (error instanceof HomeStateError) throw error
        logWarn('home', `request ${channel} failed: ${error instanceof Error ? error.message : String(error)}`)
        throw new Error('Home request failed')
      }
    })
  }
  const contextFor = (event: { sender: Electron.WebContents }, requireActive = false): HomeActionContext => {
    const wcId = event.sender.id
    const generation = manager.getContentsGeneration(wcId)
    const activityRevision = requireActive ? manager.getContentsActivityRevision(wcId) : null
    const isCurrent = (): boolean => generation !== null && manager.getContentsGeneration(wcId) === generation && !event.sender.isDestroyed() && (!requireActive || manager.isContentsActive(wcId) && manager.getContentsActivityRevision(wcId) === activityRevision)
    return {
      wcId,
      generation: generation ?? -1,
      owner: event.sender,
      stateOwner: manager.getSearchStateOwner(wcId),
      isCurrent,
      setHomeVisible: visible => manager.setVisible(visible),
      navigateWorkspace: async route => {
        if (!isCurrent() || !manager.isContentsActive(wcId)) throw new HomeStateError('Home surface is not active')
        const target = normalizeWorkspaceRoute(route)
        sendShellEvent({ type: 'set-view', view: 'home' })
        await manager.navigate(target)
      }
    }
  }
  const assertCurrent = (context: HomeActionContext): void => {
    if (!context.isCurrent()) throw new HomeStateError('Home surface is retired')
  }
  const readCurrent = async <T>(event: { sender: Electron.WebContents }, read: () => T | Promise<T>): Promise<T> => {
    const context = contextFor(event)
    assertCurrent(context)
    const result = await read()
    assertCurrent(context)
    return result
  }
  handle(IpcChannels.HomeReady, (event, payload) => {
    assertCurrent(contextFor(event))
    manager.handleReady(event.sender.id, payload)
  })
  handle(IpcChannels.HomeAck, (event, payload: WorkspaceNavigationAck) => {
    assertCurrent(contextFor(event))
    manager.handleNavigationAck(event.sender.id, payload)
  })
  handle(IpcChannels.HomeGetAppearance, event => {
    assertCurrent(contextFor(event))
    return manager.getAppearanceForContents(event.sender.id)
  })
  handle(IpcChannels.HomeGetConfig, event => readCurrent(event, getHomeConfig))
  handle(IpcChannels.HomeGetCatalog, event => readCurrent(event, () => getHomeCatalog('boot')))
  handle(IpcChannels.HomeGetDetail, (event, id) => readCurrent(event, () => getHomeDetail(id)))
  handle(IpcChannels.HomeSearch, async (event, request) => {
    const context = contextFor(event, request?.phase === 'providers')
    assertCurrent(context)
    const result = await searchHome(request, context)
    assertCurrent(context)
    return result
  })
  handle(IpcChannels.HomeRefresh, (event, request) => readCurrent(event, () => getHomeCatalog(request?.reason === 'boot' ? 'boot' : 'manual')))
  handle(IpcChannels.HomeAction, async (event, action: HomeAction) => {
    const passive = action?.type === 'searchState' || action?.type === 'cancelSearch'
      || action?.type === 'searchInput' && action.operation !== 'read-clipboard'
    if ((!passive && !manager.isContentsActive(event.sender.id)) || getTrustedSurfaceRole(event.sender.id) !== 'home') {
      throw new HomeStateError('Home surface is not active')
    }
    const context = contextFor(event, !passive)
    assertCurrent(context)
    return runHomeAction(action, context)
  })
}
