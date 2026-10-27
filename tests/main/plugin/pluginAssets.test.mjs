import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const PLUGIN = 'fixture.private.images'
const LEGACY_ID = '11111111-1111-4111-8111-111111111111'
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0i8AAAAASUVORK5CYII='
const NEXT_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const pngBytes = dataUrl => Buffer.from(dataUrl.split(',')[1], 'base64')
const reject = (action, expected) => assert.rejects(Promise.resolve().then(action), expected)
const ownerHash = id => createHash('sha256').update(id).digest('hex')
const assetDir = (f, id = PLUGIN) => join(f.directory, 'plugin-assets', ownerHash(id), 'files')
const attachmentDir = (f, id = PLUGIN) => join(f.directory, 'plugin-attachments', ownerHash(id))

async function load(directory) {
  const adapters = {
    'image-fixture-state': `export const state = { directory: ${JSON.stringify(directory)}, beforeWrite: null, beforeRename: null, beforeSync: null };`,
    '@main/paths/pathsService': "import { state } from 'image-fixture-state'; export const getAppPaths = () => ({ data: state.directory });",
    electron: "export const dialog = { showSaveDialog() { throw new Error('An image storage fixture must not open Electron dialogs'); } };",
    '@main/window/createQuickWindow': 'export const acquireQuickInteraction = () => () => {};',
    '@main/plugin/PluginHost': 'export const pluginHost = { getContainerWindow: () => null, acquireWindowInteraction: () => () => {} };',
    '@main/plugin/pluginInteractionPolicy': 'export const assertInteractive = () => {}; export const trackNativeInteraction = value => value;',
    'node:fs/promises': `
      import * as fs from 'fs/promises';
      import { state } from 'image-fixture-state';
      export const { constants, lstat, mkdir, readdir, realpath, rm, writeFile } = fs;
      export async function rename(from, to) {
        if (state.beforeRename) await state.beforeRename(from, to);
        return fs.rename(from, to);
      }
      export async function open(path, ...args) {
        const handle = await fs.open(path, ...args);
        return new Proxy(handle, { get(target, key) {
          if (key === 'writeFile') return async (...values) => {
            if (state.beforeWrite) await state.beforeWrite(path, ...values);
            return target.writeFile(...values);
          };
          if (key === 'sync') return async () => {
            if (state.beforeSync) await state.beforeSync(path);
            return target.sync();
          };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      }
    `,
  }
  const result = await build({
    stdin: {
      resolveDir: ROOT,
      contents: `
        export * from '@main/plugin/pluginAssets';
        export * from '@main/plugin/PluginRuntimeScope';
        export { putPluginBlob as putBlobViaFiles, getPluginBlob as getBlobViaFiles,
          removePluginBlob as removeBlobViaFiles, clearPluginBlobs } from '@main/plugin/pluginFiles';
        export { state } from 'image-fixture-state';
      `,
    },
    tsconfig: join(ROOT, 'tsconfig.node.json'),
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    plugins: [{ name: 'isolated-private-images', setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path }) => Object.hasOwn(adapters, path) ? { path, namespace: 'fixture' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: adapters[path], loader: 'js' }))
    } }],
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

async function withFixture(run) {
  const temporary = await mkdtemp(join(tmpdir(), 'enest-private-images-'))
  const scopes = [], pending = [], releases = []
  let api
  try {
    const directory = await realpath(temporary)
    api = await load(directory)
    await run({
      api, directory, state: api.state,
      scope(id = PLUGIN) {
        const generation = scopes.length + 1
        const scope = api.createRuntimeScope({ pluginId: id, generation, wcId: generation })
        scopes.push(scope)
        return scope
      },
      track(promise) {
        promise.catch(() => {})
        pending.push(promise)
        return promise
      },
      deferred() {
        let resolve
        const promise = new Promise(done => { resolve = done })
        releases.push(resolve)
        return { promise, resolve }
      },
    })
  } finally {
    if (api) Object.assign(api.state, { beforeWrite: null, beforeRename: null, beforeSync: null })
    for (const scope of scopes) scope.markClosing()
    for (const release of releases) release()
    await Promise.allSettled(pending)
    await Promise.allSettled(scopes.map(scope => scope.dispose()))
    await rm(temporary, { recursive: true, force: true })
  }
}

