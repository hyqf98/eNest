import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const adapters = {
  fixture: `export const owners=new Map(), routes={ext:{},scheme:{}}, writes=[], probes=[];`,
  '@main/db/sqliteService': `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(':memory:');export const kvStore={getDatabase:()=>db};export const runInTransaction=(_db,operation)=>operation();`,
  '@main/plugin/PluginRegistry': `import {owners} from 'fixture';export const pluginRegistry={
    get:id=>owners.has(id)?{installed:true,name:id}:null,isEnabled:id=>owners.has(id),
    getOpenWithBuild:id=>owners.get(id),getManifest:()=>({})};`,
  '@main/settings/SettingsStore': `import {routes} from 'fixture';export const settingsStore={getOpenWithRoutes:()=>routes,
    setOpenWithRoute:async(kind,value,pluginId)=>{routes[kind][value]=pluginId},clearOpenWithRoute:async(kind,value)=>{delete routes[kind][value]}};`,
  './registrar': `import {probes,writes} from 'fixture';export const registrationAvailable=()=>true;export const getOpenWithRegistrar=()=>({
    caps:()=>({canSetDefault:true,needsSystemSettings:false}),detect:async(kind,value)=>{probes.push(value);return 'candidate'},
    setDefault:async(kind,value)=>{writes.push(value);return {ok:true,status:'default'}}});`,
  '@main/logs/logService': 'export const logInfo=()=>{},logWarn=()=>{};',
  '@main/window/createShellWindow': 'export const sendShellEvent=()=>{};',
  '@main/window/orbRailViews': 'export const refreshOrbRailContribEntries=()=>{};'
}

const output = await build({
  stdin: { resolveDir: process.cwd(), contents: `export * from 'fixture';export {associationService as service} from '@main/openWith/associationService';export {contributionRegistry as registry} from '@main/contrib/ContributionRegistry';` },
  tsconfig: 'tsconfig.node.json', bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'association-fixture', setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path }) => path in adapters ? { path, namespace: 'fixture' } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: adapters[path] }))
  } }]
})
const bundle = `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`

test('runtime registrations survive a same-build scan but cannot choose either default', async () => {
  const { registry, service, owners, writes, probes } = await import(`${bundle}#opens`)
  owners.set('example.notes', 'first')
  const entry = { id: 'notes', extensions: ['note', 'txt'], schemes: ['my-notes'] }
  service.register('example.notes', entry)
  service.register('example.notes', entry)
  registry.registerManifestContributes('example.notes', {}, 'first')
  assert.equal(service.resolveTarget('ext:note').ambiguous, true)
  assert.equal(service.resolveTarget('ext:note').providers.length, 1)
  assert.equal((await service.list('ext:txt')).inspectedKey, 'ext:txt')
  assert.deepEqual(probes, ['txt'])
  assert.equal((await service.setDefault('ext:note', 'example.notes')).ok, false)
  assert.equal((await service.route('ext:note', 'example.notes')).ok, true)
  assert.equal(service.resolveTarget('ext:note').pluginId, 'example.notes')
  assert.deepEqual(writes, [])
  assert.equal((await service.setDefault('ext:note', 'example.notes')).status, 'default')
  assert.deepEqual(writes, ['note'])
  await service.clearDefault('ext:note')
  assert.equal(service.resolveTarget('ext:note').ambiguous, true)
  owners.set('example.notes', 'replacement')
  assert.equal(service.resolveTarget('ext:note').providers.length, 0)
  registry.registerManifestContributes('example.notes', {}, 'replacement')
  assert.equal(registry.listRuntimeOpenWith().length, 0)
})

test('registrations are validated, bounded and isolated from other plugins and manifest declarations', async () => {
  const { registry, service, owners, writes } = await import(`${bundle}#owners`)
  owners.set('first', 'build'); owners.set('second', 'build')
  registry.registerManifestContributes('first', { openWith: [{ id: 'fixed', schemes: ['first-open'] }] }, 'build')
  for (const schemes of [['first-open'], ['mailto'], ['ms-settings'], ['x-apple.preferences'], ['bad://'], ['z']]) {
    assert.throws(() => service.register('second', { id: 'try', schemes }))
  }
  assert.throws(() => service.register('first', { id: 'fake', extensions: ['note'], source: 'second' }))
  assert.throws(() => service.register('first', { id: 'mime', mimeTypes: ['text/plain'] }))
  service.register('first', { id: 'custom', extensions: ['old'] })
  service.register('first', { id: 'custom', extensions: ['note'] })
  assert.equal(service.resolveTarget('ext:old').providers.length, 0)
  assert.equal(service.unregister('second', 'custom'), false)
  assert.equal(service.unregister('first', 'fixed'), false)
  for (let index = 1; index < 8; index++) service.register('first', { id: `format-${index}`, extensions: ['note'] })
  assert.throws(() => service.register('first', { id: 'extra', extensions: ['note'] }))
  assert.equal(service.unregister('first', 'custom'), true)
  registry.unregisterBySource('first')
  assert.equal(service.resolveTarget('ext:note').providers.length, 0)
  assert.deepEqual(writes, [])
})
