/** Main-process-only companion to the opt-in runner; no renderer injection, test IPC or globals. */
import { app, BaseWindow, webContents } from 'electron'
import { performance } from 'node:perf_hooks'
import { cpus, freemem, release, totalmem } from 'node:os'
import { writeFileSync } from 'node:fs'
import { pluginHost } from '@main/plugin/PluginHost'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { installFromFolder } from '@main/plugin/PluginInstaller'
import { getPluginDiagnostics } from '@main/plugin/pluginDiagnostics'
import { getPluginMemoryDiagnosticSnapshot } from '@main/plugin/pluginMemoryMonitor'
import { getMainWindow, getShellWebContents, sendShellEvent } from '@main/window/createShellWindow'
import { homeSurfaceManager } from '@main/home/HomeSurfaceManager'
import { settingsStore } from '@main/settings/SettingsStore'
import { getAppPaths } from '@main/paths/pathsService'
import { requiresUserConsent } from '@shared/pluginPermissionPolicy'
import { PLUGIN_ALIVE_LIMIT } from '@shared/constants'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const sum = rows => rows.some(value => value === null) ? null : rows.reduce((total, value) => total + value, 0)
const identity = (pid, startedAt) => startedAt === null ? null : `${pid}:${startedAt}`
const errorText = error => error instanceof Error ? error.stack || error.message : String(error)
async function waitFor(predicate, label, timeoutMs = 20_000) {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${label}`)
    await sleep(80)
  }
}

function counters(diagnostics) {
  const host = diagnostics.host
  return {
    host: { opening: host.opening, closing: host.closing, retiring: host.retiring, logicalTabs: host.logicalTabs,
      live: host.entries.length, hibernated: host.hibernated, coldShellTabs: host.coldShellTabs,
      lazyDetached: host.lazyDetached, restoringDetached: host.restoringDetached, tabPresentations: host.tabPresentations },
    entries: host.entries.map(row => ({ pluginId: row.pluginId, generation: row.generation, wcId: row.wcId, state: row.state, container: row.container })),
    resources: diagnostics.resources.map(row => ({ pluginId: row.pluginId, generation: row.generation, wcId: row.wcId,
      closing: row.closing, resources: row.resources, activities: row.activities.length })),
    utilities: diagnostics.utilities.map(row => ({ pluginId: row.pluginId, generation: row.generation, pid: row.pid,
      closing: row.closing, pending: row.pending, hostRequests: row.hostRequests })),
    backgrounds: diagnostics.backgrounds.map(row => ({ pluginId: row.pluginId, generation: row.generation, wcId: row.wcId,
      ready: row.ready, pending: row.pending, hostRequests: row.hostRequests })),
    auxiliary: { ...diagnostics.auxiliary }, streams: { ...diagnostics.streams },
    session: { ...diagnostics.session }, storage: { cacheBytes: diagnostics.localStorage.cacheBytes,
      dirtyBytes: diagnostics.localStorage.dirtyBytes, dirtyKeys: diagnostics.localStorage.dirtyKeys, plugins: diagnostics.localStorage.plugins },
    caches: diagnostics.caches, assets: diagnostics.assets,
    webContents: webContents.getAllWebContents().filter(wc => !wc.isDestroyed()).map(wc => ({ id: wc.id, type: wc.getType() })),
    windows: BaseWindow.getAllWindows().filter(win => !win.isDestroyed()).map(win => ({ id: win.id, visible: win.isVisible(), focused: win.isFocused() }))
  }
}

function noTransientResources(diagnostics) {
  return !diagnostics.host.opening && !diagnostics.host.closing && !diagnostics.host.retiring &&
    !diagnostics.host.logicalTabs && !diagnostics.host.entries.length && !diagnostics.host.hibernated &&
    !diagnostics.host.tabPresentations && !diagnostics.resources.length && !diagnostics.utilities.length &&
    !diagnostics.backgrounds.length && !diagnostics.auxiliary.windows && !diagnostics.auxiliary.reservedSlots &&
    !diagnostics.streams.streams && !diagnostics.streams.queuedBytes
}

export async function runNativePerformanceProbe(config, runtime) {
  const started = performance.now(), observedPluginContents = new Set(), checks = []
  const report = { schemaVersion: 1, label: config.label, status: 'running', passed: false, measuredAt: new Date().toISOString(),
    environment: { platform: process.platform, arch: process.arch, osRelease: release(), appVersion: app.getVersion(),
      electron: process.versions.electron, expectedElectron: config.expectedElectron, chromium: process.versions.chrome,
      node: process.versions.node, logicalCpus: cpus().length, totalSystemMemoryBytes: totalmem() },
    isolation: { freshHome: true, freshUserData: true, freshSessionData: true, freshDataRoot: true,
      sensitivePermissionPolicy: 'All declared sensitive capabilities explicitly denied; no permission granted',
      hostHttpFetchBlocked: true, sessionHttpAndWebSocketBlocked: true, clipboardOrScreenOperations: false,
      accountOrConnectionOperations: false, probeRendererEvaluationOrCdp: false, guiAutomation: false },
    scope: 'Actual src/main/index.ts plus same-bundle main-process probe, real installed built renderer/preloads, real installer and PluginHost methods. Not a GUI gesture or business-feature acceptance.',
    limitations: ['No before/after performance gain is inferred from a single run.',
      'Window visibility and actual native load events are observed; no DOM readiness, screenshot correctness, frame time or FPS is asserted.',
      'Eight logical tabs remain subject to the unchanged production resident limit; hibernated tabs are not counted as resident renderers.',
      'Offline restrictions compose with each production Session request policy and block host global fetch; these are temporary transport guards, not an OS firewall. No plugin native backend or sensitive capability is exercised.',
      'The real boot still enumerates system applications and the isolated HOME/Applications directory; its app list and paths are not exported.',
      'OS sampling includes process identity metadata for attribution; only this app-owned process measurements are exported.',
      'Cache/session/storage byte retention is reported separately from live resource leaks; RSS and footprint are never silently equated.'],
    policy: { residentLimit: PLUGIN_ALIVE_LIMIT, samplesPerStage: config.sampleCount, intervalMs: config.sampleIntervalMs,
      cpu: 'Delta cumulativeCPUUsage seconds over monotonic wall time; both samples require the same PID and non-null Electron creationTime, and current OS start identity must match.',
      memory: 'One row per unique app-owned PID. metric=footprint is macOS phys_footprint; unavailable/fallback metrics remain explicit.' },
    provenance: { main: 'src/main/index.ts', serviceStubs: false, builtArtifacts: config.artifacts },
    installed: [], stages: [], operations: [], checks, shutdown: { requested: false, completed: false } }
  const save = () => writeFileSync(config.report, JSON.stringify(report, null, 2), { mode: 0o600 })
  const check = (name, pass, detail) => { checks.push({ name, pass: Boolean(pass), ...(detail === undefined ? {} : { detail }) }); return Boolean(pass) }
  const contextCounts = () => ({ ...runtime.network, nativeFailures: runtime.failures.length })
  let sequence = 0

  async function snapshot(previous) {
    const collectionStarted = performance.now(), memory = await getPluginMemoryDiagnosticSnapshot()
    const diagnostics = getPluginDiagnostics(), sampledMono = performance.now()
    const metrics = new Map(diagnostics.processes.map(row => [row.pid, row])), unique = new Map()
    for (const row of memory.processes) {
      if (unique.has(row.pid)) throw new Error('Memory diagnostic returned a duplicate PID')
      unique.set(row.pid, row)
    }
    const old = new Map(previous?.processes.map(row => [identity(row.pid, row.cpuCreatedAt), row]).filter(([key]) => key) || [])
    const intervalMs = previous ? sampledMono - previous.monotonicMs : null
    const processes = [...unique.values()].map(row => {
      const metric = metrics.get(row.pid), cpuCreatedAt = nonnegative(metric?.creationTime), startedAt = nonnegative(row.startedAt)
      // A resident/unavailable row may substitute Electron creationTime for missing OS metadata.
      // Only native/private/footprint or Linux proc samples prove an independent OS identity.
      const osIdentityVerified = ['footprint', 'private', 'resident-swap'].includes(row.metric)
      const matchingOsIdentity = osIdentityVerified && cpuCreatedAt !== null && startedAt !== null && startedAt > 0 && Math.abs(cpuCreatedAt - startedAt) < 1100
      const cumulative = matchingOsIdentity ? nonnegative(metric?.cpu.cumulativeCPUUsage) : null
      const before = old.get(identity(row.pid, cpuCreatedAt))
      const deltaSeconds = before && before.startedAt === startedAt && cumulative !== null && before.cpuCumulativeSeconds !== null && cumulative >= before.cpuCumulativeSeconds
        ? cumulative - before.cpuCumulativeSeconds : null
      return { pid: row.pid, startedAt, kind: row.kind, pluginIds: [...row.pluginIds], shared: row.shared,
        metric: row.metric, memoryBytes: nonnegative(row.memoryBytes), residentBytes: nonnegative(row.residentBytes),
        electronType: metric?.type || null, osIdentityVerified, cpuCreatedAt, cpuCumulativeSeconds: cumulative, cpuDeltaSeconds: deltaSeconds,
        cpuOneCorePercent: deltaSeconds !== null && intervalMs !== null && intervalMs > 0 ? deltaSeconds * 100000 / intervalMs : null }
    }).sort((a, b) => a.pid - b.pid)
    const footprint = processes.filter(row => row.metric === 'footprint')
    const measuredCpu = processes.filter(row => row.cpuDeltaSeconds !== null)
    const result = { sequence: ++sequence, sampledAt: Date.now(), monotonicMs: sampledMono, elapsedMs: sampledMono - started,
      collectionMs: performance.now() - collectionStarted, memorySampledAt: memory.sampledAt, memoryError: Boolean(memory.error),
      systemFreeMemoryBytes: freemem(), uniquePIDCount: unique.size,
      memory: { totalBytes: sum(processes.map(row => row.memoryBytes)), knownBytes: processes.reduce((total, row) => total + (row.memoryBytes ?? 0), 0),
        physFootprintBytes: footprint.length === processes.length ? sum(footprint.map(row => row.memoryBytes)) : null,
        knownPhysFootprintBytes: footprint.reduce((total, row) => total + (row.memoryBytes ?? 0), 0), footprintProcesses: footprint.length,
        fallbackProcesses: processes.filter(row => !['footprint', 'unavailable'].includes(row.metric)).length,
        unavailableProcesses: processes.filter(row => row.memoryBytes === null).length,
        metricCounts: Object.fromEntries([...new Set(processes.map(row => row.metric))].map(type => [type, processes.filter(row => row.metric === type).length])),
        hostBytes: sum(processes.filter(row => !row.pluginIds.length).map(row => row.memoryBytes)),
        pluginProcessBytes: sum(processes.filter(row => row.pluginIds.length).map(row => row.memoryBytes)) },
      cpu: { intervalMs, measuredProcesses: measuredCpu.length, unavailableProcesses: processes.length - measuredCpu.length,
        knownDeltaSeconds: measuredCpu.length ? measuredCpu.reduce((total, row) => total + row.cpuDeltaSeconds, 0) : null,
        totalOneCorePercent: measuredCpu.length === processes.length ? sum(processes.map(row => row.cpuOneCorePercent)) : null,
        knownOneCorePercent: measuredCpu.length ? measuredCpu.reduce((total, row) => total + row.cpuOneCorePercent, 0) : null },
      processes, diagnostics: counters(diagnostics), harness: contextCounts() }
    return result
  }

  async function stage(name) {
    const row = { name, startedAt: Date.now(), settleMs: 1100, samples: [] }
    report.stages.push(row)
    // The production sampler reuses snapshots for 1s. Do not attribute a prior stage's PIDs.
    await sleep(row.settleMs)
    for (let index = 0; index < config.sampleCount; index++) {
      if (index) await sleep(config.sampleIntervalMs)
      const value = await snapshot(row.samples.at(-1))
      if (value.memorySampledAt < row.startedAt) throw new Error(`Stale native memory snapshot in ${name}`)
      row.samples.push(value)
      save()
    }
    row.completedAt = Date.now()
    console.log(`[real-app-performance] stage=${name} samples=${row.samples.length} live=${row.samples.at(-1).diagnostics.host.live} uniquePIDs=${row.samples.at(-1).uniquePIDCount}`)
    return row.samples.at(-1)
  }

  async function openLoaded(pluginId) {
    const begin = performance.now()
    homeSurfaceManager.setVisible(false)
    sendShellEvent({ type: 'set-view', view: 'plugin' })
    await pluginHost.openPlugin(pluginId, undefined, { container: 'shell' })
    await waitFor(() => ['active', 'ready', 'background'].includes(pluginHost.getState(pluginId)), `${pluginId} native did-finish-load`)
    const wc = pluginHost.getWebContents(pluginId)
    if (!wc || wc.isDestroyed() || wc.isLoadingMainFrame()) throw new Error(`Plugin did not finish a native load: ${pluginId}`)
    const preferences = wc.getLastWebPreferences()
    if (!preferences.sandbox || !preferences.contextIsolation || preferences.nodeIntegration) throw new Error(`Unsafe renderer preferences: ${pluginId}`)
    observedPluginContents.add(wc.id)
    const operation = { type: 'open', pluginId, wcId: wc.id, generation: pluginHost.getDiagnostics().entries.find(row => row.pluginId === pluginId)?.generation,
      nativeLoadMs: performance.now() - begin, sandbox: true, contextIsolation: true, nodeIntegration: false }
    report.operations.push(operation)
    return operation
  }

  async function closeAll(ids) {
    pluginHost.hideAllViews()
    const before = getPluginDiagnostics()
    report.operations.push({ type: 'before-close-batch', diagnostics: counters(before) })
    for (const pluginId of [...ids].reverse()) {
      const wc = pluginHost.getWebContents(pluginId), wcId = wc?.id || null, begin = performance.now()
      const completion = pluginHost.closePlugin(pluginId)
      const logicalDetachMs = performance.now() - begin
      await completion
      report.operations.push({ type: 'close', pluginId, wcId, hadRenderer: Boolean(wcId), logicalDetachMs,
        completionMs: performance.now() - begin, destroyed: !wc || wc.isDestroyed() })
    }
    await waitFor(() => noTransientResources(getPluginDiagnostics()), 'host/runtime/backend/background/auxiliary/stream cleanup', 15_000)
    homeSurfaceManager.setVisible(true)
    sendShellEvent({ type: 'set-view', view: 'home' })
    const remaining = [...observedPluginContents].filter(id => webContents.fromId(id))
    check('all-observed-plugin-webcontents-destroyed', !remaining.length, { remaining })
  }

  app.once('will-quit', () => {
    report.shutdown.completed = true
    report.shutdown.final = counters(getPluginDiagnostics())
    report.shutdown.harness = contextCounts()
    report.nativeWebContents = [...runtime.created.values()]
    check('real-app-quit-resource-cleanup', noTransientResources(getPluginDiagnostics()))
    report.passed = report.status === 'complete' && checks.every(row => row.pass) && !runtime.failures.length
    save()
  })
  try {
    await app.whenReady()
    await waitFor(() => getMainWindow() && getShellWebContents() && !getShellWebContents().isLoadingMainFrame() &&
      homeSurfaceManager.getState().status === 'ready', 'real shell and default Workspace native ready/ACK', 45_000)
    if (!check('isolated-host-paths', app.getPath('home') === config.home && app.getPath('userData') === config.userData && getAppPaths().root === config.dataRoot)) {
      throw new Error('Refusing plugin installation because host path isolation failed')
    }
    check('expected-runtime-electron', process.versions.electron === config.expectedElectron)
    const win = getMainWindow()
    win.show(); win.focus()
    for (const input of config.plugins) {
      // Recheck against the actual host policy before publishing any background contribution.
      for (const permission of input.permissions.filter(requiresUserConsent)) {
        if (settingsStore.getPermissionGrant(input.id, permission) !== 'deny') await settingsStore.setPermissionGrant(input.id, permission, 'deny')
      }
      const begin = performance.now()
      const installed = await installFromFolder(input.distribution, getAppPaths().plugins, undefined, undefined,
        result => pluginRegistry.publishInstalledBuild(result))
      report.installed.push({ id: input.id, version: installed.manifest.version, manifestSha256: input.manifestSha256,
        installedBuildRevision: installed.buildRevision, installMs: performance.now() - begin })
    }
    check('all-32-compiled-plugins-really-installed', pluginRegistry.getInstalledDescriptors().length === 32 && report.installed.length === 32)
    check('all-sensitive-declarations-remain-denied', config.plugins.every(plugin => plugin.permissions.filter(requiresUserConsent)
      .every(permission => settingsStore.getPermissionGrant(plugin.id, permission) === 'deny')))
    settingsStore.flushNow()
    await sleep(1000)
    homeSurfaceManager.setVisible(true)
    const baseline = await stage('installed-32-idle')
    check('idle-no-plugin-runtimes-or-sensitive-backgrounds', noTransientResources(getPluginDiagnostics()))
    for (const id of config.sampleIds.slice(0, 6)) await openLoaded(id)
    await waitFor(() => !pluginHost.getDiagnostics().opening && !pluginHost.getDiagnostics().closing && !pluginHost.getDiagnostics().retiring, 'six loaded runtimes')
    const six = await stage('six-logical-tabs')
    check('six-real-resident-plugin-views', six.diagnostics.host.logicalTabs === 6 && six.diagnostics.host.live === 6)
    for (const id of config.sampleIds.slice(6)) await openLoaded(id)
    await waitFor(() => !pluginHost.getDiagnostics().opening && !pluginHost.getDiagnostics().closing && !pluginHost.getDiagnostics().retiring &&
      pluginHost.getDiagnostics().entries.length <= PLUGIN_ALIVE_LIMIT, 'eight-tab LRU retirement')
    const eight = await stage('eight-logical-tabs-production-limit-six')
    check('eight-tabs-obey-unchanged-resident-policy', eight.diagnostics.host.logicalTabs === 8 && eight.diagnostics.host.live <= PLUGIN_ALIVE_LIMIT &&
      eight.diagnostics.host.hibernated >= 2, eight.diagnostics.host)
    const last = config.sampleIds.at(-1), original = pluginHost.getWebContents(last)?.id, beginReuse = performance.now()
    await pluginHost.openPlugin(last, undefined, { container: 'shell' })
    check('already-open-plugin-reuses-native-webcontents', original === pluginHost.getWebContents(last)?.id)
    report.operations.push({ type: 'reuse-existing', pluginId: last, wcId: original, hostMethodMs: performance.now() - beginReuse, visibleFrameMeasured: false })
    await closeAll(config.sampleIds)
    const closed = await stage('after-closing-eight')
    check('closed-live-resources-match-idle-baseline', noTransientResources(getPluginDiagnostics()))
    report.retainedCaches = { baseline: { session: baseline.diagnostics.session, storage: baseline.diagnostics.storage, assets: baseline.diagnostics.assets },
      afterClose: { session: closed.diagnostics.session, storage: closed.diagnostics.storage, assets: closed.diagnostics.assets },
      interpretation: 'Private settings/storage and bounded asset caches may remain; they are not live renderers/backends/background/auxiliary resources.' }
    await openLoaded(config.sampleIds[0])
    await stage('repeat-single-open')
    await closeAll([config.sampleIds[0]])
    await stage('repeat-single-closed')
    check('repeat-cycle-live-resource-cleanup', noTransientResources(getPluginDiagnostics()))
    check('no-unexpected-native-failures', !runtime.failures.length, runtime.failures)
    report.status = 'complete'
    report.elapsedMs = performance.now() - started
    report.passed = checks.every(row => row.pass)
    if (config.uiHoldMs) {
      // Native manual observation is outside all measured stages and exposes no command bridge.
      report.manualObservation = { startedAt: Date.now(), requestedMs: config.uiHoldMs, measured: false }
      save()
      console.log(`[real-app-performance] native-ui-observation-start holdMs=${config.uiHoldMs} measured=false`)
      await sleep(config.uiHoldMs)
      report.manualObservation.completedAt = Date.now()
    }
  } catch (error) {
    report.status = 'failed'; report.error = errorText(error); report.elapsedMs = performance.now() - started
    try { await closeAll(config.sampleIds) } catch (cleanupError) { report.cleanupError = errorText(cleanupError) }
    console.error(`[real-app-performance] ${report.error}`)
  } finally {
    report.nativeFailures = runtime.failures
    report.shutdown.requested = true
    save()
    app.quit()
  }
}
