import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm, mkdir, stat, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))

// localFiles 依赖 electron（app/dialog/nativeImage/shell）；rename 路径只用
// dialog/shell 之外的能力 —— stub 掉 electron 模块即可在纯 node 跑。
const localFilesPath = fileURLToPath(new URL('../../../src/main/plugin/localFiles.ts', import.meta.url))
const pluginHostPath = fileURLToPath(new URL('../../../src/main/plugin/PluginHost.ts', import.meta.url))
const quickPath = fileURLToPath(new URL('../../../src/main/window/createQuickWindow.ts', import.meta.url))
const activityPath = fileURLToPath(new URL('../../../src/main/plugin/activityRegistry.ts', import.meta.url))
const entry = `export * from ${JSON.stringify(localFilesPath)};\n`
const result = await build({
  stdin: { contents: entry, resolveDir: root, loader: 'js' },
  tsconfig: root + 'tsconfig.node.json',
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  plugins: [
    {
      name: 'stub-deps',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
        b.onLoad({ filter: /^electron$/ }, () => ({
          contents: 'export const app = {}; export const dialog = {}; export const nativeImage = { createEmpty: () => ({}) }; export const shell = { showItemInFolder: () => {} }'
        }))
        b.onResolve({ filter: /^@main\/plugin\/PluginHost$/ }, () => ({ path: 'host', namespace: 'stub' }))
        b.onLoad({ filter: /^host$/ }, () => ({
          contents: 'export const pluginHost = { getContainerWindow: () => null, getWebContents: () => null, isOpened: () => true, sendEvent: () => {} }'
        }))
        b.onResolve({ filter: /^@main\/window\/createQuickWindow$/ }, () => ({ path: 'quick', namespace: 'stub' }))
        b.onLoad({ filter: /^quick$/ }, () => ({
          contents: 'export const acquireQuickInteraction = () => () => {}'
        }))
        b.onResolve({ filter: /^@main\/plugin\/activityRegistry$/ }, () => ({ path: 'activity', namespace: 'stub' }))
        b.onLoad({ filter: /^activity$/ }, () => ({
          contents: 'export const acquirePluginActivity = () => () => {}'
        }))
      }
    }
  ]
})
const api = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))

const PLUGIN = 'test.rename.plugin'

test('fs.rename：路径攻击防御矩阵（../、绝对路径、分隔符、盘符、点开头、保留名）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rn-'))
  const target = join(dir, 'victim.txt')
  await writeFile(target, 'keep', 'utf-8')
  const handle = await api.grantLocalFile(PLUGIN, target)
  const sibling = join(dir, 'sibling-secret.txt')
  await writeFile(sibling, 'secret', 'utf-8')

  const attacks = [
    '../escape.txt',        // 相对逃逸
    '../../escape.txt',     // 多级逃逸
    'a/../escape.txt',      // 内联逃逸
    '/etc/passwd',          // 绝对路径
    'sub/child.txt',        // 正向分隔符子目录
    'sub\\child.txt',       // 反斜杠（Windows 分隔符）
    '..\\escape.txt',       // 反斜杠逃逸
    'C:evil.txt',           // 盘符
    '.', '..',              // 目录语义
    '.hidden',              // 点开头
    'con',                  // 保留名
    'name\u0000x',          // 控制字符
    'a:b.txt'               // 冒号
  ]
  for (const evil of attacks) {
    await assert.rejects(
      () => api.renameLocalFile(PLUGIN, handle.id, evil),
      (err) => {
        assert.ok(
          /文件名|仅支持同目录|系统保留|保留/.test(err.message),
          `attack "${evil}" should be rejected, got: ${err.message}`
        )
        return true
      },
      `attack rejected: ${evil}`
    )
  }
  // 全部攻击后：原文件与同级文件均未被动过
  assert.equal((await stat(target)).size, 4)
  assert.equal((await stat(sibling)).size, 6)
  await rm(dir, { recursive: true, force: true })
})

