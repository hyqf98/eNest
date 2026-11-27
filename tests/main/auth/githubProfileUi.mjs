import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { access, cp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

const project = fileURLToPath(new URL('../../../', import.meta.url))
const require = createRequire(import.meta.url)
function previewPng() {
  const chunk = (name, data) => {
    const content = Buffer.concat([Buffer.from(name), data]), size = Buffer.alloc(4), checksum = Buffer.alloc(4)
    size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(content)); return Buffer.concat([size, content, checksum])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(1200); header.writeUInt32BE(800, 4); header[8] = 1
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(151 * 800))), chunk('IEND', Buffer.alloc(0))])
}

async function fixtureFile(path, content) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, content, { mode: 0o600, flag: 'wx' }); await rename(temporary, path)
}

function profileDom() {
  const list = document.querySelector('.sync-plugins')
  return {
    hasRoot: !!document.querySelector('#root > *'), hasProfile: !!document.querySelector('.account-page'),
    avatar: document.querySelector('.account-avatar img')?.naturalWidth, login: document.querySelector('.account-description')?.textContent,
    rows: [...(list?.querySelectorAll('li') ?? [])].map(row => ({
      name: row.querySelector('.dev-plugin-name')?.textContent, size: row.querySelector('.sync-sizes span')?.textContent,
      id: row.querySelector('.dev-plugin-path')?.textContent, iconWidth: row.querySelector('.plugin-icon')?.getBoundingClientRect().width,
      selectable: !!row.querySelector('label.dev-plugin-item button[role="checkbox"]:enabled'),
    })), fits: !!list && list.scrollWidth <= list.clientWidth + 1,
    all: !!document.querySelector('.sync-select-all button[role="checkbox"]:enabled'), input: document.querySelector('#sync-repo-name')?.value,
    bound: !!document.querySelector('.sync-bound'),
  }
}