async function boundary(promise) {
  let timer
  try {
    await Promise.race([promise, new Promise((_, fail) => {
      timer = setTimeout(() => fail(new Error('Image operation did not reach its controlled boundary')), 5000)
    })])
  } finally { clearTimeout(timer) }
}

async function writePayload(path, value) {
  if (typeof value !== 'number') { await writeFile(path, value); return value.length }
  // Sparse quota fixtures reserve logical bytes, not a gigabyte of RAM or disk writes.
  const handle = await open(path, 'wx')
  try { await handle.truncate(value) } finally { await handle.close() }
  return value
}

async function seedFlatAsset(f, id, value = pngBytes(PNG), sidecar = 'valid') {
  const dir = assetDir(f)
  await mkdir(dir, { recursive: true })
  const bytes = await writePayload(join(dir, id), value)
  if (sidecar !== 'missing') await writeFile(join(dir, `${id}.meta.json`), sidecar === 'corrupt' ? '{broken' : JSON.stringify({
    assetId: id, name: 'legacy asset', mime: 'image/png', bytes, createdAt: 7,
  }))
}

async function seedAttachment(f, id = LEGACY_ID, value = pngBytes(PNG), sidecar = 'valid') {
  const dir = attachmentDir(f)
  await mkdir(dir, { recursive: true })
  const bytes = await writePayload(join(dir, `${id}.blob`), value)
  if (sidecar !== 'missing') await writeFile(join(dir, `${id}.json`), sidecar === 'corrupt' ? '{broken' : JSON.stringify({ mime: 'image/png', bytes }))
}

test('returned IDs overwrite one resource without duplicating suffixes or changing creation identity', async () => {
  await withFixture(async f => {
    const scope = f.scope()
    const bytes = Uint8Array.from(pngBytes(PNG)).buffer
    const first = await f.api.putPluginAsset(PLUGIN, { assetId: 'cover', bytes, mime: 'image/png', name: 'Cover' })
    const second = await f.api.putPluginAsset(PLUGIN, { assetId: first.assetId, dataUrl: NEXT_PNG })
    assert.equal(first.assetId, 'cover.png')
    assert.equal(second.assetId, first.assetId)
    assert.equal(second.createdAt, first.createdAt)
    assert.equal(second.name, 'Cover')
    assert.equal((await f.api.getPluginAsset(PLUGIN, first.assetId)).dataUrl, NEXT_PNG)
    assert.deepEqual((await f.api.listPluginAssets(PLUGIN)).map(row => row.assetId), ['cover.png'])
    const files = await readdir(assetDir(f))
    assert.equal(files.filter(name => name.startsWith('.asset-')).length, 1)
    assert.equal(files.includes('cover.png.png.meta.json'), false)
    assert.equal(scope.activityCount, 0)

    f.scope('fixture.other.images')
    assert.equal(await f.api.getPluginAsset('fixture.other.images', first.assetId), null)
    await f.api.removePluginAsset('fixture.other.images', first.assetId)
    assert.ok(await f.api.getPluginAsset(PLUGIN, first.assetId))
    await reject(() => f.api.getPluginAsset(PLUGIN, '../cover.png'), /Invalid private image ID/)
  })
})

