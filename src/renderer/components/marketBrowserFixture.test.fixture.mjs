/** Shared opt-in browser fixture: real published catalog and media, isolated host state. */
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { readFile, access } from 'node:fs/promises'
import { join, basename } from 'node:path'

export async function createMarketBrowserFixture({ viewport = { width: 1440, height: 1000 }, reducedMotion = 'no-preference', level = 'medium', sourceRoot = process.cwd() } = {}) {
  const registry = JSON.parse(await readFile(join(sourceRoot, 'eNest_plugin/dist/registry.json'), 'utf8'))
  const built = await build({ stdin: { resolveDir: sourceRoot, contents: "export * from '@main/plugin/marketMetadata'" }, tsconfig: join(sourceRoot, 'tsconfig.node.json'), platform: 'node', format: 'esm', bundle: true, write: false })
  const { parseRemoteMarket, remoteToSummary } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
  const localAsset = url => `/__market_asset/${encodeURIComponent(basename(decodeURIComponent(new URL(url).pathname)))}`
  const entries = parseRemoteMarket(registry, 'https://github.com/hyqf98/eNest_plugin/releases/download/plugins-local/registry.json', 'https://github.com/hyqf98/eNest_plugin/releases/latest/download/')
  const plugins = entries.map((entry, index) => ({ ...remoteToSummary(entry, true), installed: index % 4 === 0,
    icon: entry.icon?.startsWith('data:') ? entry.icon : localAsset(registry.plugins[index].icon),
    screenshots: entry.screenshots.map(localAsset),
  }))
  const readmes = Object.fromEntries(await Promise.all(registry.plugins.map(async entry => [entry.id,
    entry.readmeUrl ? await readFile(join(sourceRoot, 'eNest_plugin/dist', basename(decodeURIComponent(new URL(entry.readmeUrl).pathname))), 'utf8').catch(() => '') : '',
  ])))
  const server = await createServer({ configFile: false, root: join(sourceRoot, 'src/renderer'), logLevel: 'warn',
    plugins: [react(), { name: 'local-real-market-fixture', configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url === '/__market_fixture') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ plugins, readmes })); return }
        if (!req.url?.startsWith('/__market_asset/')) { next(); return }
        const name = decodeURIComponent(req.url.slice('/__market_asset/'.length).split('?')[0])
        if (name !== basename(name)) { res.statusCode = 403; res.end(); return }
        try { res.setHeader('Content-Type', name.endsWith('.svg') ? 'image/svg+xml' : 'image/png'); res.end(await readFile(join(sourceRoot, 'eNest_plugin/dist', name))) }
        catch { res.statusCode = 404; res.end() }
      })
    } }],
    resolve: { alias: Object.fromEntries(['renderer', 'shared', 'main', 'preload'].map(name => [`@${name}`, join(sourceRoot, 'src', name)])) },
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const candidates = [process.env.ENEST_CHROME_EXECUTABLE, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean)
  let executablePath
  for (const candidate of candidates) { if (await access(candidate).then(() => true, () => false)) { executablePath = candidate; break } }
  if (!executablePath) { await server.close(); throw new Error('Set ENEST_CHROME_EXECUTABLE to an installed Chromium browser') }
  const browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport, reducedMotion })
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const address = server.httpServer.address()
  const url = `http://127.0.0.1:${address.port}`
  await prepareMarketBrowserPage(page, { level, url })
  return { browser, page, errors, plugins, registry, server, url, async close() { await browser.close(); await server.close() } }
}

/** Also used by the isolated Electron focus regression, with the same real catalog. */
export async function prepareMarketBrowserPage(page, { level = 'medium', url }) {
  await page.addInitScript(({ level }) => {
    localStorage.setItem('enest.theme.v1', JSON.stringify({ mode: 'light', overrides: {} }))
    localStorage.setItem('enest.settings.v1', JSON.stringify({ general: { locale: 'zh-CN', animationLevel: level, tabStyle: 'classic' }, quick: { enabled: false } }))
  }, { level })
  await page.goto(url)
  await page.locator('.app-boot.ready').waitFor()
  await page.evaluate(async () => {
    const fixture = await (await fetch('/__market_fixture')).json()
    const { shellApi } = await import('/services/shellApi.ts')
    window.marketFixture = fixture
    shellApi.getPlugins = async () => fixture.plugins
    shellApi.getMarketStatus = async () => ({ state: 'ready', catalogCount: fixture.plugins.length, fetchedAt: Date.now() })
    shellApi.getPluginReadme = async id => fixture.readmes[id] || ''
    const { useShellStore } = await import('/stores/shellStore.ts')
    useShellStore.setState({ plugins: fixture.plugins, query: '', category: '全部', seg: 'browse' })
  })
  await page.getByRole('button', { name: '刷新市场', exact: true }).click()
  await page.locator('.market-refresh:not([disabled])').waitFor()
  await page.waitForFunction(() => document.querySelectorAll('[data-plugin-card]').length > 10)
}
