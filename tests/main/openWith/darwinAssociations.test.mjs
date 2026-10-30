import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

function createBridge(state) {
  const nativeNil = { isNil: () => true }
  const urlForId = id => id === null ? nativeNil : { id, isNil: () => false }
  const answer = key => state.answers[key] ?? { defaultBundleId: null, candidateBundleIds: [] }
  const defaultUrl = key => urlForId(answer(key).defaultBundleId)
  const candidateUrls = key => {
    const ids = answer(key).candidateBundleIds
    if (ids === null) return nativeNil
    if (!Array.isArray(ids)) return { count: 'opaque CF reference' }
    return { count: ids.length, objectAtIndex: index => urlForId(ids[index]) }
  }
  return {
    ObjC: { import() {}, unwrap: value => value },
    $: {
      NSURL: { URLWithString: value => 'scheme:' + value.slice(0, -1) },
      UTType: { typeWithFilenameExtension: value => state.missingType === value ? nativeNil : 'ext:' + value },
      NSBundle: { bundleWithURL: url => ({ bundleIdentifier: url.id }) },
      NSWorkspace: { sharedWorkspace: {
        URLForApplicationToOpenURL: defaultUrl,
        URLsForApplicationsToOpenURL: candidateUrls,
        URLForApplicationToOpenContentType: defaultUrl,
        URLsForApplicationsToOpenContentType: candidateUrls
      } }
    }
  }
}

let instance = 0
async function fixture() {
  const adapters = {
    fixture: `export const state={packaged:true,calls:[],registrations:[],applyChange:false,systemFailed:false,
      plist:{CFBundleIdentifier:'example.custom.shell',CFBundleDocumentTypes:[{CFBundleTypeExtensions:['md','txt']}],CFBundleURLTypes:[{CFBundleURLSchemes:['example-open']}]},
      answers:{}};`,
    electron: `import {state} from 'fixture';export const app={get isPackaged(){return state.packaged},getPath:()=>'/Applications/Custom.app/Contents/MacOS/Custom',
      setAsDefaultProtocolClient:value=>{state.registrations.push(value);if(state.applyChange)state.answers['scheme:'+value]={defaultBundleId:state.plist.CFBundleIdentifier,candidateBundleIds:[state.plist.CFBundleIdentifier]};return true}};
      export const shell={openExternal:async()=>{}};`,
    './registrar': `import {runInNewContext} from 'node:vm';import {state} from 'fixture';
      ${createBridge.toString()}
      export const registrationAvailable=()=>state.packaged;
      export async function run(command,args){state.calls.push({command,args});
        if(command.endsWith('/plutil'))return {code:0,stdout:JSON.stringify(state.plist)};
        if(state.systemFailed)return {code:1,stdout:''};
        return {code:0,stdout:runInNewContext(args[3]+'\\nrun(argv)',
          {...createBridge(state),argv:[args.at(-1)]},{timeout:1000})};}`
  }
  const output = await build({
    stdin: { contents: `export {darwinRegistrar} from '@main/openWith/darwin';export {state} from 'fixture';export const instance=${++instance};`, resolveDir: process.cwd() },
    tsconfig: 'tsconfig.node.json', bundle: true, write: false, platform: 'node', format: 'esm',
    plugins: [{ name: 'darwin-associations', setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path }) => path in adapters ? { path, namespace: 'fixture' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: adapters[path] }))
    } }]
  })
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)
}

test('macOS statuses use the current bundle and system queries, not declaration alone', async () => {
  const { darwinRegistrar, state } = await fixture()
  state.answers['ext:md'] = { defaultBundleId: 'example.custom.shell', candidateBundleIds: [] }
  state.answers['scheme:example-open'] = { defaultBundleId: 'another.app', candidateBundleIds: ['example.custom.shell'] }
  assert.equal(await darwinRegistrar.detect('ext', 'md'), 'default')
  assert.equal(await darwinRegistrar.detect('scheme', 'example-open'), 'candidate')
  assert.equal(await darwinRegistrar.detect('ext', 'txt'), 'unregistered', 'a packaged extension is not evidence of registration')
  assert.equal(state.calls.filter(call => call.command.endsWith('/osascript')).length, 1, 'declared rows are read in one batch')
  assert.equal(await darwinRegistrar.detect('ext', 'novel'), 'unregistered')
  assert.ok(state.calls[0].args.includes('/Applications/Custom.app/Contents/Info.plist'))
  assert.equal(state.calls.some(call => call.command.endsWith('/defaults')), false)
})

test('unavailable or malformed native answers stay unknown', async () => {
  const failed = await fixture()
  failed.state.systemFailed = true
  assert.equal(await failed.darwinRegistrar.detect('ext', 'md'), undefined)
  assert.equal((await failed.darwinRegistrar.setDefault('ext', 'md')).ok, false)
  const malformed = await fixture()
  malformed.state.answers['ext:md'] = { defaultBundleId: 'example.custom.shell', candidateBundleIds: 'invalid' }
  assert.equal(await malformed.darwinRegistrar.detect('ext', 'md'), undefined)
  const invalidId = await fixture()
  invalidId.state.answers['ext:md'] = { defaultBundleId: { opaque: true }, candidateBundleIds: [] }
  assert.equal(await invalidId.darwinRegistrar.detect('ext', 'md'), undefined)
  const missingCandidates = await fixture()
  missingCandidates.state.answers['ext:md'] = { defaultBundleId: null, candidateBundleIds: null }
  assert.equal(await missingCandidates.darwinRegistrar.detect('ext', 'md'), undefined)
  const missingType = await fixture()
  missingType.state.missingType = 'md'
  assert.equal(await missingType.darwinRegistrar.detect('ext', 'md'), undefined)
  const dev = await fixture()
  dev.state.packaged = false
  assert.equal(await dev.darwinRegistrar.detect('ext', 'md'), undefined)
  assert.deepEqual(dev.state.calls, [])
})

test('scheme mutation requires a bundle declaration and confirmed post-change system state', async () => {
  const { darwinRegistrar, state } = await fixture()
  assert.equal((await darwinRegistrar.setDefault('scheme', 'not-packaged')).ok, false)
  assert.deepEqual(state.registrations, [])
  const unconfirmed = await darwinRegistrar.setDefault('scheme', 'example-open')
  assert.equal(unconfirmed.ok, false)
  assert.equal(unconfirmed.status, 'unregistered')
  state.applyChange = true
  assert.deepEqual(await darwinRegistrar.setDefault('scheme', 'example-open'), { ok: true, status: 'default' })
})
