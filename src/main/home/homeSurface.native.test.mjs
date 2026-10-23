/**
 * Build first, then run this suite alone:
 * ENEST_HOME_SURFACE_NATIVE=1 node --test src/main/home/homeSurface.native.test.mjs
 *
 * This launches a dedicated Electron harness, not the full shell. Production
 * Home/session/IPC/appearance/modal modules run with small in-memory business
 * adapters; the Home documents are explicit fixtures, not design acceptance.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { access, cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../../', import.meta.url))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function poll(read, accepts, label, timeout = 15000) {
  let value, error
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    try { value = await read(); if (accepts(value)) return value } catch (caught) { error = caught }
    await pause(50)
  }
  throw new Error(`${label}: ${error?.message || JSON.stringify(value)}`)
}

const providerSources = { a: 'com.example.native.a', b: 'com.example.native.b', broken: 'com.example.native.broken' }
const managedPlugin = 'com.example.native.managed'
const html = name => `<!doctype html><html lang="en"><meta charset="utf-8"><link rel="stylesheet" href="assets/home.css"><title>${name}</title><body><main><h1>${name}</h1><input aria-label="Preserved draft" value="Unchanged draft"><button id="home-button">Home surface</button><p id="status">Loading bridge</p></main><script src="assets/home.js"></script></body></html>`
const homeScript = autoReady => `
window.fixture={appearance:null,commands:[],snapshots:[],ready:false};
const home=window.enestHome;
home.onAppearance(snapshot=>{window.fixture.appearance=snapshot;window.fixture.snapshots.push(snapshot)});
home.onCommand(command=>{
  window.fixture.commands.push(command);
  if(command.type==='navigate'){
    window.fixture.route=command.route;
    void home.ackNavigation({requestId:command.requestId,generation:command.generation,ok:true}).catch(error=>{window.fixture.error=String(error)})
  }
});
(async()=>{
  window.fixture.appearance=await home.getAppearance();
  window.fixture.catalog=await home.getCatalog();
  document.querySelector('#status').textContent='Bridge ready';
  window.fixture.initialized=true;
  if(${autoReady}){await home.ready({revision:window.fixture.appearance.appearance.revision,workspaceVersion:1,routes:['catalog','detail','settings']});window.fixture.ready=true}
})().catch(error=>{window.fixture.error=String(error)});
`

async function writeFixture(directory) {
  await access(join(root, 'out/renderer/modal-overlay.html'))
  for (const name of ['a', 'b', 'broken', 'builtin']) {
    const providerRoot = name === 'builtin' ? join(directory, 'renderer') : join(directory, 'providers', name)
    await mkdir(join(providerRoot, 'assets'), { recursive: true })
    await writeFile(join(providerRoot, 'home.html'), html(`Native ${name} Home`))
    await writeFile(join(providerRoot, 'other.html'), '<p>Not a declared entry</p>')
    await writeFile(join(providerRoot, 'assets/home.js'), homeScript(name === 'b' || name === 'builtin'))
    await writeFile(join(providerRoot, 'assets/home.css'), 'html{background:#eef3ed;color:#173929;font:18px Georgia}body{padding:45px}input,button{font:inherit;padding:12px;margin:12px 12px 12px 0}main{max-width:750px}')
    await writeFile(join(providerRoot, 'assets/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#315d4c"/></svg>')
    await mkdir(join(providerRoot, 'backend'), { recursive: true })
    await writeFile(join(providerRoot, 'backend/private.js'), 'private backend fixture')
  }
  await writeFile(join(directory, 'outside.js'), 'outside resource root')
  await symlink(join(directory, 'outside.js'), join(directory, 'providers/a/assets/escape.js'))
  await writeFile(join(directory, 'owner.html'), '<!doctype html><title>Native Home harness</title><body style="background:#1c332c;color:white">Untrusted native owner fixture</body>')
  await mkdir(join(directory, 'out'), { recursive: true })
  // The real built native-modal document and assets remain host-owned.
  await cp(join(root, 'out/renderer'), join(directory, 'out/renderer'), { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'enest-home-native-fixture', main: 'main/index.cjs', private: true }))
}

async function buildFixture(directory) {
  const adapters = {
    fixture: `
      import {join} from 'node:path';
      import {BUILTIN_THEME_PACKS} from '@shared/theme/builtinThemes';
      import {migrateAppearanceSettings} from '@shared/theme/appearance';
      const directory=process.env.ENEST_HOME_NATIVE_ROOT;
      const sources=${JSON.stringify(providerSources)};
      const providers=Object.entries(sources).map(([name,source])=>({source,name,enabled:true,root:join(directory,'providers',name),
        contribution:{source,id:'home',version:1,entry:'home.html',variants:['default']}}));
      const defaultPack=BUILTIN_THEME_PACKS.find(pack=>pack.id==='default');
      const packs=[...BUILTIN_THEME_PACKS,...providers.map(provider=>({...structuredClone(defaultPack),source:provider.source,id:'provider-'+provider.name,name:'Native '+provider.name,
        home:{source:provider.source,id:'home',variant:'default'}}))];
      const legacy={theme:{mode:'light',packId:null,overrides:{light:{},dark:{}}},general:{animationLevel:'low',fontFamily:'',fontFamilyEn:'',fontSizeScale:1}};
      const settings=migrateAppearanceSettings({version:2,revision:0,mode:'light',active:{source:sources.a,id:'provider-a'},profiles:{},legacy},legacy);
      export const state={directory,providers,packs,settings,win:null,homeSink:null,modalSink:null,contents:[],events:[],logs:[],
        pending:'idle',pendingError:null,forbiddenReads:0,forbiddenWrites:0,launches:[],appLaunches:[],managedEnabled:true,managedChanges:[],
        managedId:${JSON.stringify(managedPlugin)}};
    `,
    '@main/window/createShellWindow': `
      import {join} from 'node:path';import {state} from 'fixture';
      export const getMainWindow=()=>state.win;
      export const getShellBounds=()=>state.win.getContentBounds();
      export const getPluginTopInset=()=>0;
      export const resolvePreload=name=>join(state.directory,'preload',name.replace(/\\.(?:js|cjs)$/,'.cjs'));
      export const setHomeEventSink=sink=>{state.homeSink=sink};
      export const setModalEventSink=sink=>{state.modalSink=sink};
      export const sendShellEvent=payload=>{state.events.push(payload);state.homeSink?.(payload);state.modalSink?.(payload)};
    `,
    '@main/settings/SettingsStore': `
      import {state} from 'fixture';export const settingsStore={
        getAppearanceSettings:()=>structuredClone(state.settings),
        commitAppearanceSettings:next=>{state.settings=structuredClone(next)},
        getPluginAppearance:()=>({customFonts:[]}),
        getAll:()=>({general:{locale:'en-US',customFonts:[]}}),
        setAll:async()=>{throw Error('Native fixture does not permit generic settings writes')}
      };
    `,
    '@main/theme/themePacks': `import {state} from 'fixture';export const themePackRegistry={list:()=>state.packs,get:id=>state.packs.find(pack=>pack.id===id)};`,
    '@main/plugin/PluginRegistry': `
      import {state} from 'fixture';
      const summary=id=>id===state.managedId?{id,name:'Managed fixture',installed:true,enabled:state.managedEnabled}:
        state.providers.some(item=>item.source===id)?{id,name:'Provider fixture',installed:true,enabled:state.providers.find(item=>item.source===id).enabled,icon:'enest://plugin/'+id+'/assets/icon.svg'}:null;
      export const pluginRegistry={
        getInstalledDescriptors:()=>state.providers.map(item=>({id:item.source,enabled:item.enabled})),
        getManifest:id=>{const provider=state.providers.find(item=>item.source===id);return provider?{id,icon:'assets/icon.svg',contributes:{homePages:[provider.contribution]}}:null},
        getAssetManifest:id=>{const provider=state.providers.find(item=>item.source===id);return provider?{id,icon:'assets/icon.svg',contributes:{homePages:[provider.contribution]}}:null},
        getAssetRootPath:id=>state.providers.find(item=>item.source===id)?.root??null,
        get:summary,list:()=>[...state.providers.map(item=>summary(item.source)),summary(state.managedId)],getRemoteMarket:()=>[],refreshRemoteMarket:async()=>{},
        getRemoteEntry:()=>null,setPluginEnabled:async(id,enabled)=>{if(id!==state.managedId)throw Error('Unexpected mutation');state.managedEnabled=enabled;state.managedChanges.push(enabled)}
      };
    `,
    '@main/contrib/ContributionRegistry': `import {state} from 'fixture';export const contributionRegistry={listSlot:slot=>slot==='home-pages'?state.providers.map(item=>({source:item.source,data:item.contribution})):[]};`,
    '@main/paths/pathsService': `export const getAppPathsRoot=()=>process.env.ENEST_TEST_DATA_ROOT;`,
    '@main/window/orbRailViews': `export const raiseOrbRailViews=()=>{};`,
    '@main/logs/logService': `import {state} from 'fixture';export const logWarn=(area,message)=>state.logs.push({level:'warn',area,message});export const logInfo=(area,message)=>state.logs.push({level:'info',area,message});`,
    '@main/plugin/PluginHost': `export const pluginHost={getDirtySnapshot:()=>[],requestSaveAll:async()=>({timedOut:false}),blockPlugin:()=>()=>{},closePlugin:async()=>{}};`,
    '@main/plugin/PluginUninstaller': `export const uninstallPlugin=async()=>({ok:false,error:'unsupported fixture operation'});`,
    '@main/plugin/installQueue': `export const enqueueInstallFromUrl=()=>{throw Error('No remote installation in native fixture')};`,
    '@main/launcher/pluginLauncher': `import {state} from 'fixture';export const launchPlugin=async request=>{state.launches.push(request);return {ok:true}};`,
    '@main/launcher/appLauncher': `import {state} from 'fixture';export const launchLocalApp=async path=>{state.appLaunches.push(path)};`,
    '@main/launcher/appScanner': `export const scanApplications=async()=>({complete:true,errors:[]});`,
    '@main/launcher/commandIndex': `export const searchQuickCommands=async()=>[{kind:'app',id:'fixture-app',title:'Fixture app',subtitle:'/private/fixture.app',path:'/private/fixture.app'}];`,
    '@main/clipboard/clipboardHistory': `export const revalidateClipboardPolling=async()=>{};`,
    '@main/timer/focusTimerService': `export const stopFocusTimer=async()=>{};`,
    '@main/hotkey/pluginLaunchHotkeys': `export const applyPluginLaunchHotkeys=()=>{};export const releasePluginLaunchHotkey=()=>{};export const clearPluginLaunch=async()=>{};`,
    '@main/update/updateService': `export const getUpdateState=()=>({status:'idle'});export const downloadUpdate=async()=>{};export const checkForUpdates=async()=>{};export const quitAndInstallUpdate=async()=>({status:'idle'});`
  }
  const entry = `
    import {app,BaseWindow,WebContentsView,webContents,protocol} from 'electron';
    import {join} from 'node:path';import {state} from 'fixture';
    import {HomeSurfaceManager} from '@main/home/HomeSurfaceManager';
    import {registerHomeIpc} from '@main/home/homeIpc';
    import {appearanceService,getAppearance} from '@main/theme/appearanceService';
    import {getTrustedSurfaceRole,handleShellIpc} from '@main/ipc/ipcSecurity';
    import {registerModalSurfaceHandlers} from '@main/window/modalSurface';
    import {IpcChannels} from '@shared/types/ipc';
    app.setPath('userData',process.env.ENEST_TEST_USER_DATA);
    protocol.registerSchemesAsPrivileged([{scheme:'enest-home',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
    app.on('window-all-closed',()=>app.quit());
    const manager=new HomeSurfaceManager(2200);
    const track=(label,operation)=>{state.pending=label;state.pendingError=null;void operation.then(()=>{state.pending='done'},error=>{state.pending='error';state.pendingError=String(error.stack||error)})};
    manager.onContents(wc=>{state.contents.push({id:wc.id,session:wc.session});wc.on('console-message',(_event,_level,message)=>state.logs.push({area:'home-renderer',message}))});
    manager.onFault(message=>{track('recover',appearanceService.recoverToBuiltin(message))});
    appearanceService.setHomeCoordinator(candidate=>manager.prepare(candidate));
    appearanceService.subscribeAppearance(({appearance})=>manager.updateAppearance(appearance));
    registerHomeIpc(manager);registerModalSurfaceHandlers();
    handleShellIpc(IpcChannels.ShellGetSettings,()=>{state.forbiddenReads++;return {private:'host-only'}});
    handleShellIpc(IpcChannels.ShellSetSettings,()=>{state.forbiddenWrites++;return {ok:true}});
    handleShellIpc(IpcChannels.ShellActivateTheme,()=>{state.forbiddenWrites++;return {ok:true}});
    globalThis.__homeNative={state,manager,channels:IpcChannels,
      start:()=>{manager.setVisible(true);track('initial',manager.retry())},
      activate:name=>{const provider=state.providers.find(item=>item.name===name);track('activate-'+name,appearanceService.activateTheme({source:provider.source,id:'provider-'+name}))},
      navigate:route=>track('navigate-'+route.page,manager.navigate(route)),
      setMode:mode=>appearanceService.setAppearanceMode(mode),
      snapshot:()=>({pending:state.pending,pendingError:state.pendingError,appearance:getAppearance(),settings:state.settings,home:manager.getState(),
        managedEnabled:state.managedEnabled,managedChanges:state.managedChanges,forbiddenReads:state.forbiddenReads,forbiddenWrites:state.forbiddenWrites,
        ownerId:state.ownerId,homeIds:state.contents.filter(item=>webContents.fromId(item.id)).map(item=>item.id),
        surfaces:state.win?.contentView.children.map(view=>({id:view.webContents?.id,role:view.webContents?getTrustedSurfaceRole(view.webContents.id):null,visible:view.getVisible(),bounds:view.getBounds()}))??[],
        focused:webContents.getFocusedWebContents()?.id??null,logs:state.logs.slice(-20)}),
      sessionState:async id=>{const item=state.contents.find(item=>item.id===id);return item?{alive:!!webContents.fromId(id),role:getTrustedSurfaceRole(id),handled:await item.session.protocol.isProtocolHandled('enest-home'),storagePath:item.session.getStoragePath()}:null},
      focus:()=>{app.focus({steal:true});state.win.show();state.win.focus();for(const view of state.win.contentView.children)if(view.webContents&&manager.isContentsActive(view.webContents.id))view.webContents.focus()},
      destroy:()=>manager.destroy()
    };
    app.whenReady().then(async()=>{
      const win=new BaseWindow({title:'eNest native Home acceptance',width:1000,height:700,frame:false,show:false,backgroundColor:'#173929'});state.win=win;
      const owner=new WebContentsView({webPreferences:{preload:join(state.directory,'preload/homePreload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
      owner.setBounds({x:0,y:0,width:1000,height:700});win.contentView.addChildView(owner);state.ownerId=owner.webContents.id;
      await owner.webContents.loadFile(join(state.directory,'owner.html'));
      win.on('resize',()=>manager.layout());win.once('closed',()=>{manager.destroy();if(!owner.webContents.isDestroyed())owner.webContents.close({waitForBeforeUnload:false})});
      win.show();win.focus();globalThis.__homeNative.ready=true;
    }).catch(error=>{console.error(error);app.exit(1)});
    app.on('before-quit',()=>{manager.destroy();for(const wc of webContents.getAllWebContents())if(!wc.isDestroyed())wc.close({waitForBeforeUnload:false})});
  `
  await build({
    stdin: { contents: entry, resolveDir: root, sourcefile: 'home-native-entry.ts', loader: 'ts' },
    bundle: true, outfile: join(directory, 'main/index.cjs'), platform: 'node', format: 'cjs', target: 'node22',
    external: ['electron'], tsconfig: join(root, 'tsconfig.node.json'),
    plugins: [{ name: 'native-home-business-adapters', setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path, importer }) => {
        const name = path === './createShellWindow' && importer.endsWith('modalSurface.ts') ? '@main/window/createShellWindow' : path
        return name in adapters ? { path: name, namespace: 'home-native-adapter' } : undefined
      })
      builder.onLoad({ filter: /.*/, namespace: 'home-native-adapter' }, ({ path }) => ({ contents: adapters[path], loader: 'js', resolveDir: root }))
    } }]
  })
  await build({
    stdin: { contents: `import '@preload/homePreload';import {contextBridge,ipcRenderer} from 'electron';contextBridge.exposeInMainWorld('nativeTest',{invoke:(channel,...args)=>ipcRenderer.invoke(channel,...args)});`, resolveDir: root },
    bundle: true, outfile: join(directory, 'preload/homePreload.cjs'), platform: 'node', format: 'cjs', external: ['electron'], tsconfig: join(root, 'tsconfig.node.json')
  })
  await build({ entryPoints: [join(root, 'src/preload/modalPreload.ts')], bundle: true, outfile: join(directory, 'preload/modalPreload.cjs'), platform: 'node', format: 'cjs', external: ['electron'], tsconfig: join(root, 'tsconfig.node.json') })
}

