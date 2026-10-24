import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SOURCE = 'focus-timers-v1', OWNER = 'fixture.timer'
const document = () => JSON.stringify({ version: 1, timers: { [OWNER]: { arbitrary: 'opaque fixture payload', state: { phase: 'owned-by-plugin' } } } })

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'enest-legacy-timer-fixture-'))
  const sources = {
    fixture: `
      export const state={rows:new Map(),markers:new Map(),reads:0,opens:0,afterRead:null};
      export const getAppPaths=()=>({data:${JSON.stringify(directory)}});
      const db={exec(){},prepare(){return{run(pluginId,key,value){const id=pluginId+'\\0'+key;if(!state.rows.has(id))state.rows.set(id,value)}}}};
      export const kvStore={getDatabase:()=>db,kvGet:key=>state.markers.get(key),kvSet:(key,value)=>state.markers.set(key,value)};
      export function runInTransaction(db,run){const rows=new Map(state.rows),markers=new Map(state.markers);try{return run()}catch(error){state.rows=rows;state.markers=markers;throw error}}
    `,
    fs: `
      import * as fs from 'node:fs/promises';import {state} from 'fixture';
      export const lstat=fs.lstat;
      export async function open(...args){state.opens++;const file=await fs.open(...args);return new Proxy(file,{get(target,key){if(key==='read')return async(...input)=>{state.reads++;const result=await target.read(...input);if(state.afterRead){const callback=state.afterRead;state.afterRead=null;await callback()}return result};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}})};
    `
  }
  const result = await build({
    stdin: { contents: `export * from './src/main/timer/legacyTimerMigration.ts';export {state} from 'fixture';`, resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'isolated-timer-migration', setup(api) {
      api.onResolve({ filter: /^(fixture|@main\/paths\/pathsService|@main\/db\/sqliteService)$/ }, () => ({ path: 'fixture', namespace: 'fixture' }))
      api.onResolve({ filter: /^node:fs\/promises$/ }, ({ namespace }) => namespace === 'fixture' ? { path: 'node:fs/promises', external: true } : { path: 'fs', namespace: 'fixture' })
      api.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: sources[path], loader: 'js' }))
    } }]
  })
  const api = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text + `\n// ${Math.random()}`).toString('base64')}`)
  return { ...api, directory, path: join(directory, `${SOURCE}.json`), cleanup: () => rm(directory, { recursive: true, force: true }) }
}

test('fixed legacy timer source remains opaque, retains the original, and commits an idempotent transaction marker', async () => {
  const f = await fixture()
  try {
    await f.migrateLegacyTimerPayloads()
    assert.equal(f.state.markers.size, 0)
    const original = document()
    await writeFile(f.path, original)
    await f.migrateLegacyTimerPayloads()
    const descriptor = JSON.parse(f.state.rows.get(`${OWNER}\0_enest_migration.${SOURCE}`))
    assert.deepEqual(descriptor, { version: 1, chunks: 1 })
    const payload = JSON.parse(f.state.rows.get(`${OWNER}\0_enest_migration.${SOURCE}.0`))
    assert.deepEqual(JSON.parse(payload), JSON.parse(original).timers[OWNER])
    assert.equal(await readFile(f.path, 'utf8'), original)
    assert.equal(f.state.markers.has(`migration:${SOURCE}`), true)
    const reads = f.state.reads
    await writeFile(f.path, 'invalid later fixture data')
    await f.migrateLegacyTimerPayloads()
    assert.equal(f.state.reads, reads)
    assert.equal(f.state.rows.size, 2)
  } finally { await f.cleanup() }
})

test('legacy timer symlinks are rejected before any file is opened or read', async () => {
  const f = await fixture()
  try {
    const outside = join(f.directory, 'outside.json')
    await writeFile(outside, document())
    await symlink(outside, f.path)
    await assert.rejects(f.migrateLegacyTimerPayloads(), /regular file/)
    assert.equal(f.state.opens, 0)
    assert.equal(f.state.reads, 0)
    assert.equal(f.state.markers.size, 0)
    assert.equal(await readFile(outside, 'utf8'), document())
  } finally { await f.cleanup() }
})

test('oversized sparse legacy timer files fail before buffer allocation or reads', async () => {
  const f = await fixture()
  try {
    const file = await open(f.path, 'wx')
    try { await file.truncate(64 * 1024 * 1024 + 1) } finally { await file.close() }
    await assert.rejects(f.migrateLegacyTimerPayloads(), /migration limit/)
    assert.equal(f.state.opens, 0)
    assert.equal(f.state.reads, 0)
    assert.equal(f.state.rows.size, 0)
  } finally { await f.cleanup() }
})

test('content changes during bounded reads cannot import a mixed snapshot or write the migration marker', async () => {
  const f = await fixture()
  try {
    await writeFile(f.path, document())
    f.state.afterRead = () => writeFile(f.path, '{"fixture":"changed while reading"}')
    await assert.rejects(f.migrateLegacyTimerPayloads(), /changed while reading/)
    assert.equal(f.state.markers.size, 0)
    assert.equal(f.state.rows.size, 0)
  } finally { await f.cleanup() }
})

test('replacing a source path with same-length bytes cannot bypass the opened inode identity check', async () => {
  const f = await fixture()
  try {
    const original = document(), retained = join(f.directory, 'original-retained.json')
    await writeFile(f.path, original)
    f.state.afterRead = async () => { await rename(f.path, retained); await writeFile(f.path, original) }
    await assert.rejects(f.migrateLegacyTimerPayloads(), /changed while reading/)
    assert.equal(f.state.markers.size, 0)
    assert.equal(f.state.rows.size, 0)
    assert.equal(await readFile(retained, 'utf8'), original)
  } finally { await f.cleanup() }
})
