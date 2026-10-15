import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { collectBundledLicenses } from './collect-bundled-licenses.mjs'

test('retains bundled direct and transitive notices while excluding tests and type-only imports', async t => {
  const projectDir = await mkdtemp(join(tmpdir(), 'enest-license-test-'))
  t.after(() => rm(projectDir, { recursive: true, force: true }))
  await mkdir(join(projectDir, 'src/renderer'), { recursive: true })
  await writeFile(join(projectDir, 'package.json'), '{}')
  await writeFile(join(projectDir, 'src/renderer/main.ts'), "import 'ui-library'; import type { Example } from 'type-only-package'; import './local';")
  await writeFile(join(projectDir, 'src/renderer/main.test.mjs'), "import 'test-only-package'")
  for (const [name, dependencies] of [['ui-library', { 'nested-library': '1.0.0' }], ['nested-library', {}]]) {
    const dir = join(projectDir, 'node_modules', name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', license: 'MIT', dependencies }))
    await writeFile(join(dir, 'LICENSE'), `Copyright ${name}; permission notice`)
  }
  const manifest = await collectBundledLicenses({ projectDir })
  assert.deepEqual(manifest.roots, ['ui-library'])
  assert.deepEqual(manifest.packages.map(item => item.name), ['nested-library', 'ui-library'])
  assert.match(await readFile(join(projectDir, 'out/licenses/bundled-ui/nested-library@1.0.0/LICENSE'), 'utf8'), /Copyright nested-library/)
  await rm(join(projectDir, 'node_modules/nested-library/LICENSE'))
  await assert.rejects(collectBundledLicenses({ projectDir }), /has no license notice/)
})
