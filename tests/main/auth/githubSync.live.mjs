import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { initializeDevice, publishFixture, restoreFixture, updateFixture, verifyAutoRestore } from './syncScenario.mjs'

const require = createRequire(import.meta.url)
const execute = promisify(execFile)
const stages = ['verify-proxy', 'connect-a', 'publish-a', 'restore-b', 'update-a', 'verify-b']
const deviceFor = stage => stage === 'verify-proxy' ? 'proxy' : stage.endsWith('-a') ? 'A' : 'B'
async function receipt(root) {
  const directory = await realpath(root)
  assert.equal(dirname(directory), await realpath(tmpdir()))
  assert.match(basename(directory), /^enest-github-qa-[a-z\d]{6}$/i)
  const plan = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'))
  assert.equal(plan.directory, directory)
  assert.match(plan.repo, /^enest-sync-qa-[a-f0-9]{12}$/)
  assert.match(plan.owner, /^[a-z\d][a-z\d-]{0,38}$/i)
  return plan
}
async function saveReceipt(plan) {
  const next = join(plan.directory, `run-${randomUUID()}.tmp`)
  await writeFile(next, JSON.stringify(plan), { mode: 0o600, flag: 'wx' })
  await rename(next, join(plan.directory, 'run.json'))
}
const seedName = plan => plan.repo.replace('enest-sync-qa-', 'enest-sync-qa-seed-')
async function verifyOwner(plan) {
  const { stdout } = await execute('gh', ['api', '--include', 'user', '--jq', '.login'])
  assert.equal(stdout.trim().split(/\r?\n/).at(-1).toLowerCase(), plan.owner.toLowerCase(), 'cleanup must use the original repository owner')
  const scopes = /^x-oauth-scopes:[ \t]*([^\r\n]*)/im.exec(stdout)?.[1].split(',').map(scope => scope.trim())
  assert.ok(scopes?.includes('repo'), 'private-repository visibility is required to verify deletion; a blind 404 is not sufficient')
}
async function cleanupMetadata(plan, name) {
  assert.ok(name === plan.repo || name === seedName(plan))
  try {
    const { stdout } = await execute('gh', ['api', `repos/${plan.owner}/${name}`, '--jq', '{id,name,owner:.owner.login,private,description,created_at}'])
    const repo = JSON.parse(stdout)
    assert.equal(repo.owner.toLowerCase(), plan.owner.toLowerCase()); assert.equal(repo.name, name); assert.equal(repo.private, true)
    assert.ok(Number.isSafeInteger(repo.id) && repo.id > 0)
    return repo
  } catch (error) {
    if (error.code === 1 && /\(HTTP 404\)/.test(error.stderr ?? '')) return null
    throw error
  }
}
async function prepare(owner) {
  assert.match(owner ?? '', /^[a-z\d][a-z\d-]{0,38}$/i)
  const { syncFixtureBundle, stageAccountStorage } = await import('./syncFixtureBundle.mjs')
  const bundle = await syncFixtureBundle({ native: true })
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'enest-github-qa-'))
  try {
    await stageAccountStorage(directory)
    const repo = 'enest-sync-qa-' + randomUUID().replaceAll('-', '').slice(0, 12)
    const run = { owner, repo, directory, createdAt: Date.now() }
    await writeFile(join(directory, 'run.json'), JSON.stringify(run), { mode: 0o600, flag: 'wx' })
    await writeFile(join(directory, 'host.cjs'), bundle, { mode: 0o600, flag: 'wx' })
    await writeFile(join(directory, 'main.cjs'), `const {app}=require('electron');app.setPath('userData',process.env.ENEST_TEST_USER_DATA);app.setPath('sessionData',process.env.ENEST_TEST_USER_DATA);app.whenReady().then(async()=>{const { runNative }=await import(${JSON.stringify(import.meta.url)});await runNative(require('./host.cjs'),require('electron'),__dirname,process.env.ENEST_QA_STAGE);app.exit(0)}).catch(error=>{console.error(error.message);app.exit(1)});`, { mode: 0o600, flag: 'wx' })
    console.log(JSON.stringify(run))
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
}