test('legacy flat assets and UUID attachments share the canonical API and compatibility facades', async () => {
  await withFixture(async f => {
    f.scope()
    await seedFlatAsset(f, 'legacy.png')
    await seedAttachment(f)
    assert.equal((await f.api.getPluginAsset(PLUGIN, 'legacy.png')).dataUrl, PNG)
    assert.equal((await f.api.getPluginAsset(PLUGIN, LEGACY_ID)).dataUrl, PNG)
    assert.equal((await f.api.getBlobViaFiles(PLUGIN, LEGACY_ID)).dataUrl, PNG)
    assert.deepEqual(new Set((await f.api.listPluginAssets(PLUGIN)).map(row => row.assetId)), new Set(['legacy.png', LEGACY_ID]))
    assert.equal(f.api.putBlobViaFiles, f.api.putPluginBlob)
    assert.equal(f.api.removeBlobViaFiles, f.api.removePluginAsset)
    assert.equal(f.api.clearPluginBlobs, f.api.clearPluginAssets)

    const replaced = await f.api.putPluginAsset(PLUGIN, { assetId: LEGACY_ID, dataUrl: NEXT_PNG })
    assert.equal(replaced.assetId, LEGACY_ID)
    assert.equal((await f.api.getBlobViaFiles(PLUGIN, LEGACY_ID)).dataUrl, NEXT_PNG)
    await assert.rejects(readFile(join(attachmentDir(f), `${LEGACY_ID}.blob`)), { code: 'ENOENT' })
    const fresh = await f.api.putBlobViaFiles(PLUGIN, { dataUrl: PNG, name: 'Compatibility image' })
    assert.equal((await f.api.getPluginAsset(PLUGIN, fresh.id)).dataUrl, PNG)
    assert.equal((await f.api.listPluginAssets(PLUGIN)).find(row => row.assetId === fresh.id).name, 'Compatibility image')
    await f.api.removeBlobViaFiles(PLUGIN, fresh.id)
    assert.equal(await f.api.getPluginAsset(PLUGIN, fresh.id), null)
  })
})

test('missing and corrupt sidecars remain discoverable and deletable without losing healthy images', async () => {
  await withFixture(async f => {
    f.scope()
    const healthy = await f.api.putPluginAsset(PLUGIN, { assetId: 'healthy', dataUrl: PNG })
    const damaged = await f.api.putPluginAsset(PLUGIN, { assetId: 'damaged', dataUrl: PNG })
    await writeFile(join(assetDir(f), `${damaged.assetId}.meta.json`), '{broken')
    await seedFlatAsset(f, 'broken-flat.png', pngBytes(PNG), 'corrupt')
    await seedAttachment(f, LEGACY_ID, pngBytes(PNG), 'missing')
    const outside = join(assetDir(f), '..', 'outside.png')
    await writeFile(outside, 'untouched')
    await writeFile(join(assetDir(f), 'unsafe-pointer.png.meta.json'), JSON.stringify({ file: '../outside.png' }))
    const ids = [damaged.assetId, 'broken-flat.png', LEGACY_ID, 'unsafe-pointer.png']
    const listed = await f.api.listPluginAssets(PLUGIN)
    for (const id of ids) {
      const row = listed.find(item => item.assetId === id)
      assert.deepEqual(row, { assetId: id, name: id, mime: 'application/octet-stream', bytes: 0, createdAt: 0 })
      assert.equal(await f.api.removePluginAsset(PLUGIN, id), true)
      assert.equal(await f.api.getPluginAsset(PLUGIN, id), null)
    }
    assert.equal(await readFile(outside, 'utf8'), 'untouched')
    assert.equal((await f.api.getPluginAsset(PLUGIN, healthy.assetId)).dataUrl, PNG)
    assert.deepEqual((await f.api.listPluginAssets(PLUGIN)).map(item => item.assetId), [healthy.assetId])
    assert.equal((await readdir(assetDir(f))).filter(name => name.startsWith('.asset-')).length, 1)
    assert.deepEqual(await readdir(attachmentDir(f)), [])
  })
})

test('legacy attachment and asset bytes consume one quota and shrinking an existing image recovers space', async () => {
  await withFixture(async f => {
    f.scope()
    const size = 32 * 1024 * 1024
    for (let index = 0; index < 16; index++) {
      await seedFlatAsset(f, `existing-${index}.png`, size)
      await seedAttachment(f, randomUUID(), size)
    }
    await reject(() => f.api.putPluginAsset(PLUGIN, { dataUrl: PNG }), /shared 1 GiB quota/)
    await reject(() => f.api.putBlobViaFiles(PLUGIN, { dataUrl: PNG }), /shared 1 GiB quota/)
    await f.api.putPluginAsset(PLUGIN, { assetId: 'existing-0.png', dataUrl: PNG })
    const added = await f.api.putBlobViaFiles(PLUGIN, { dataUrl: PNG })
    assert.equal((await f.api.getPluginAsset(PLUGIN, added.id)).dataUrl, PNG)
    assert.equal((await f.api.listPluginAssets(PLUGIN)).length, 33)
  })
})

