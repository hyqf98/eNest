import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../../../', import.meta.url))
export async function stageAccountStorage(directory) {
  if (process.platform === 'win32') return
  const parts = ['.cache', 'native', 'bin'], target = join(directory, ...parts)
  await mkdir(target, { recursive: true })
  for (const file of ['account-storage.cjs', 'account-storage.node']) await copyFile(join(root, ...parts, file), join(target, file))
}

export async function syncFixtureBundle({ native = false, isolatedLogin = false } = {}) {
  const official = JSON.parse(readFileSync(join(root, 'src/main/auth/officialGithubApp.json'), 'utf8'))
  const stubs = {
    'sync-fixture-state': `import {EventEmitter} from 'node:events'; export const events=new EventEmitter(); export const blocked=new Set(); export const runtime={request:null,window:null}; export const ids=['fixture.sync.notes','fixture.sync.palette','fixture.sync.local'];`,
    PluginRegistry: `import {ids} from 'sync-fixture-state'; export const pluginRegistry={getInstalledDescriptors:()=>ids.map(id=>({id,buildRevision:'fixture-build',manifest:{id,name:id,version:'1.0.0'}})), getBuildRevision:()=>'fixture-build'};`,
    PluginHost: `import {blocked} from 'sync-fixture-state'; export const pluginHost={isOpened:()=>false,isBlockedForOpen:id=>blocked.has(id),blockPlugin(id){blocked.add(id);return ()=>blocked.delete(id)}};`,
    PluginInstaller: 'export const withInstallLock=(_id,run)=>run();',
    pluginBackgroundRuntime: 'export const getBackgroundMemoryOwners=()=>[];',
    HomeSurfaceManager: 'export const homeSurfaceManager={getMemoryOwners:()=>[]};',
    pluginMemoryMonitor: 'export const getPluginMemoryDiagnosticSnapshot=async()=>({plugins:[]});',
    createShellWindow: `import {events,runtime} from 'sync-fixture-state'; export const getMainWindow=()=>runtime.window; export const sendShellEvent=event=>events.emit(event.type,event);`,
    orbRailViews: 'export const setOrbProfile=()=>{};',
    logService: 'export const logWarn=()=>{};export const logInfo=()=>{};',
    ...(isolatedLogin && {
      'fixture-login-electron': `import {runtime} from 'sync-fixture-state'; export {app} from 'electron'; export const net={fetch:(url,init)=>runtime.request(url,init)}; export const shell={openExternal:async url=>{runtime.opened=url}};`,
      clipboardNativeEvents: 'export const writeClipboardText=async()=>{};',
    }),
    ...(!native && {
      electron: `import {runtime} from 'sync-fixture-state'; export const net={fetch:(url,init)=>runtime.request(url,init)}; export const app={isPackaged:false};export const nativeTheme={shouldUseDarkColors:false};`,
      githubAuthService: `export const getProfileUser=()=>({githubId:27,login:'fixture'}); export const getGithubSyncSession=async()=>({user:{id:27,login:'fixture'},token:'fixture-only',signal:new AbortController().signal,check(){}});`,
    }),
  }
  const exports = `export {events,runtime,ids} from 'sync-fixture-state';
    export * as sync from '@main/auth/githubSyncService'; export * as cloud from '@main/auth/githubRepository';
    export {settingsStore} from '@main/settings/SettingsStore'; export {kvStore} from '@main/db/sqliteService';
    export * as storage from '@main/db/pluginStorage'; export * as files from '@main/plugin/portablePluginData';
    export * as paths from '@main/paths/pathsService'; export {collectPluginDataUsage} from '@main/plugin/pluginDataUsage';
    ${native ? `export * as auth from '@main/auth/githubAuthService'; export {getAccountState,loginAccount} from '@main/auth/accountAuthService'; export {applyProxy,applyProxyFromSettings} from '@main/proxy/proxyService';` : ''}`
  const compiled = await build({ stdin: { contents: exports, resolveDir: root, loader: 'ts' }, absWorkingDir: root, tsconfig: 'tsconfig.node.json', bundle: true, platform: 'node', target: 'node22', format: 'cjs', write: false, logLevel: 'silent',
    define: { __ENEST_AUTH__: JSON.stringify({ githubClientId: official.clientId, githubAppSlug: official.slug, githubDeviceFlow: true }) }, external: native ? ['electron'] : [],
    plugins: [{ name: 'isolated-fixture-owners', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (isolatedLogin && args.path === 'electron' && /\/auth\/github(?:Transport|AuthService)\.ts$/.test(args.importer)) return { path: 'fixture-login-electron', namespace: 'fixture' }
        const key = args.path.split('/').pop(); return Object.hasOwn(stubs, key) ? { path: key, namespace: 'fixture' } : undefined
      })
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs[args.path], resolveDir: root }))
    } }],
  })
  return compiled.outputFiles[0].text
}
