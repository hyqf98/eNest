import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { collectBundledLicenses, rendererPackages } from '../../tools/packaging/collect-bundled-licenses.mjs'

const repository = fileURLToPath(new URL('../../', import.meta.url))

test('retains the actual bundled main undici notice without dropping renderer roots', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'enest-bundled-main-license-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const outputDir = join(temporary, 'bundled-ui')
  const project = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'))
  assert.ok(Object.hasOwn(project.devDependencies, 'undici'))
  const require = createRequire(join(repository, 'package.json'))
  const installedDir = dirname(require.resolve('undici/package.json'))
  const installed = JSON.parse(await readFile(join(installedDir, 'package.json'), 'utf8'))
  const rendererRoots = await rendererPackages(join(repository, 'src/renderer'))
  const manifest = await collectBundledLicenses({ projectDir: repository, outputDir })

  assert.ok(rendererRoots.length > 0)
  assert.deepEqual(manifest.rendererRoots, rendererRoots)
  assert.deepEqual(manifest.mainRoots, ['undici'])
  assert.deepEqual(manifest.roots, [...new Set([...rendererRoots, 'undici'])].sort())
  for (const name of rendererRoots) assert.ok(manifest.packages.some(item => item.name === name), `Missing renderer notice: ${name}`)
  assert.match(manifest.source, /bundled main runtime packages/)
  const undici = manifest.packages.find(item => item.name === 'undici' && item.version === installed.version)
  assert.ok(undici)
  assert.equal(undici.license, installed.license)
  assert.ok(undici.files.includes('LICENSE'))
  assert.deepEqual(
    await readFile(join(outputDir, undici.destination, 'LICENSE')),
    await readFile(join(installedDir, 'LICENSE'))
  )
  assert.deepEqual(JSON.parse(await readFile(join(outputDir, 'manifest.json'), 'utf8')), manifest)
})

test('isolated renderer projects do not require undeclared main seeds or scan native harness imports', async t => {
  const projectDir = await mkdtemp(join(tmpdir(), 'enest-bundled-main-isolated-'))
  t.after(() => rm(projectDir, { recursive: true, force: true }))
  await mkdir(join(projectDir, 'src/renderer'), { recursive: true })
  await mkdir(join(projectDir, 'src/main'), { recursive: true })
  await writeFile(join(projectDir, 'package.json'), JSON.stringify({ devDependencies: { esbuild: '0.25.0' } }))
  await writeFile(join(projectDir, 'src/renderer/main.ts'), "import 'ui-library'; import type { Example } from 'type-only-package';")
  await writeFile(join(projectDir, 'src/main/capture.native.mjs'), "import 'esbuild'; import 'undici';")
  for (const [name, dependencies] of [['ui-library', { 'nested-library': '1.0.0' }], ['nested-library', {}]]) {
    const dir = join(projectDir, 'node_modules', name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', license: 'MIT', dependencies }))
    await writeFile(join(dir, 'LICENSE'), `Copyright ${name}; permission notice`)
  }

  const manifest = await collectBundledLicenses({ projectDir })
  assert.deepEqual(manifest.rendererRoots, ['ui-library'])
  assert.deepEqual(manifest.mainRoots, [])
  assert.deepEqual(manifest.roots, ['ui-library'])
  assert.deepEqual(manifest.packages.map(item => item.name), ['nested-library', 'ui-library'])
  assert.equal(
    await readFile(join(projectDir, 'out/licenses/bundled-ui/nested-library@1.0.0/LICENSE'), 'utf8'),
    'Copyright nested-library; permission notice'
  )
})