async function verifySelection(contents) {
  const all = '.sync-select-all button[role="checkbox"]', rows = '.sync-plugins button[role="checkbox"]:enabled'
  for (const [selector, expected, count] of [['.sync-plugins label .dev-plugin-name', 'mixed', 1], [all, 'true', 2], [all, 'false', 0]]) {
    await contents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`)
    const state = () => contents.executeJavaScript(`({ all: document.querySelector('${all}').getAttribute('aria-checked'), count:document.querySelectorAll('${rows}[aria-checked="true"]').length })`)
    let value = await state()
    for (let attempt = 0; value.all !== expected && attempt < 10; attempt++) { await delay(50); value = await state() }
    assert.deepEqual(value, { all: expected, count })
  }
}

async function verifyDockAvatar(electron, contents, dock) {
  const window = electron.BrowserWindow.fromWebContents(contents)
  const view = window.contentView.children.find(child => child.webContents === dock)
  assert.ok(view?.getVisible()); assert.equal(view.getBounds().x, 0)
  assert.equal(view.getBounds().y + view.getBounds().height, window.getContentBounds().height)
  dock.focus()
  await dock.executeJavaScript(`document.querySelector('[data-settings]').focus()`)
  const profileImage = await contents.executeJavaScript(`document.querySelector('.account-avatar img').src`)
  for (let attempt = 0; attempt < 25; attempt++) {
    const image = await dock.executeJavaScript(`(() => { const image=document.querySelector('[data-account-image]'), dock=document.querySelector('.orb-dock'); return {visible: !!image?.naturalWidth && image.classList.contains('is-loaded') && getComputedStyle(dock).opacity === '1' && getComputedStyle(image).opacity === '1' && getComputedStyle(document.querySelector('[data-account-fallback]')).visibility==='hidden', src:image?.getAttribute('src')} })()`)
    if (image.visible && image.src === profileImage) return
    await delay(100)
  }
  assert.fail('bottom-left settings button did not reveal the cached profile image')
}

export function observeProfile(electron, root, owner) {
  const shell = pathToFileURL(join(root, 'out', 'renderer', 'index.html')).href
  const diagnostics = new Set()
  let last = {}
  const timeout = setTimeout(() => { console.error('Profile did not render:', [...diagnostics], last); electron.app.exit(1) }, 35000)
  electron.app.on('web-contents-created', (_event, contents) => {
    contents.on('preload-error', () => diagnostics.add('preload error'))
    contents.on('console-message', details => { if (details.level === 'error') diagnostics.add(String(details.message).slice(0, 180).replace(/data:[^\s]+/gi, '[data]')) })
    contents.on('did-finish-load', async () => {
      if (contents.getURL().startsWith('file:')) diagnostics.add(`loaded ${basename(new URL(contents.getURL()).pathname)}`)
      if (contents.getURL() !== shell) return
      try {
        for (let attempt = 0; attempt < 50; attempt++) {
          const page = await contents.executeJavaScript(`(${profileDom})()`)
          const dock = electron.webContents.getAllWebContents().find(current => current.getURL().startsWith(pathToFileURL(join(root, 'out/renderer/orb-overlay.html')).href + '?part=dock&'))
          last = { mounted: page.hasRoot, profile: page.hasProfile, matchedAccount: page.login === `@${owner}`, avatar: !!page.avatar, rows: page.rows.length, dock: !!dock }
          if (page.hasProfile && page.avatar && page.rows.length && page.all && dock) {
            assert.equal(page.login, `@${owner}`); assert.ok(page.input === 'enest-sync' || page.bound); assert.ok(page.fits)
            for (const [name, size] of [['资料验收 · 笔记', 173], ['资料验收 · 色板', 653]]) assert.ok(page.rows.some(row => row.name === name && row.selectable && row.id?.startsWith('fixture.profile.') && row.iconWidth === 40 && row.size?.includes(`${size} B`)), `unexpected data rows: ${JSON.stringify(page.rows)}`)
            await verifySelection(contents); await verifyDockAvatar(electron, contents, dock)
            if (process.env.ENEST_QA_CAPTURE_LIST === '1') {
              contents.focus()
              await contents.executeJavaScript(`document.querySelector('.sync-plugins').scrollIntoView({block:'center',behavior:'instant'})`)
              await delay(350)
              const rect = await contents.executeJavaScript(`(() => { const {x,y,width,height}=document.querySelector('.sync-plugins').getBoundingClientRect(); return {x:Math.floor(x),y:Math.floor(y),width:Math.ceil(width),height:Math.ceil(height)} })()`)
              await writeFile(join(root, '..', 'profile-list.png'), (await contents.capturePage(rect)).toPNG(), { mode: 0o600, flag: 'wx' })
            }
            contents.send('shell:event', { type: 'set-view', view: 'settings', sectionId: 'plugin-data' })
            for (let index = 0; index < 25; index++) {
              const usage = await contents.executeJavaScript(`Array.from(document.querySelectorAll('.plugin-data-list > li.dev-plugin-item'), row=>({name:row.querySelector('.dev-plugin-name')?.textContent, icon:row.querySelector('.plugin-icon')?.getBoundingClientRect().width, breakdown:row.querySelectorAll('.plugin-data-cell').length}))`)
              if (usage.length === 2 && usage.every(row => row.name?.includes('资料验收') && row.icon === 40 && row.breakdown === 4)) break
              if (index === 24) assert.fail('plugin data view did not render both shared rows and breakdowns')
              await delay(100)
            }
            clearTimeout(timeout); console.log('PASS: offline restart rendered the same cached GitHub image in profile and revealed bottom-left settings, both plugin lists used 40px developer rows, and individual, mixed, select-all and deselect states worked (173 B / 653 B)'); electron.app.quit(); return
          }
          if (!page.hasProfile && page.hasRoot) contents.send('shell:event', { type: 'set-view', view: 'settings', sectionId: 'profile' })
          await delay(400)
        }
      } catch (error) { clearTimeout(timeout); console.error(error.message); electron.app.exit(1) }
    })
  })
}

export async function showIsolatedProfile(plan) {
  const root = plan.directory, desktop = join(root, 'profile-app'), data = join(root, 'A', 'data-root'), chromium = join(root, 'A', 'chromium')
  await access(join(data, 'data', 'github.token')); await access(join(root, 'compiled', 'main', 'index.js'))
  await mkdir(desktop, { recursive: true }); await cp(join(root, 'compiled'), join(desktop, 'out'), { recursive: true })
  const { stageAccountStorage } = await import('./syncFixtureBundle.mjs')
  await stageAccountStorage(desktop)
  for (const name of ['node_modules', 'assets', 'build']) {
    const link = join(desktop, name), target = join(project, name)
    try { await symlink(target, link, 'dir') } catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(await realpath(link), await realpath(target)) }
  }
  const rows = [], fixtures = [desktop]
  for (const [slug, label, amount] of [['notes', '笔记', 160], ['palette', '色板', 640]]) {
    const id = `fixture.profile.${slug}`, name = `资料验收 · ${label}`, version = '1.0.0', folder = join(data, 'plugins', id, version)
    await mkdir(join(folder, 'assets/market/screenshots'), { recursive: true })
    const manifest = { id, name, version, main: 'index.html', description: 'Synthetic profile fixture with no permissions.', icon: 'assets/market/icon.svg', permissions: [], market: { readme: 'assets/market/README.md', screenshots: ['assets/market/screenshots/preview.png'] } }
    await fixtureFile(join(folder, 'plugin.json'), JSON.stringify(manifest)); await fixtureFile(join(folder, 'index.html'), '<!doctype html><title>Profile fixture</title>')
    await fixtureFile(join(folder, 'assets/market/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12" fill="#34766b"/></svg>'); await fixtureFile(join(folder, 'assets/market/screenshots/preview.png'), previewPng()); await fixtureFile(join(folder, 'assets/market/README.md'), name)
    const documents = join(data, 'data', 'plugin-documents', createHash('sha256').update(id).digest('hex'), 'documents'), content = JSON.stringify({ sample: 'x'.repeat(amount) })
    await mkdir(documents, { recursive: true }); await fixtureFile(join(documents, 'example.json'), content)
    fixtures.push(join(data, 'plugins', id), join(documents, '..'))
    rows.push({ name, bytes: Buffer.byteLength(content) })
  }
  await fixtureFile(join(desktop, 'package.json'), JSON.stringify({ name: 'enest-profile-qa', productName: 'eNest Profile QA', version: '0.0.1', type: 'module', main: 'profile-qa.cjs' }))
  await fixtureFile(join(desktop, 'profile-qa.cjs'), `const electron=require('electron'),{app}=electron;app.setPath('userData',process.env.ENEST_TEST_USER_DATA);app.setPath('sessionData',process.env.ENEST_TEST_USER_DATA);app.setAppLogsPath(require('node:path').join(__dirname,'ui-logs'));app.on('session-created',session=>session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(_details,done)=>done({cancel:true})));import(${JSON.stringify(import.meta.url)}).then(module=>{module.observeProfile(electron,__dirname,${JSON.stringify(plan.owner)});return import('./out/main/index.js')});`)
  const env = { ...process.env, ENEST_TEST_DATA_ROOT: data, ENEST_TEST_USER_DATA: chromium }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[key] = 'http://127.0.0.1:9'
  env.NO_PROXY = ''; env.no_proxy = ''
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'ENEST_REMOTE_DEBUG']) delete env[key]
  const child = spawn(require('electron'), [desktop, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'], { env, stdio: 'inherit' })
  const stop = () => child.kill('SIGTERM'), deadline = setTimeout(stop, 55000)
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try { console.log('Offline native profile; synthetic plugin sizes:', rows); const [code] = await once(child, 'exit'); assert.equal(code, 0, 'native profile acceptance failed') }
  finally {
    clearTimeout(deadline); process.off('SIGINT', stop); process.off('SIGTERM', stop)
    for (const folder of fixtures) await rm(folder, { recursive: true, force: true })
  }
}