async function authorize(host, electron, device, expectedLogin) {
  let user = host.auth.getProfileUser()
  if (user) { await host.auth.refreshProfileOnBoot(); user = host.auth.getProfileUser() }
  if (!user) {
    const window = new electron.BrowserWindow({ width: 560, height: 230, title: `eNest · 隔离同步验收 ${device}`, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    host.runtime.window = window
    const result = await host.loginAccount('github')
    assert.ok(result.ok, result.error)
    assert.equal(result.data.mode, 'device')
    assert.match(result.data.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    const completed = new Promise((resolveLogin, reject) => {
      const listener = event => {
        if (event.phase === 'pending') return
        host.events.off('account-login-status', listener)
        if (event.phase === 'authorized') resolveLogin(); else reject(new Error(event.message || 'GitHub login cancelled'))
      }
      host.events.on('account-login-status', listener)
    })
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<meta charset="utf-8"><style>body{font:16px system-ui;margin:24px}strong{letter-spacing:4px}</style><h3>eNest · 测试设备 ${device}</h3><p>仅在 GitHub 官方设备授权页输入此码：<strong>${result.data.userCode}</strong></p><p>确认应用是 eNest Desktop Sync。完成后会自动返回。</p>`))
    window.showInactive()
    console.log(`WAIT: GitHub device authorization for isolated device ${device}; default browser opened; code copied=${result.data.copied === true}`)
    await completed
    user = host.auth.getProfileUser()
    if (!window.isFocused()) await once(window, 'focus', { signal: AbortSignal.timeout(5000) })
    assert.equal(window.isFocused(), true, 'authorization should return focus to the desktop')
    window.hide()
  }
  assert.equal(user?.login?.toLowerCase(), expectedLogin.toLowerCase(), 'refuse to test another account')
  assert.ok(user.githubId > 0 && user.avatarDataUrl?.startsWith('data:image/'), 'verified identity and cached avatar required')
  console.log(`PASS: device ${device} authenticated @${user.login}; encrypted credential and avatar available`)
  return user.githubId
}

async function verifyProxy(host, electron) {
  const destinations = [], proxy = createServer()
  proxy.on('connect', (request, socket) => { destinations.push(request.url); socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n') })
  await new Promise(resolveListen => proxy.listen(0, '127.0.0.1', resolveListen))
  try {
    const port = proxy.address().port
    await host.applyProxy({ type: 'http', host: '127.0.0.1', port })
    for (const domain of ['github.com', 'api.github.com', 'avatars.githubusercontent.com']) assert.equal(await electron.session.defaultSession.resolveProxy(`https://${domain}/`), `PROXY 127.0.0.1:${port}`)
    const login = await host.loginAccount('github')
    assert.equal(login.ok, false); assert.ok(destinations.includes('github.com:443'), `login stopped before the proxy saw a GitHub tunnel: ${login.error}`)
    const session = { token: 'synthetic-fixture-only', user: { login: 'fixture', id: 27 }, signal: AbortSignal.timeout(12000), check() {} }
    await assert.rejects(host.cloud.resolveRepository(session, 'synthetic-fixture', false)); assert.ok(destinations.includes('api.github.com:443'))
    await host.applyProxy({ type: 'none' })
    assert.equal(await electron.session.defaultSession.resolveProxy('https://api.github.com/'), 'DIRECT')
    console.log('PASS: native login and sync reached the configured loopback proxy, a rejected tunnel did not fall back, and direct mode resolved DIRECT; nothing was forwarded')
  } finally { proxy.closeAllConnections(); await new Promise(resolveClose => proxy.close(resolveClose)) }
}

export async function runNative(host, electron, root, stage) {
  assert.ok(stages.includes(stage))
  const plan = await receipt(root), device = deviceFor(stage), dataRoot = join(plan.directory, device, 'data-root')
  assert.equal(process.env.ENEST_TEST_DATA_ROOT, dataRoot)
  assert.equal(electron.app.getPath('userData'), join(plan.directory, device, 'chromium'))
  await host.settingsStore.load()
  await host.applyProxyFromSettings()
  await initializeDevice(host, dataRoot)
  try {
    if (stage === 'verify-proxy') { await verifyProxy(host, electron); return }
    if (stage === 'connect-a' && host.getAccountState().user) {
      assert.ok(await host.auth.hasGithubToken(), 'persisted credential must decrypt in this fresh Electron process')
      console.log('PASS: fresh native process reopened the isolated profile and decrypted its saved credential before a network refresh')
    }
    const accountId = await authorize(host, electron, device, plan.owner)
    if (stage === 'connect-a') {
      const session = await host.auth.getGithubSyncSession()
      if (!plan.id) {
        await assert.rejects(host.cloud.resolveRepository(session, plan.repo, false), error => error.status === 404, 'refuse to initialize a pre-existing repository')
        plan.requestedAt ??= Date.now()
        await saveReceipt(plan)
      } else await host.cloud.resolveRepository(session, plan.repo, false, plan.id)
      await host.sync.connectGithubRepository(accountId, plan.repo)
      const state = await host.sync.githubSyncState(accountId)
      assert.ok(!state.error, state.error)
      assert.equal(state.repository.name, plan.repo)
      assert.ok(!plan.id || plan.id === state.repository.id)
      await saveReceipt({ ...plan, id: state.repository.id, accountId })
      assert.equal(state.cloud.length, 0)
      console.log(`PASS: app connected private repository ${plan.owner}/${plan.repo} ID=${state.repository.id} with empty manifest`)
      return
    }
    assert.equal(accountId, plan.accountId); assert.ok(plan.id > 0)
    if (stage === 'restore-b') {
      const session = await host.auth.getGithubSyncSession()
      assert.equal((await host.cloud.findExistingSyncRepository(session))?.id, plan.id)
      await host.sync.connectGithubRepository(accountId, plan.repo)
    }
    const state = await host.sync.githubSyncState(accountId)
    assert.ok(!state.error, state.error); assert.deepEqual(state.repository, { id: plan.id, name: plan.repo })
    if (stage === 'publish-a') await publishFixture(host, accountId, state.repository)
    if (stage === 'restore-b') await restoreFixture(host, accountId, state.repository)
    if (stage === 'update-a') await updateFixture(host, accountId, state.repository)
    if (stage === 'verify-b') {
      const done = once(host.events, 'github-sync-finished', { signal: AbortSignal.timeout(120000) })
      host.auth.onGithubAuthenticated(host.sync.restoreGithubOnLogin)
      await host.auth.refreshProfileOnBoot(); await done; await host.sync.waitForGithubSync()
      await verifyAutoRestore(host, accountId, state.repository)
    }
  } finally { host.auth.disposeGithubSession(); await host.sync.waitForGithubSync(); host.storage.flushAll(); host.kvStore.close() }
}

async function main() {
  const [, , stage, argument] = process.argv
  if (stage === 'prepare') { await prepare(argument); return }
  const plan = await receipt(argument)
  if (stage === 'profile-ui') { const { showIsolatedProfile } = await import('./githubProfileUi.mjs'); await showIsolatedProfile(plan); return }
  if (stage === 'record-seed' || stage === 'record-created') {
    await verifyOwner(plan)
    const seed = stage === 'record-seed', key = seed ? 'seedId' : 'id'
    const repo = await cleanupMetadata(plan, seed ? seedName(plan) : plan.repo)
    assert.ok(repo, 'test repository is not accessible')
    assert.equal(repo.id, Number(process.argv[4]), 'verified numeric repository ID is required')
    assert.ok(plan[key] === undefined || plan[key] === repo.id)
    const since = seed ? plan.createdAt : plan.requestedAt
    assert.ok(Number.isFinite(since) && Date.parse(repo.created_at) >= Math.floor(since / 1000) * 1000)
    assert.equal(repo.description, seed ? 'Disposable empty repository for isolated eNest installation acceptance; no user data.' : 'Private plugin data synced by eNest')
    await saveReceipt({ ...plan, [key]: repo.id }); console.log(`Recorded private ${plan.owner}/${repo.name} ID=${repo.id}`); return
  }
  if (stage === 'rebuild') {
    const { syncFixtureBundle, stageAccountStorage } = await import('./syncFixtureBundle.mjs')
    await stageAccountStorage(plan.directory)
    const next = join(plan.directory, `host-${randomUUID()}.tmp`)
    await writeFile(next, await syncFixtureBundle({ native: true }), { mode: 0o600, flag: 'wx' })
    await rename(next, join(plan.directory, 'host.cjs'))
    return
  }
  if (stage === 'clean-local') {
    await verifyOwner(plan)
    for (const [name, id] of [[plan.repo, plan.id], [seedName(plan), plan.seedId]]) {
      const remote = await cleanupMetadata(plan, name)
      if (!remote) continue
      assert.equal(remote.id, id, 'repository identity differs from the test receipt; do not delete it')
      throw new Error(`Still present: ${plan.owner}/${name} ID=${id}; kept the cleanup receipt`)
    }
    await rm(plan.directory, { recursive: true }); console.log('Both test names return 404; removed isolated profiles, credentials and artifacts.'); return
  }
  assert.ok(stages.includes(stage), 'unknown stage')
  const device = deviceFor(stage)
  if (stage === 'verify-proxy') await mkdir(join(plan.directory, device))
  const data = join(plan.directory, device, 'data-root'), chromium = join(plan.directory, device, 'chromium')
  await mkdir(chromium, { recursive: true }); await mkdir(data, { recursive: true })
  const env = { ...process.env, ENEST_TEST_DATA_ROOT: data, ENEST_TEST_USER_DATA: chromium, ENEST_QA_STAGE: stage }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ENEST_GITHUB_CLIENT_ID', 'ENEST_GITHUB_APP_SLUG', 'ENEST_GITHUB_DEVICE_FLOW', 'ENEST_GITHUB_TOKEN_EXCHANGE_URL']) delete env[key]
  const child = spawn(require('electron'), [join(plan.directory, 'main.cjs'), ...(stage === 'verify-proxy' ? ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] : [])], { env, stdio: 'inherit' })
  try { const [code] = await once(child, 'exit'); assert.equal(code, 0, 'native acceptance phase did not complete') }
  finally { if (stage === 'verify-proxy') await rm(join(plan.directory, device), { recursive: true, force: true }) }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch(error => { console.error(error.message); process.exitCode = 1 })