test('retired owners reject queued writes and a coalesced uninstall barrier blocks replacement admission', async () => {
  await withFixture(async f => {
    const owner = f.scope(), entered = f.deferred(), gate = f.deferred()
    f.state.beforeWrite = async path => {
      if (basename(path).startsWith('.asset-')) { entered.resolve(); await gate.promise }
    }
    const first = f.track(f.api.putPluginAsset(PLUGIN, { assetId: 'retired-first', dataUrl: PNG }))
    const second = f.track(f.api.putPluginAsset(PLUGIN, { assetId: 'retired-second', dataUrl: PNG }))
    await boundary(entered.promise)
    assert.equal(owner.activityCount, 2)
    await reject(() => f.api.clearPluginAssets(PLUGIN), /Close the plugin runtime/)
    owner.markClosing()
    const clear = f.track(f.api.clearPluginAssets(PLUGIN))
    assert.equal(f.api.clearPluginBlobs(PLUGIN), clear)
    let cleared = false
    void clear.then(() => { cleared = true }, () => {})
    await owner.dispose()
    const replacement = f.scope()
    await reject(() => f.api.putPluginAsset(PLUGIN, { assetId: 'during-clear', dataUrl: PNG }), /retired/)
    assert.equal(cleared, false)
    gate.resolve()
    await assert.rejects(first, /abort|retired/i)
    await assert.rejects(second, /abort|retired/i)
    await clear
    assert.equal(owner.activityCount, 0)
    assert.equal(replacement.activityCount, 0)
    await assert.rejects(readdir(assetDir(f)), { code: 'ENOENT' })
    f.state.beforeWrite = null
    const fresh = await f.api.putPluginAsset(PLUGIN, { assetId: 'replacement', dataUrl: NEXT_PNG })
    assert.equal((await f.api.getPluginAsset(PLUGIN, fresh.assetId)).dataUrl, NEXT_PNG)
    assert.deepEqual((await f.api.listPluginAssets(PLUGIN)).map(row => row.assetId), [fresh.assetId])
  })
})

test('a metadata publish failure removes only the uncommitted generation and preserves the old pointer', async () => {
  await withFixture(async f => {
    const owner = f.scope()
    const first = await f.api.putPluginAsset(PLUGIN, { assetId: 'preserved', dataUrl: PNG })
    const metadata = join(assetDir(f), `${first.assetId}.meta.json`)
    const original = await readFile(metadata, 'utf8')
    const originalFiles = (await readdir(assetDir(f))).sort()
    f.state.beforeRename = async (_from, to) => {
      if (to === metadata) throw new Error('fixture metadata publish failed')
    }
    await reject(() => f.api.putPluginAsset(PLUGIN, { assetId: first.assetId, dataUrl: NEXT_PNG }), /fixture metadata publish failed/)
    assert.equal(await readFile(metadata, 'utf8'), original)
    assert.equal((await f.api.getPluginAsset(PLUGIN, first.assetId)).dataUrl, PNG)
    assert.deepEqual((await readdir(assetDir(f))).sort(), originalFiles)
    assert.equal(owner.activityCount, 0)
  })
})

test('post-commit directory sync failures report uncertain durability without unlinking the committed image', {
  skip: process.platform === 'win32' ? 'The service does not fsync directory handles on Windows' : false,
}, async () => {
  await withFixture(async f => {
    f.scope()
    const first = await f.api.putPluginAsset(PLUGIN, { assetId: 'durability', dataUrl: PNG })
    let directorySyncs = 0
    f.state.beforeSync = async path => {
      if (path === assetDir(f) && ++directorySyncs === 2) throw new Error('fixture directory sync failed')
    }
    await reject(() => f.api.putPluginAsset(PLUGIN, { assetId: first.assetId, dataUrl: NEXT_PNG }), /committed but its durability is uncertain/)
    assert.equal((await f.api.getPluginAsset(PLUGIN, first.assetId)).dataUrl, NEXT_PNG)
    f.state.beforeSync = null
    await f.api.removePluginAsset(PLUGIN, first.assetId)
    assert.deepEqual(await readdir(assetDir(f)), [])
  })
})