test('fs.rename：合法同目录改名 + 句柄跟随 + 目标已存在拒绝 + 失效句柄友好错误', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rn-'))
  try {
    const old = join(dir, '旧名称.txt')
    await writeFile(old, 'data', 'utf-8')
    const handle = await api.grantLocalFile(PLUGIN, old)
    // 合法改名（含中文/空格）
    const r = await api.renameLocalFile(PLUGIN, handle.id, '新 名称 v2.txt')
    assert.equal(r.oldName, '旧名称.txt')
    assert.equal(r.newName, '新 名称 v2.txt')
    await assert.rejects(() => stat(old), { code: 'ENOENT' })
    await stat(join(dir, '新 名称 v2.txt'))
    // 句柄跟随新路径：reveal 不抛错（shell stub）
    assert.equal(await api.revealLocalFile(PLUGIN, handle.id), true)
    // 目标已存在 → 拒绝（不覆盖）
    const other = join(dir, 'other.txt')
    await writeFile(other, 'other', 'utf-8')
    const otherHandle = await api.grantLocalFile(PLUGIN, join(dir, '新 名称 v2.txt'))
    await assert.rejects(() => api.renameLocalFile(PLUGIN, otherHandle.id, 'other.txt'), /已存在/)
    assert.equal((await stat(other)).size, 5)
    // 失效句柄（grant 表清空模拟文件已移动/删除后句柄过期）
    api.releaseLocalFiles(PLUGIN)
    await assert.rejects(() => api.renameLocalFile(PLUGIN, otherHandle.id, 'x.txt'), /句柄已失效/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('fs.renameBatch：confirmed 门禁 + 批内冲突拒绝 + 逐项结果', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rn-'))
  try {
    const handles = []
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      const path = join(dir, name)
      await writeFile(path, name, 'utf-8')
      handles.push(await api.grantLocalFile(PLUGIN, path))
    }
    const items = handles.map((h, i) => ({ handleId: h.id, newName: `n${i + 1}.txt` }))
    // 未确认 → 拒绝
    await assert.rejects(() => api.renameLocalFiles(PLUGIN, { items }), /confirmed/)
    // 确认 → 全部成功
    const batch = await api.renameLocalFiles(PLUGIN, { items, confirmed: true })
    assert.equal(batch.succeeded, 3)
    assert.equal(batch.failed, 0)
    await stat(join(dir, 'n2.txt'))
    // 批内同名冲突 → 整批拒绝
    const h2 = []
    for (const name of ['x1.txt', 'x2.txt']) {
      const path = join(dir, name)
      await writeFile(path, name, 'utf-8')
      h2.push(await api.grantLocalFile(PLUGIN, path))
    }
    await assert.rejects(
      () => api.renameLocalFiles(PLUGIN, { items: h2.map((h) => ({ handleId: h.id, newName: 'same.txt' })), confirmed: true }),
      /冲突/
    )
    // 单项失败不回滚其余：一项句柄失效，另一项正常
    const good = await api.grantLocalFile(PLUGIN, join(dir, 'n3.txt'))
    const mixed = await api.renameLocalFiles(PLUGIN, {
      items: [{ handleId: good.id, newName: 'renamed-good.txt' }, { handleId: 'not-a-handle', newName: 'whatever.txt' }],
      confirmed: true
    })
    assert.equal(mixed.succeeded, 1)
    assert.equal(mixed.failed, 1)
    assert.equal(mixed.results[0].ok, true)
    assert.equal(mixed.results[1].ok, false)
    await stat(join(dir, 'renamed-good.txt'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


test('file capabilities: read-only default, cross-plugin and symlink target denied', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'file-caps-')))
  try {
    const path = join(dir, 'chosen.txt')
    await writeFile(path, 'content')
    const read = await api.grantLocalFile(PLUGIN, path)
    assert.equal(await api.resolveLocalFileHandle(PLUGIN, read.id, 'read'), path)
    await assert.rejects(api.resolveLocalFileHandle(PLUGIN, read.id, 'write'), /invalid|只读|write|写/)
    await assert.rejects(api.resolveLocalFileHandle('other.plugin', read.id, 'read'), /invalid|句柄|plugin/)
    const folder = await api.grantLocalFile(PLUGIN, dir, { writable: true })
    await symlink(path, join(dir, 'link.txt'))
    await assert.rejects(api.resolveLocalDirectoryTarget(PLUGIN, folder.id, 'link.txt'), /regular|符号|symlink|普通/)
    await assert.rejects(api.resolveLocalDirectoryTarget(PLUGIN, folder.id, '../outside.txt'), /destination|文件名|目录/)
    assert.equal(await api.resolveLocalDirectoryTarget(PLUGIN, folder.id, 'new.txt'), join(dir, 'new.txt'))
  } finally { api.releaseLocalFiles(PLUGIN); await rm(dir, { recursive: true, force: true }) }
})

test('host reads only selected regular files within byte limit and never trusts a filename MIME', async () => {
  const dir=await mkdtemp(join(tmpdir(),'read-caps-'))
  try {
    const path=join(dir,'pretend.png');await writeFile(path,'<html>private</html>')
    const handle=await api.grantLocalFile(PLUGIN,path)
    assert.equal(await api.readLocalFile(PLUGIN,{handleId:handle.id,encoding:'text'}),'<html>private</html>')
    assert.match(await api.readLocalFile(PLUGIN,{handleId:handle.id,encoding:'dataUrl'}),/^data:application\/octet-stream;base64,/)
    await assert.rejects(api.readLocalFile('other.plugin',{handleId:handle.id}),/invalid/)
    await assert.rejects(api.readLocalFile(PLUGIN,{handleId:handle.id,maxBytes:2}),/maxBytes/)
    const folder=await api.grantLocalFile(PLUGIN,dir)
    await assert.rejects(api.readLocalFile(PLUGIN,{handleId:folder.id}),/regular file/)
    api.releaseLocalFiles(PLUGIN)
    await assert.rejects(api.readLocalFile(PLUGIN,{handleId:handle.id}),/invalid/)
  } finally {api.releaseLocalFiles(PLUGIN);await rm(dir,{recursive:true,force:true})}
})
