import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../../../', import.meta.url))
async function fixture() {
  const adapters = {
    electron: `export const app={isPackaged:false,getAppPath:()=>'/fixture'}; export class ClipboardItem{}; export const clipboard={write:async()=>{}};`,
    'node:fs': 'export const existsSync=()=>true;',
    'node:child_process': `
      import {EventEmitter} from 'node:events'; import {PassThrough} from 'node:stream';
      export const state={children:[],calls:[]};
      export function spawn(){
        const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.killed=false;
        child.kill=()=>{child.killed=true};
        child.stdin={write(line,done){state.calls.push({child,request:JSON.parse(line)});done?.();return true}};
        state.children.push(child);return child;
      }
      export function reply(call,result){call.child.stdout.write(JSON.stringify({id:call.request.id,result})+'\\n')}
    `,
  }
  const output = await build({
    stdin: {
      resolveDir: root,
      contents: `export * from '@main/clipboard/nativeClipboard'; export {state,reply} from 'node:child_process';`,
    },
    tsconfig: join(root, 'tsconfig.node.json'),
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [
      {
        name: 'native-adapters',
        setup(b) {
          b.onResolve({ filter: /.*/ }, ({ path }) =>
            path in adapters ? { path, namespace: 'mock' } : undefined,
          )
          b.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({
            contents: adapters[path],
            resolveDir: root,
          }))
        },
      },
    ],
  })
  return import(
    `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text + `\n// ${Math.random()}`).toString('base64')}`
  )
}
const flush = async () => {
  for (let i = 0; i < 20; i++)
    await new Promise((resolve) => setImmediate(resolve))
}
async function capture(api) {
  const ready = api.capturePasteTarget()
  api.reply(api.state.calls.at(-1), { token: 'external:1', name: 'Editor' })
  await ready
}

test('migration while capability waits does not hide Quick or issue paste', async () => {
  const api = await fixture()
  await capture(api)
  let current = true,
    hidden = 0
  const result = api.pasteToOriginal(undefined, {
    isCurrent: () => current,
    beforePaste: () => {
      hidden++
    },
  })
  current = false
  api.reply(api.state.calls.at(-1), { paste: true })
  assert.equal((await result).pasted, false)
  assert.equal(hidden, 0)
  assert.equal(
    api.state.calls.some((call) => call.request.command === 'paste'),
    false,
  )
  api.disposeNativeClipboard()
})

test('a normal owned hide permits paste; abort kills that child and suppresses restoration', async () => {
  const api = await fixture()
  await capture(api)
  const controller = new AbortController()
  let hidden = 0,
    restored = 0
  const result = api.pasteToOriginal(controller.signal, {
    isCurrent: () => true,
    beforePaste: () => {
      hidden++
      return () => {
        restored++
      }
    },
  })
  api.reply(api.state.calls.at(-1), { paste: true })
  await flush()
  const sent = api.state.calls.at(-1)
  assert.equal(sent.request.command, 'paste')
  assert.equal(hidden, 1)
  controller.abort()
  assert.equal((await result).pasted, false)
  assert.equal(sent.child.killed, true)
  assert.equal(restored, 0)
  api.disposeNativeClipboard()
})

test('failure cannot restore a retired presentation owner', async () => {
  const api = await fixture()
  await capture(api)
  let current = true,
    restored = 0
  const result = api.pasteToOriginal(undefined, {
    isCurrent: () => current,
    beforePaste: () => () => {
      restored++
    },
  })
  api.reply(api.state.calls.at(-1), { paste: true })
  await flush()
  current = false
  api.reply(api.state.calls.at(-1), { pasted: false, reason: 'target closed' })
  assert.equal((await result).pasted, false)
  assert.equal(restored, 0)
  api.disposeNativeClipboard()
})

test('an old killed helper exit cannot reject or cool down its replacement', async () => {
  const api = await fixture()
  await capture(api)
  const controller = new AbortController()
  const paste = api.pasteToOriginal(controller.signal)
  api.reply(api.state.calls.at(-1), { paste: true })
  await flush()
  const old = api.state.children[0]
  controller.abort()
  await paste
  const replacement = api.nativeCapabilities(),
    newCall = api.state.calls.at(-1)
  assert.notEqual(newCall.child, old)
  old.emit('exit', 0)
  api.reply(newCall, { paste: true, files: true })
  assert.equal((await replacement).paste, true)
  const next = api.nativeCapabilities()
  assert.equal(api.state.calls.at(-1).child, newCall.child)
  api.reply(api.state.calls.at(-1), { paste: true })
  assert.equal((await next).paste, true)
  api.disposeNativeClipboard()
})

test('closing during permission wait prevents delayed file clipboard writes', async () => {
  const api = await fixture(),
    controller = new AbortController()
  const permission = api.requestNativePermission(),
    request = api.state.calls.at(-1)
  const copying = api.writeNativeFiles(['/fixture/file'], controller.signal)
  controller.abort()
  api.reply(request, { paste: true })
  await permission
  await assert.rejects(copying, /aborted/)
  assert.equal(
    api.state.calls.some((call) => call.request.command === 'writeFiles'),
    false,
  )
  api.disposeNativeClipboard()
})
