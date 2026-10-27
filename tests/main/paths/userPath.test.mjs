import assert from 'node:assert/strict'
import test from 'node:test'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { build } from 'esbuild'

const result = await build({ entryPoints: ['src/main/paths/userPath.ts'], tsconfig: 'tsconfig.node.json', bundle: true, write: false, format: 'esm', platform: 'node' })
const { resolveLocalUserPath } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))

for (const platform of ['darwin', 'linux']) {
  const options = { platform, baseDir: '/workspace/eNest', homeDir: '/home/tester' }
  test(`${platform}: home expansion and relative paths use only the declared base`, () => {
    assert.equal(resolveLocalUserPath('~', options), '/home/tester')
    assert.equal(resolveLocalUserPath('~/Plugins/../插件 demo', options), '/home/tester/插件 demo')
    assert.equal(resolveLocalUserPath('~//Plugins', options), '/home/tester/Plugins')
    assert.equal(resolveLocalUserPath('.', options), '/workspace/eNest')
    assert.equal(resolveLocalUserPath('./plugins/../source', options), '/workspace/eNest/source')
    assert.equal(resolveLocalUserPath('../another', options), '/workspace/another')
    assert.equal(resolveLocalUserPath('/opt/plugins', options), '/opt/plugins')
    assert.equal(resolveLocalUserPath('/opt/name with trailing space ', options), '/opt/name with trailing space ')
    assert.equal(resolveLocalUserPath('literal\\name', options), '/workspace/eNest/literal\\name')
  })
  test(`${platform}: foreign Windows, home-of-another-user and remote inputs do not turn into local paths`, () => {
    for (const input of ['C:\\plugins', 'C:/plugins', '\\\\server\\share', '~another/plugins', '~\\plugins', 'ssh://host/home/a', 'user@host:/home/a', 'host:/home/a', 'https://example.com', 'file:///home/a']) {
      assert.throws(() => resolveLocalUserPath(input, options), /不支持|仅支持|本地路径/)
    }
  })
}

const windows = { platform: 'win32', baseDir: 'D:\\work\\eNest', homeDir: 'C:\\Users\\Tester' }
test('win32: current home, explicit-base relative paths, drives and UNC shares keep Windows semantics', () => {
  assert.equal(resolveLocalUserPath('~', windows), 'C:\\Users\\Tester')
  assert.equal(resolveLocalUserPath('~/Plugins', windows), 'C:\\Users\\Tester\\Plugins')
  assert.equal(resolveLocalUserPath('~\\Plugins', windows), 'C:\\Users\\Tester\\Plugins')
  assert.equal(resolveLocalUserPath('.', windows), 'D:\\work\\eNest')
  assert.equal(resolveLocalUserPath('.\\plugins\\..\\source', windows), 'D:\\work\\eNest\\source')
  assert.equal(resolveLocalUserPath('../another', windows), 'D:\\work\\another')
  assert.equal(resolveLocalUserPath('\\plugins', windows), 'D:\\plugins')
  assert.equal(resolveLocalUserPath('C:/Plugins/../Source', windows), 'C:\\Source')
  assert.equal(resolveLocalUserPath('\\\\server\\share\\plugins\\..\\source', windows), '\\\\server\\share\\source')
  assert.equal(resolveLocalUserPath('//server/share/source', windows), '\\\\server\\share\\source')
  assert.equal(resolveLocalUserPath('./source', { ...windows, baseDir: '\\\\server\\share\\work' }), '\\\\server\\share\\work\\source')
})

test('win32: ambiguous drive-relative, incomplete UNC and device paths fail explicitly', () => {
  for (const input of ['C:plugins', 'C:', '\\\\server', '\\\\?\\C:\\plugins', '\\\\.\\pipe\\name']) {
    assert.throws(() => resolveLocalUserPath(input, windows), /绝对路径|UNC|设备/)
  }
  assert.throws(() => resolveLocalUserPath('.', { ...windows, baseDir: '\\work' }), /绝对基准/)
  assert.throws(() => resolveLocalUserPath('~', { ...windows, homeDir: '/home/tester' }), /用户目录/)
})

test('no implicit shell expansion or process-relative base is introduced', () => {
  const options = { platform: 'linux', baseDir: '/workspace', homeDir: '/home/tester' }
  for (const input of ['', '  ', '\0', '/tmp/a\0b']) assert.throws(() => resolveLocalUserPath(input, options), /不能为空|空字符/)
  assert.throws(() => resolveLocalUserPath('./plugin', { ...options, baseDir: 'relative' }), /绝对基准/)
  assert.equal(resolveLocalUserPath('$HOME/plugin', options), '/workspace/$HOME/plugin')
  assert.equal(resolveLocalUserPath('$(touch file)', options), '/workspace/$(touch file)')
  assert.equal(resolveLocalUserPath('~/plugin', { baseDir: process.cwd() }), join(homedir(), 'plugin'))
  assert.equal(resolveLocalUserPath('.', { baseDir: process.cwd() }), resolve('.'))
})
