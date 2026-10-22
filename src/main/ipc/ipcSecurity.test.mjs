import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'
const bundle = await build({stdin:{contents:`export * from '@main/ipc/ipcSecurity';export { IpcChannels } from '@shared/types/ipc';export { calls } from 'electron';`,resolveDir:process.cwd()},tsconfig:'tsconfig.node.json',bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'electron',setup(b){b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:`export const calls=[];export const shell={openExternal:async url=>calls.push(url)};export const ipcMain={handle(){},on(){}};`}))}}]})
const api=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))
let sequence=0
function surface(role='shell') {
 const wc=new EventEmitter();wc.id=++sequence;wc.mainFrame={url:'file:///fixture/index.html'};wc.isDestroyed=()=>false;wc.setWindowOpenHandler=fn=>{wc.open=fn};
 api.registerTrustedSurface(wc,role,wc.mainFrame.url)
 return {wc,event:{sender:wc,senderFrame:wc.mainFrame}}
}
test('privileged IPC rejects unregistered identity, subframes, changed origin and destroyed instance',()=>{
 const {wc,event}=surface();assert.doesNotThrow(()=>api.assertSurfaceSender(event,api.IpcChannels.ShellGetSettings))
 assert.throws(()=>api.assertSurfaceSender({...event,sender:{id:wc.id,isDestroyed:()=>false}},api.IpcChannels.ShellGetSettings),/untrusted/)
 assert.throws(()=>api.assertSurfaceSender({...event,senderFrame:{url:wc.mainFrame.url}},api.IpcChannels.ShellGetSettings),/untrusted/)
 wc.mainFrame.url='https://evil.example/index.html';assert.throws(()=>api.assertSurfaceSender(event,api.IpcChannels.ShellGetSettings),/document/)
 wc.mainFrame.url='file:///fixture/index.html';wc.emit('destroyed');assert.throws(()=>api.assertSurfaceSender(event,api.IpcChannels.ShellGetSettings),/untrusted/)
})
test('Quick and orb retain only their assigned channels',()=>{
 for(const role of ['quick','orb']){
  const {event}=surface(role)
  assert.doesNotThrow(()=>api.assertSurfaceSender(event,api.IpcChannels.ShellGetTheme))
  assert.throws(()=>api.assertSurfaceSender(event,api.IpcChannels.ShellSetSettings),/capability/)
 }
})
test('notification surfaces can only measure, dismiss their cards and request safe host link opening', () => {
 const {event} = surface('notification')
 for (const channel of ['NotificationState', 'NotificationMeasure', 'NotificationDismiss', 'NotificationOpenLink']) {
  assert.doesNotThrow(() => api.assertSurfaceSender(event, api.IpcChannels[channel]))
 }
 for (const channel of ['NotificationShow', 'ShellGetSettings', 'ShellSetSettings', 'ShellOpenPlugin', 'ShellInstallPlugin', 'QuickInput']) {
  assert.throws(() => api.assertSurfaceSender(event, api.IpcChannels[channel]), /capability/)
 }
 for (const role of ['shell', 'quick', 'detached']) {
  assert.doesNotThrow(() => api.assertSurfaceSender(surface(role).event, api.IpcChannels.NotificationShow))
 }
})
test('opening a local path is restricted to the trusted main shell surface', () => {
 const {event} = surface('shell')
 assert.doesNotThrow(() => api.assertSurfaceSender(event, api.IpcChannels.ShellOpenPath))
 for (const role of ['quick', 'orb', 'detached']) {
  assert.throws(() => api.assertSurfaceSender(surface(role).event, api.IpcChannels.ShellOpenPath), /capability/)
 }
 assert.throws(() => api.assertSurfaceSender({sender:{id:987654,isDestroyed:()=>false},senderFrame:{}}, api.IpcChannels.ShellOpenPath), /untrusted/)
})
test('installation surfaces cannot read settings, launch plugins or request arbitrary host installation', () => {
 const {event} = surface('install')
 for (const channel of ['InstallDropState', 'InstallDropFiles', 'InstallSurfaceReady', 'InstallSurfaceDismiss']) {
  assert.doesNotThrow(() => api.assertSurfaceSender(event, api.IpcChannels[channel]))
 }
 for (const channel of ['ShellGetSettings', 'ShellSetSettings', 'ShellOpenPlugin', 'ShellInstallPlugin', 'NotificationShow']) {
  assert.throws(() => api.assertSurfaceSender(event, api.IpcChannels[channel]), /capability/)
 }
})
test('surface navigation is pinned and safe shell links cannot create privileged windows',async()=>{
 const {wc}=surface();let prevented=false
 wc.emit('will-navigate',{preventDefault:()=>{prevented=true}},'https://evil.example/');assert.equal(prevented,true)
 for(const url of ['javascript:alert(1)','file:///secret','https://user:secret@example.com/'])assert.deepEqual(wc.open({url}),{action:'deny'})
 assert.equal(api.calls.length,0)
 assert.deepEqual(wc.open({url:'https://example.com/help'}),{action:'deny'});assert.deepEqual(api.calls,['https://example.com/help'])
})

test('detached chrome has only the seven instance-window commands, no shell read or write access', () => {
 const {event} = surface('detached')
 for (const channel of ['PluginWindowState', 'PluginWindowCommand', 'PluginDragBegin', 'PluginDragArm', 'PluginDragUpdate', 'PluginDragEnd', 'PluginDragTargets']) {
  assert.doesNotThrow(() => api.assertSurfaceSender(event, api.IpcChannels[channel]))
 }
 for (const channel of ['ShellGetSettings', 'ShellGetPlugins', 'ShellSetSettings', 'WindowClose', 'QuickInput', 'ShellOpenPlugin']) {
  assert.throws(() => api.assertSurfaceSender(event, api.IpcChannels[channel]), /capability/)
 }
 assert.equal(api.getTrustedSurfaceRole(event.sender.id), 'detached')
 event.sender.emit('destroyed')
 assert.equal(api.getTrustedSurfaceRole(event.sender.id), null)
})

test('home surfaces use the home capability set and explicit revocation', () => {
 const { event, wc } = surface('home')
 for (const channel of ['HomeReady', 'HomeAck', 'HomeGetAppearance', 'HomeGetConfig', 'HomeGetCatalog', 'HomeGetDetail', 'HomeSearch', 'HomeRefresh', 'HomeAction']) {
  assert.doesNotThrow(() => api.assertSurfaceSender(event, api.IpcChannels[channel]))
 }
 for (const channel of ['ShellGetSettings', 'ShellSetSettings', 'ShellGetTheme', 'ShellOpenPlugin', 'NotificationShow', 'PluginWindowCommand']) {
  assert.throws(() => api.assertSurfaceSender(event, api.IpcChannels[channel]), /capability/)
 }
 api.revokeTrustedSurface(wc)
 assert.equal(api.getTrustedSurfaceRole(wc.id), null)
 assert.throws(() => api.assertSurfaceSender(event, api.IpcChannels.HomeReady), /untrusted/)
})

test('home channels are not inherited by unrelated restricted surfaces', () => {
 for (const role of ['quick', 'orb', 'notification', 'install', 'modal', 'detached']) {
  const {event} = surface(role)
  for (const channel of ['HomeGetConfig', 'HomeAck']) {
   assert.throws(() => api.assertSurfaceSender(event, api.IpcChannels[channel]), /capability/)
  }
 }
})
