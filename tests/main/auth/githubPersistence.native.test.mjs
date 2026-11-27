import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0i8AAAAASUVORK5CYII=', 'base64')
const access = 'synthetic-access-secret', refresh = 'synthetic-refresh-secret'

export async function runPersistence(host, stage) {
  assert.equal(host.paths.getAppPaths().root, process.env.ENEST_TEST_DATA_ROOT)
  await host.settingsStore.load()
  const file = join(host.paths.getAppPaths().data, 'github.token'), cachedAvatar = `data:image/png;base64,${png.toString('base64')}`
  const remote = async (url, init) => {
    if (url === 'https://github.com/login/device/code') return Response.json({ device_code: 'fixture-device', user_code: 'TEST-CODE', expires_in: 60, interval: 3 })
    if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: access, refresh_token: refresh, expires_in: 28800, refresh_token_expires_in: 86400 })
    if (url === 'https://api.github.com/user') {
      assert.ok(init.headers.Authorization === `Bearer ${access}`)
      return Response.json({ id: 27, login: 'fixture', name: 'Fixture', avatar_url: 'https://avatars.githubusercontent.com/u/27', html_url: 'https://github.com/fixture' })
    }
    assert.equal(url, 'https://avatars.githubusercontent.com/u/27?s=160')
    return new Response(png, { headers: { 'content-type': 'image/png' } })
  }
  host.runtime.request = remote
  try {
    if (stage === 'login') {
      assert.equal(host.getAccountState().user, null)
      const finish = once(host.events, 'profile-changed', { signal: AbortSignal.timeout(15000) })
      const started = await host.loginAccount('github')
      assert.equal(started.ok, true); assert.equal(started.data.mode, 'device'); assert.equal(host.runtime.opened, 'https://github.com/login/device')
      await finish
      const bytes = await readFile(file)
      assert.ok(bytes.length && !bytes.includes(access) && !bytes.includes(refresh))
      if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)
      assert.equal(host.getAccountState().user.avatarDataUrl, cachedAvatar)
    } else if (stage === 'restart') {
      const profile = host.getAccountState().user
      assert.equal(profile.login, 'fixture'); assert.equal(profile.avatarDataUrl, cachedAvatar)
      assert.equal(await host.auth.hasGithubToken(), true)
      host.runtime.request = async () => { throw new Error('fixture offline') }
      await host.auth.refreshProfileOnBoot(); assert.deepEqual(host.getAccountState().user, profile)
      host.runtime.request = remote
      assert.ok((await host.auth.getGithubSyncSession()).token === access)
      await host.auth.refreshProfileOnBoot(); assert.equal(host.getAccountState().user.connectedAt, profile.connectedAt); assert.equal(host.runtime.opened, undefined)
      host.auth.logoutGithub(); assert.equal(host.getAccountState().user, null); assert.equal(existsSync(file), false)
    } else {
      assert.equal(stage, 'after-logout'); assert.equal(await host.auth.hasGithubToken(), false)
      await host.auth.refreshProfileOnBoot(); assert.equal(host.getAccountState().user, null); assert.equal(existsSync(file), false)
    }
  } finally { host.auth.disposeGithubSession(); host.kvStore.close() }
}

if (!process.versions.electron) test('native device login survives a cold and offline restart, and logout survives the next restart', { skip: process.env.ENEST_APP_SMOKE !== '1' }, async () => {
  const { syncFixtureBundle, stageAccountStorage } = await import('./syncFixtureBundle.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'enest-login-persistence-')), main = join(directory, 'main.cjs')
  try {
    await stageAccountStorage(directory)
    await writeFile(join(directory, 'host.cjs'), await syncFixtureBundle({ native: true, isolatedLogin: true }))
    await writeFile(main, `const {app}=require('electron');app.setPath('userData',process.env.ENEST_TEST_USER_DATA);app.setPath('sessionData',process.env.ENEST_TEST_USER_DATA);app.whenReady().then(async()=>{const {runPersistence}=await import(${JSON.stringify(import.meta.url)});await runPersistence(require('./host.cjs'),process.argv[2]);app.exit(0)}).catch(error=>{console.error(error.message);app.exit(1)})`)
    const env = { ...process.env, ENEST_TEST_USER_DATA: join(directory, 'chromium'), ENEST_TEST_DATA_ROOT: join(directory, 'data-root') }
    for (const key of ['ELECTRON_RUN_AS_NODE', 'ENEST_GITHUB_CLIENT_ID']) delete env[key]
    for (const stage of ['login', 'restart', 'after-logout']) await promisify(execFile)(require('electron'), [main, stage], { env, timeout: 25000 })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
