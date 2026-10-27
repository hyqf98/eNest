/** npm run build && build/pack all four backend plugins, then ENEST_INSTALL_ARTIFACT_SMOKE=1 node --test tests/main/plugin/pluginInstaller.artifact.smoke.test.mjs */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'

async function loadInstaller() {
  globalThis.__artifactInstallHostVersion = '0.2.0'
  const adapters = {
    electron: `export const app={getAppPath:()=>process.cwd(),getVersion:()=>globalThis.__artifactInstallHostVersion};`,
    '@main/logs/logService': `export const logInfo=()=>{};export const logWarn=()=>{};`
  }
  const bundle = await build({ stdin: { contents: `export {installFromZip,installFromDirectory,collectManifestIssues} from '@main/plugin/PluginInstaller';`, resolveDir: process.cwd() }, tsconfig: 'tsconfig.node.json', bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'artifact-host', setup(b) {
    b.onResolve({ filter: /.*/ }, x => x.path in adapters ? { path: x.path, namespace: 'adapter' } : undefined)
    b.onLoad({ filter: /.*/, namespace: 'adapter' }, x => ({ contents: adapters[x.path], loader: 'js' }))
  } }] })
  return import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))
}
function hashWithProductionWorker(root) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(process.cwd(), 'out/main/pluginInstallWorker.js'), { workerData: { action: 'hash', root } })
    const timer = setTimeout(() => { void worker.terminate(); reject(Error('hash worker timed out')) }, 120000)
    worker.once('error', error => { clearTimeout(timer); reject(error) })
    worker.once('message', message => { clearTimeout(timer); void worker.terminate(); message.ok ? resolve(message.result) : reject(Error(message.error)) })
  })
}

test('four release archives install through real extraction/hash workers; old host and mismatched identity are rejected', { skip: process.env.ENEST_INSTALL_ARTIFACT_SMOKE !== '1', timeout: 600000 }, async () => {
  assert.ok(existsSync('out/main/pluginInstallWorker.js'), 'Build host before testing actual release archives')
  const api = await loadInstaller(), dir = await mkdtemp(join(tmpdir(), 'enest-release-install-')), dest = join(dir, 'installed')
  const artifacts = [], root = process.cwd()
  try {
    for (const suffix of ['database', 'middleware', 'ssh', 'remote-desktop']) {
      const id = `com.github.eNest.${suffix}`, source = join(root, 'eNest_plugin/plugins', id), dist = join(source, 'dist')
      const manifest = JSON.parse(await readFile(join(source, 'plugin.json'), 'utf8'))
      const archive = join(root, 'eNest_plugin/dist', `${id}@${manifest.version}.enestplugin`)
      assert.ok(existsSync(archive), `Build and pack ${id}@${manifest.version} first`)
      assert.equal(manifest.engines.enest, '>=0.2.0')
      const progress = [], published = [], started = performance.now()
      const installed = await api.installFromZip(archive, dest, (percent, step) => progress.push({ percent, step }), undefined, result => published.push(result.dest), { id, version: manifest.version })
      assert.deepEqual(published, [installed.dest])
      assert.equal(installed.dest, join(dest, id, manifest.version))
      assert.equal(installed.manifest.backend.entry, 'backend/index.cjs')
      assert.match(installed.buildRevision, /^[a-f0-9]{64}$/)
      assert.equal((await api.installFromDirectory(installed.dest)).id, id)
      assert.equal(JSON.parse(await readFile(join(installed.dest, '.enest-build.json'), 'utf8')).revision, installed.buildRevision)
      assert.equal(await hashWithProductionWorker(dist), installed.buildRevision, 'ZIP installation must retain the exact built distribution tree')
      assert.equal(await hashWithProductionWorker(installed.dest), installed.buildRevision, 'published copy must retain the recorded content hash')
      const dependencyRoots = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).enestBackend.dependencies
      for (const dependency of dependencyRoots) assert.ok((await stat(join(installed.dest, 'backend/node_modules', dependency, 'package.json'))).isFile(), dependency)
      if (suffix === 'database') for (const platform of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']) {
        const files = await readdir(join(installed.dest, 'backend/node_modules/@duckdb', `node-bindings-${platform}`))
        assert.ok(files.some(file => file.endsWith('.node')), platform)
      }
      const archiveBytes = (await stat(archive)).size
      artifacts.push({ id, version: manifest.version, archive, archiveBytes, archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'), buildRevision: installed.buildRevision, dependencyRoots, elapsedMs: Math.round(performance.now()-started), progress })
    }
    assert.deepEqual((await readdir(dest)).sort(), artifacts.map(x => x.id).sort(), 'successful installations leave no staging/backup directories')
    const small = [...artifacts].sort((a,b) => a.archiveBytes-b.archiveBytes)[0], rejected = join(dir, 'rejected')
    globalThis.__artifactInstallHostVersion = '0.1.0'
    await assert.rejects(api.installFromZip(small.archive, rejected), /不满足当前壳子版本 0\.1\.0/)
    assert.equal(existsSync(rejected), false)
    globalThis.__artifactInstallHostVersion = '0.2.0'
    for (const expected of [{ id: 'com.test.wrong', version: small.version }, { id: small.id, version: '99.0.0' }]) {
      await assert.rejects(api.installFromZip(small.archive, rejected, undefined, undefined, () => assert.fail('invalid identity was published'), expected), /身份与市场版本不一致/)
      assert.equal(existsSync(rejected), false)
    }
    const evidence = { artifacts, oldHostRejected: true, wrongIdRejected: true, wrongVersionRejected: true, tempRoot: dir, worker: join(root, 'out/main/pluginInstallWorker.js'), note: 'Real host installFromZip, production worker extraction and hashing, staged-copy validation. Only Electron app identity and log output are mocked. No user data path is used.' }
    if (process.env.ENEST_INSTALL_ARTIFACT_EVIDENCE) await writeFile(process.env.ENEST_INSTALL_ARTIFACT_EVIDENCE, JSON.stringify(evidence, null, 2))
    console.log('Release install evidence:', JSON.stringify(artifacts.map(({id,version,archiveBytes,elapsedMs,buildRevision})=>({id,version,archiveBytes,elapsedMs,buildRevision}))))
  } finally { globalThis.__artifactInstallHostVersion = '0.2.0'; await rm(dir, { recursive: true, force: true }) }
})