test('native Home fixture bundles without launching Electron', {
  skip: process.env.ENEST_HOME_SURFACE_BUILD !== '1', timeout: 30000
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'enest-home-bundle-'))
  try { await writeFixture(directory); await buildFixture(directory) }
  finally { await rm(directory, { recursive: true, force: true }) }
})

test('dedicated native Home proves protocol readiness, role denials, paired recovery, modal stacking and cleanup', {
  skip: process.env.ENEST_HOME_SURFACE_NATIVE !== '1', timeout: 120000
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'enest-home-native-'))
  const evidenceDir = process.env.ENEST_HOME_SURFACE_EVIDENCE || join(directory, 'evidence')
  const userData = join(directory, 'profile')
  const dataRoot = join(directory, 'data')
  const evidence = { status: 'running', platform: process.platform, scope: 'dedicated real Home/runtime/native-modal with fixture documents and in-memory business adapters', checks: {}, screenshots: [] }
  let app, failure, logs = ''
  try {
    await mkdir(evidenceDir, { recursive: true })
    await mkdir(dataRoot, { recursive: true })
    await writeFixture(directory)
    await buildFixture(directory)
    const env = { ...process.env, ENEST_TEST_USER_DATA: userData, ENEST_TEST_DATA_ROOT: dataRoot, ENEST_HOME_NATIVE_ROOT: directory }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    delete env.ENEST_REMOTE_DEBUG
    app = await electron.launch({ executablePath: require('electron'), args: [directory], env, timeout: 25000 })
    for (const stream of [app.process().stdout, app.process().stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-70000) })
    await poll(() => app.evaluate(() => !!globalThis.__homeNative?.ready), Boolean, 'dedicated harness ready')
    assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), userData)
    const snapshot = () => app.evaluate(() => globalThis.__homeNative.snapshot())
    const evaluate = (id, code) => app.evaluate(({ webContents }, { id, code }) => webContents.fromId(id).executeJavaScript(code), { id, code })
    const homeId = async () => (await snapshot()).homeIds.at(-1)
    const home = async code => evaluate(await homeId(), code)
    const sessionState = id => app.evaluate((_, id) => globalThis.__homeNative.sessionState(id), id)
    const rawInvoke = (id, channel, payload) => evaluate(id, `window.nativeTest.invoke(${JSON.stringify(channel)},${JSON.stringify(payload)}).then(value=>({ok:true,value}),error=>({ok:false,error:String(error)}))`)
    const channels = await app.evaluate(() => globalThis.__homeNative.channels)
    const capture = async (id, name) => {
      await evaluate(id, 'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      const bytes = await app.evaluate(async ({ webContents }, id) => (await webContents.fromId(id).capturePage()).toPNG().toString('base64'), id)
      await writeFile(join(evidenceDir, name), Buffer.from(bytes, 'base64'))
      evidence.screenshots.push(name)
    }

    await app.evaluate(() => globalThis.__homeNative.start())
    await poll(() => home('window.fixture'), state => state?.initialized, 'Home page gets restricted appearance and cached catalog')
    const firstId = await homeId()
    const pending = await snapshot()
    assert.equal(pending.home.status, 'loading')
    assert.equal(pending.surfaces.find(surface => surface.id === firstId).visible, false)
    assert.equal(await home('location.href'), 'enest-home://surface/home.html')
    assert.deepEqual(await home('({home:typeof window.enestHome,plugin:typeof window.enest,shell:typeof window.enestShell,node:typeof window.require})'), { home: 'object', plugin: 'undefined', shell: 'undefined', node: 'undefined' })
    assert.equal((await sessionState(firstId)).storagePath, null)
    assert.equal((await rawInvoke(firstId, channels.HomeAction, { type: 'openSettings' })).ok, false, 'uncommitted Home cannot act')
    for (const channel of [channels.ShellGetSettings, channels.ShellSetSettings, channels.ShellActivateTheme]) {
      const result = await rawInvoke(firstId, channel, {})
      assert.equal(result.ok, false)
      assert.match(result.error, /IPC denied/)
    }
    const untrusted = await rawInvoke(pending.ownerId, channels.HomeGetAppearance)
    assert.equal(untrusted.ok, false)
    assert.match(untrusted.error, /untrusted/)
    assert.deepEqual([(await snapshot()).forbiddenReads, (await snapshot()).forbiddenWrites], [0, 0])
    const revision = await home('window.fixture.appearance.appearance.revision')
    await home(`window.enestHome.ready({revision:${revision + 1},workspaceVersion:1,routes:['catalog','detail','settings']})`)
    await pause(100)
    assert.equal((await snapshot()).home.status, 'loading', 'wrong-revision ready cannot reveal Home')
    await home(`window.enestHome.ready({revision:${revision},workspaceVersion:1,routes:['catalog','detail','settings']})`)
    await poll(snapshot, state => state.home.status === 'ready' && state.pending === 'done', 'matching native Home readiness commits')
    assert.equal((await snapshot()).surfaces.find(surface => surface.id === firstId).visible, true)
    evidence.checks.restrictedSchemeAndReady = true
    evidence.checks.ipcRoleDenials = true

    const resources = await home(`Promise.all(['enest-home://surface/other.html','enest-home://surface/backend/private.js','enest-home://surface/assets/escape.js','file:///private/secret','enest://plugin/other/private','https://example.invalid/private'].map(async url=>{try{const response=await fetch(url);return {url,status:response.status}}catch{return {url,blocked:true}}}))`)
    assert.deepEqual(resources.slice(0, 3).map(item => item.status), [403, 403, 404])
    assert.ok(resources.slice(3).every(item => item.blocked))
    evidence.checks.realSessionResourceDenials = true
    const handles = await home(`window.enestHome.search({query:'Fixture',scope:'app'})`)
    assert.equal(handles.items.length, 1)
    assert.equal(JSON.stringify(handles).includes('/private/'), false)
    await home(`document.querySelector('input').value='Draft survives mode change';localStorage.setItem('private-fixture','only this ephemeral session');void 0`)
    await app.evaluate(() => globalThis.__homeNative.setMode('dark'))
    await poll(() => home('window.fixture.appearance.appearance.mode'), value => value === 'dark', 'mode snapshot reaches existing native Home')
    assert.equal(await homeId(), firstId)
    assert.equal(await home(`document.querySelector('input').value`), 'Draft survives mode change')
    evidence.checks.sameProviderStatePreserved = true

    await app.evaluate(() => globalThis.__homeNative.activate('b'))
    await poll(snapshot, state => state.pending === 'done' && state.home.status === 'ready' && state.appearance.theme.source === providerSources.b, 'paired provider activation')
    const secondId = await homeId()
    assert.notEqual(secondId, firstId)
    await poll(() => sessionState(firstId), value => !value.alive && !value.handled && value.role === null, 'retired Home/session/protocol reclaimed')
    assert.equal((await home(`window.enestHome.action({type:'activateSearchResult',handle:${JSON.stringify(handles.items[0].handle)}})`)).ok, false)
    evidence.checks.providerSwapAndRevocation = true

    await app.evaluate(({ webContents }, id) => webContents.fromId(id).forcefullyCrashRenderer(), secondId)
    const recovered = await poll(snapshot, state => state.pending === 'done' && state.home.status === 'error' && state.home.recovery === true && state.appearance.theme.source === 'enest.builtin' && state.appearance.theme.id === 'default' && state.settings.recovery?.theme.source === providerSources.b && state.surfaces.some(surface => surface.role === 'home' && !surface.visible), 'real renderer crash prepares paired default recovery behind the safety lock')
    await poll(() => sessionState(secondId), value => !value.alive && !value.handled && value.role === null, 'crashed session reclaimed')
    const recoveredId = await homeId()
    assert.notEqual(recoveredId, secondId)
    assert.deepEqual(recovered.homeIds, [recoveredId])
    assert.equal(await home(`document.querySelector('h1').textContent`), 'Native builtin Home')
    await app.evaluate(async () => {
      const manager = globalThis.__homeNative.manager
      manager.setVisible(true)
      await manager.ensure()
    })
    const stillLocked = await snapshot()
    assert.equal(stillLocked.home.status, 'error')
    assert.equal(stillLocked.home.recovery, true)
    assert.deepEqual(stillLocked.homeIds, [recoveredId], 'ordinary visibility cannot replace the locked fallback')
    assert.equal(stillLocked.surfaces.find(surface => surface.id === recoveredId).visible, false, 'ordinary visibility cannot reveal a safety-suspended Workspace')
    await app.evaluate(() => globalThis.__homeNative.navigate({ page: 'catalog' }))
    await poll(snapshot, state => state.pending === 'done' && state.home.status === 'ready' && state.home.recovery === false && state.surfaces.some(surface => surface.id === recoveredId && surface.visible), 'explicit navigation reveals the recovered default Workspace')
    assert.equal(await homeId(), recoveredId, 'explicit recovery reuses the prepared default runtime')
    evidence.checks.realCrashPairedRecovery = true
    evidence.checks.recoveryLockRequiresExplicitNavigation = true
    await app.evaluate(() => globalThis.__homeNative.activate('broken'))
    await poll(snapshot, state => state.pending === 'done' && state.home.status === 'ready' && !state.home.recovery && state.appearance.theme.id === 'default' && state.settings.recovery?.theme.source === providerSources.broken && state.surfaces.some(surface => surface.id === recoveredId && surface.visible), 'missing ready times out and preserves the active paired fallback', 12000)
    assert.equal((await snapshot()).homeIds.length, 1)
    evidence.checks.handshakeFailurePairedRecovery = true

    await app.evaluate(() => globalThis.__homeNative.focus())
    const ownerId = await homeId()
    await home(`void window.enestHome.action({type:'setPluginEnabled',pluginId:${JSON.stringify(managedPlugin)},enabled:false}).then(result=>{window.fixture.actionResult=result})`)
    const modal = await poll(snapshot, state => state.surfaces.some(surface => surface.role === 'modal' && surface.visible), 'actual native confirmation surface ready')
    const modalSurface = modal.surfaces.find(surface => surface.role === 'modal')
    assert.equal(modal.surfaces.at(-1).id, modalSurface.id, 'native modal is above the native Home view')
    assert.deepEqual(modalSurface.bounds, { x: 0, y: 0, width: 1000, height: 700 })
    await poll(snapshot, state => state.focused === modalSurface.id, 'native modal takes keyboard focus')
    assert.equal(await evaluate(modalSurface.id, 'typeof window.enestHome'), 'undefined')
    await poll(() => evaluate(modalSurface.id, 'document.querySelector(".confirm-panel")?.textContent'), text => text?.includes('Managed fixture'), 'real native-modal React content')
    assert.equal((await snapshot()).managedEnabled, true, 'native confirmation gates management mutation')
    await capture(modalSurface.id, 'native-home-confirmation.png')
    await evaluate(modalSurface.id, `document.querySelector('.confirm-actions button:last-child').click();void 0`)
    await poll(() => home('window.fixture.actionResult'), value => value?.ok, 'confirmed Home action completes')
    await poll(snapshot, state => !state.surfaces.some(surface => surface.role === 'modal') && state.focused === ownerId, 'modal closes and restores actual native Home focus')
    assert.deepEqual((await snapshot()).managedChanges, [false])
    evidence.checks.nativeModalAboveHome = true
    evidence.checks.nativeModalFocusRestored = true

    await home(`void window.enestHome.action({type:'setPluginEnabled',pluginId:${JSON.stringify(managedPlugin)},enabled:true})`)
    await poll(snapshot, state => state.surfaces.some(surface => surface.role === 'modal' && surface.visible), 'second native confirmation pending')
    const activeIds = (await snapshot()).homeIds
    await app.evaluate(() => globalThis.__homeNative.destroy())
    await poll(snapshot, state => state.homeIds.length === 0 && !state.surfaces.some(surface => surface.role === 'modal' || surface.role === 'home'), 'owner destruction removes Home and native modal')
    for (const id of activeIds) await poll(() => sessionState(id), value => !value.alive && !value.handled && value.role === null, 'destroyed Home session revoked')
    assert.deepEqual((await snapshot()).managedChanges, [false], 'destroyed owner cannot apply the pending confirmation')
    evidence.checks.destroyedOwnerCancelsModal = true
    evidence.checks.nativeDestructionAndProtocolCleanup = true
    evidence.final = await snapshot()
    evidence.status = 'pass'
  } catch (error) {
    failure = error
    evidence.status = 'fail'
    evidence.error = String(error.stack || error)
    if (app) evidence.final = await app.evaluate(() => globalThis.__homeNative?.snapshot()).catch(() => null)
  } finally {
    await mkdir(evidenceDir, { recursive: true })
    await writeFile(join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2))
    await writeFile(join(evidenceDir, 'electron.log'), logs)
    if (app) await app.close().catch(() => app.process().kill('SIGKILL'))
    await rm(directory, { recursive: true, force: true })
    console.log(process.env.ENEST_HOME_SURFACE_EVIDENCE ? `Native Home evidence: ${evidenceDir}` : `Native Home checks: ${JSON.stringify(evidence.checks)}`)
  }
  if (failure) throw failure
})
