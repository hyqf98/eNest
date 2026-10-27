import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const registrySource = readFileSync(new URL('../../../src/main/plugin/PluginRegistry.ts', import.meta.url), 'utf8')
const installerSource = readFileSync(new URL('../../../src/main/plugin/PluginInstaller.ts', import.meta.url), 'utf8')
const installerAst = ts.createSourceFile('PluginInstaller.ts', installerSource, ts.ScriptTarget.Latest, true)
const folderInstaller = installerAst.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'installFromFolder').getText(installerAst)
const id = 'org.example.tool'

function evaluate(source, bindings) {
  const module = { exports: {} }
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('module', 'exports', ...Object.keys(bindings), output)(module, module.exports, ...Object.values(bindings))
  return module.exports
}

function fixture() {
  const appRoot = '/fixture/app', checkoutRoot = join(appRoot, 'eNest_plugin', 'plugins'), installedRoot = '/fixture/installed'
  const state = {
    app: { isPackaged: false, getAppPath: () => appRoot }, manifests: new Map(), projects: new Set(),
    installs: [], mkdirs: [], renames: [], published: [], copiedManifest: undefined, nextStage: 0
  }
  const readManifest = async root => {
    const manifest = state.manifests.get(root)
    if (!manifest) throw new Error(`missing manifest: ${root}`)
    return structuredClone(manifest)
  }
  // Exercise the production transaction body with filesystem/schema boundaries mocked, not a second installer implementation.
  const installer = evaluate(folderInstaller, {
    join, installFromDirectory: readManifest, beginPluginInstall: () => 1,
    withInstallLock: async (_id, operation) => operation(), assertInstallCurrent() {}, lifecycleHooks: {},
    mkdir: async root => { state.mkdirs.push(root) },
    mkdtemp: async prefix => `${prefix}${++state.nextStage}`,
    randomUUID: () => 'fixture',
    cp: async (source, stage) => { state.manifests.set(stage, structuredClone(state.copiedManifest ?? state.manifests.get(source))) },
    writePluginBuildRevision: async () => 'fixture-revision',
    existsSync: () => false,
    rename: async (from, to) => { state.renames.push([from, to]); state.manifests.set(to, state.manifests.get(from)); state.manifests.delete(from) },
    rm: async root => { state.manifests.delete(root) }, logInfo() {}, logWarn() {}
  })
  const mocks = {
    electron: { app: state.app },
    'node:path': { join },
    'node:fs': { existsSync: file => state.manifests.has(file.slice(0, -'/plugin.json'.length)) },
    'node:fs/promises': {
      readdir: async root => {
        if (root === installedRoot) return []
        if (root === checkoutRoot) return [...state.projects]
        throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      },
      stat: async () => ({ mtimeMs: 1, isDirectory: () => true }), rm: async () => {}
    },
    '@shared/types/plugin': { resolvePluginUi: value => value ?? {} },
    '@shared/constants': { pluginProtocolUrl: (pluginId, file) => `enest-plugin://${pluginId}/${file}` },
    '@main/paths/pathsService': { getAppPaths: () => ({ plugins: installedRoot }) },
    '@main/plugin/PluginInstaller': {
      installFromDirectory: readManifest,
      installFromFolder: async (...args) => {
        state.installs.push({ root: args[0], expected: args[5] })
        const publish = args[4]
        args[4] = result => { state.published.push(result); publish?.(result) }
        return installer.installFromFolder(...args)
      }
    },
    '@main/plugin/marketClient': { fetchRemoteMarket: async () => [] },
    '@main/plugin/pluginEnabledStore': { isEnabledSync: () => true, loadDisabledIds: async () => {} },
    '@main/plugin/PermissionService': { permissionService: { cancelFor() {} } },
    '@main/contrib/ContributionRegistry': { contributionRegistry: { listSlot: () => [], registerManifestContributes() {}, unregisterBySource() {} } },
    '@main/theme/themePacks': { themePackRegistry: {} },
    '@main/window/createShellWindow': { sendShellEvent() {} },
    '@main/logs/logService': { logInfo() {}, logWarn() {} },
    './pluginInstallTasks': {}, './catalogResources': {},
    '@main/plugin/marketMetadata': {
      manifestCategory: () => 'Other', manifestScreenshots: () => [], marketTags: () => [],
      mergeMarketMetadata: summary => summary
    }
  }
  const { PluginRegistry } = evaluate(registrySource, { require: name => {
    if (!(name in mocks)) throw new Error(`unexpected fixture import: ${name}`)
    return mocks[name]
  } })
  const registry = new PluginRegistry()
  const manifest = (pluginId = id, version = '1.0.0') => ({ id: pluginId, version, name: 'Tool', main: 'index.html' })
  const addProject = ({ pluginId = id, built = true } = {}) => {
    const name = pluginId.split('.').at(-1), root = join(checkoutRoot, name)
    state.projects.add(name)
    state.manifests.set(root, manifest(pluginId))
    if (built) state.manifests.set(join(root, 'dist'), manifest(pluginId))
    return root
  }
  return { state, registry, installer, manifest, addProject }
}

test('an existing checkout must be scanned before it can supply an installation', async () => {
  const f = fixture()
  f.addProject()
  await assert.rejects(f.registry.installLocalPreview(id), /local preview build not found/)
  assert.equal(f.state.installs.length, 0)
})

test('same-suffix third-party identities never resolve an unrelated local preview', async () => {
  const f = fixture()
  f.addProject()
  await f.registry.scan()
  await assert.rejects(f.registry.installLocalPreview('net.other.tool'), /local preview build not found/)
  assert.equal(f.state.installs.length, 0)
  assert.equal(f.state.published.length, 0)
})

test('a matching scanned distribution installs with the complete expected identity', async () => {
  const f = fixture(), root = f.addProject()
  await f.registry.scan()
  const result = await f.registry.installLocalPreview(id)
  assert.equal(result.id, id)
  assert.equal(result.installed, true)
  assert.deepEqual(f.state.installs, [{ root: join(root, 'dist'), expected: { id } }])
  assert.equal(f.state.published.length, 1)
})

test('packaged applications cannot use even previously scanned local previews', async () => {
  const f = fixture()
  f.addProject()
  await f.registry.scan()
  f.state.app.isPackaged = true
  await assert.rejects(f.registry.installLocalPreview(id), /packaged application/)
  const remote = []
  f.registry.remoteMarket = [{ id, assetUrl: 'https://example.invalid/tool.enestplugin' }]
  f.registry.installFromRemote = async pluginId => { remote.push(pluginId); return { id: pluginId, installed: true } }
  await f.registry.ensureInstalled(id)
  assert.deepEqual(remote, [id])
  assert.equal(f.state.installs.length, 0)
})

test('source-only previews stay browsable and require a built distribution to install', async () => {
  const f = fixture(), root = f.addProject({ built: false })
  await f.registry.scan()
  assert.equal(f.registry.get(id).installed, false)
  await assert.rejects(f.registry.installLocalPreview(id), /local preview build not found/)
  f.state.manifests.set(join(root, 'dist'), f.manifest())
  const installed = await f.registry.installLocalPreview(id)
  assert.equal(installed.id, id)
  assert.equal(f.state.installs[0].root, join(root, 'dist'))
})

test('a disk identity change after scanning fails before staging or publication', async () => {
  const f = fixture(), root = f.addProject()
  await f.registry.scan()
  f.state.manifests.set(join(root, 'dist'), f.manifest('net.other.tool'))
  await assert.rejects(f.registry.installLocalPreview(id))
  assert.equal(f.state.mkdirs.length, 0)
  assert.equal(f.state.renames.length, 0)
  assert.equal(f.state.published.length, 0)
  assert.equal(f.registry.get('net.other.tool'), null)
})

test('changing manifest identity during a copy fails before replacing the installed build', async () => {
  const f = fixture()
  f.addProject()
  await f.registry.scan()
  f.state.copiedManifest = f.manifest('net.other.tool')
  await assert.rejects(f.registry.installLocalPreview(id))
  assert.equal(f.state.renames.length, 0)
  assert.equal(f.state.published.length, 0)
  assert.equal(f.registry.get(id).installed, false)
})

test('optional expected versions reject mismatches before creating the destination', async () => {
  const f = fixture(), root = f.addProject()
  await assert.rejects(f.installer.installFromFolder(join(root, 'dist'), '/fixture/installed', undefined, undefined, undefined, { id, version: '2.0.0' }))
  assert.equal(f.state.mkdirs.length, 0)
  assert.equal(f.state.renames.length, 0)
})

test('a rescan retires removed local preview identities', async () => {
  const f = fixture(), root = f.addProject()
  await f.registry.scan()
  f.state.projects.clear()
  f.state.manifests.delete(root)
  f.state.manifests.delete(join(root, 'dist'))
  await f.registry.scan()
  assert.equal(f.registry.get(id), null)
  await assert.rejects(f.registry.installLocalPreview(id), /local preview build not found/)
})
