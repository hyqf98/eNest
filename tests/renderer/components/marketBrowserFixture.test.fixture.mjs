/** Shared opt-in browser fixture: real published catalog and media, isolated host state. */
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { readFile, access } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultSourceRoot = fileURLToPath(new URL('../../../', import.meta.url))

export async function createMarketBrowserFixture({ viewport = { width: 1440, height: 1000 }, reducedMotion = 'no-preference', level = 'medium', sourceRoot = defaultSourceRoot } = {}) {
  const registry = JSON.parse(await readFile(join(sourceRoot, 'eNest_plugin/dist/registry.json'), 'utf8'))
  const built = await build({ stdin: { resolveDir: sourceRoot, contents: "export * from '@main/plugin/marketMetadata'" }, tsconfig: join(sourceRoot, 'tsconfig.node.json'), platform: 'node', format: 'esm', bundle: true, write: false })
  const { parseRemoteMarket, remoteToSummary } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
  const entries = parseRemoteMarket(registry, 'https://github.com/hyqf98/eNest_plugin/releases/download/plugins-local/registry.json', 'https://github.com/hyqf98/eNest_plugin/releases/latest/download/')
  const assets = new Map()
  const localAsset = (entry, url) => {
    const parts = new URL(url).pathname.split('/').map(decodeURIComponent)
    const shortName = entry.id.split('.').at(-1)
    const publicIndex = parts.lastIndexOf('public')
    const packaged = publicIndex > 0 && parts[publicIndex - 1] === shortName
    const relative = packaged ? parts.slice(publicIndex + 1) : [basename(parts.join('/'))]
    if (!relative.length || relative.some(part => !part || part === '.' || part === '..' || /[/\\\u0000-\u001f\u007f]/.test(part))) {
      throw new Error(`Invalid local market asset for ${entry.id}`)
    }
    const path = packaged
      ? join(sourceRoot, 'eNest_plugin/dist', `${shortName}@${entry.version}`, ...relative)
      : join(sourceRoot, 'eNest_plugin/dist', ...relative)
    const href = `/__market_asset/${encodeURIComponent(entry.id)}/${relative.map(encodeURIComponent).join('/')}`
    assets.set(href, path)
    return href
  }
  const plugins = entries.map((entry, index) => ({ ...remoteToSummary(entry, true), installed: index % 4 === 0,
    icon: entry.icon?.startsWith('data:') ? entry.icon : entry.icon ? localAsset(entry, entry.icon) : undefined,
    screenshots: entry.screenshots.map(url => localAsset(entry, url)),
    readmeUrl: entry.readmeUrl ? localAsset(entry, entry.readmeUrl) : undefined,
    readmeImages: entry.readmeImages && Object.fromEntries(Object.entries(entry.readmeImages).map(([key, url]) => [key, localAsset(entry, url)])),
  }))
  // Keep each published plugin's versioned package paths; common filenames must not collide.
  await Promise.all([...assets.values()].map(path => access(path)))
  const readmes = Object.fromEntries(await Promise.all(plugins.map(async plugin => [plugin.id,
    plugin.readmeUrl ? await readFile(assets.get(plugin.readmeUrl), 'utf8') : '',
  ])))
  const server = await createServer({ configFile: false, root: join(sourceRoot, 'src/renderer'), logLevel: 'warn',
    plugins: [react(), { name: 'local-real-market-fixture', configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url === '/__market_fixture') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ plugins, readmes })); return }
        if (!req.url?.startsWith('/__market_asset/')) { next(); return }
        const path = assets.get(req.url.split('?')[0])
        if (!path) { res.statusCode = 404; res.end(); return }
        const types = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.md': 'text/markdown; charset=utf-8' }
        try { res.setHeader('Content-Type', types[extname(path).toLowerCase()] ?? 'application/octet-stream'); res.end(await readFile(path)) }
        catch { res.statusCode = 404; res.end() }
      })
    } }],
    resolve: { alias: Object.fromEntries(['renderer', 'shared', 'main', 'preload'].map(name => [`@${name}`, join(sourceRoot, 'src', name)])) },
    server: { host: '127.0.0.1', port: 0 },
  })
  let browser
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try { await browser?.close() } finally { await server.close() }
  }
  try {
    await server.listen()
    const candidates = [process.env.ENEST_CHROME_EXECUTABLE, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean)
    let executablePath
    for (const candidate of candidates) { if (await access(candidate).then(() => true, () => false)) { executablePath = candidate; break } }
    if (!executablePath) throw new Error('Set ENEST_CHROME_EXECUTABLE to an installed Chromium browser')
    browser = await chromium.launch({ executablePath, headless: true })
    const page = await browser.newPage({ viewport, reducedMotion })
    page.setDefaultTimeout(10000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const address = server.httpServer.address()
    const url = `http://127.0.0.1:${address.port}`
    for (const plugin of plugins) {
      if (plugin.icon?.startsWith('/')) plugin.icon = new URL(plugin.icon, url).href
      plugin.screenshots = plugin.screenshots.map(href => new URL(href, url).href)
      if (plugin.readmeUrl) plugin.readmeUrl = new URL(plugin.readmeUrl, url).href
      if (plugin.readmeImages) plugin.readmeImages = Object.fromEntries(Object.entries(plugin.readmeImages).map(([key, href]) => [key, new URL(href, url).href]))
    }
    await prepareMarketBrowserPage(page, { level, url })
    return { browser, page, errors, plugins, registry, server, url, close }
  } catch (error) {
    await close().catch(() => undefined)
    throw error
  }
}

/** Also used by the isolated Electron focus regression, with the same real catalog. */
export async function prepareMarketBrowserPage(page, { level = 'medium', url }) {
  await page.addInitScript(({ level }) => {
    localStorage.removeItem('enest.appearance.v2')
    localStorage.setItem('enest.theme.v1', JSON.stringify({ mode: 'light', overrides: {} }))
    localStorage.setItem('enest.settings.v1', JSON.stringify({ general: { locale: 'zh-CN', animationLevel: level, tabStyle: 'classic' }, quick: { enabled: false } }))
  }, { level })
  await page.goto(url)
  await page.locator('.app-boot.ready').waitFor()
  await page.evaluate(async level => {
    const fixture = await (await fetch('/__market_fixture')).json()
    const { shellApi } = await import('/services/shellApi.ts')
    window.marketFixture = fixture
    shellApi.getPlugins = async () => fixture.plugins
    shellApi.getMarketStatus = async () => ({ state: 'ready', catalogCount: fixture.plugins.length, fetchedAt: Date.now() })
    shellApi.getPluginReadme = async id => fixture.readmes[id] || ''
    const { useShellStore } = await import('/stores/shellStore.ts')
    useShellStore.setState({ plugins: fixture.plugins, query: '', category: '全部', seg: 'browse' })
    const { useAppearanceStore } = await import('/hooks/useAppearance.ts')
    const { source, id } = useAppearanceStore.getState().appearance.theme
    await useAppearanceStore.getState().updateThemeProfile({ theme: { source, id }, values: { motion: level, tabStyle: 'classic' } })
  }, level)
  await page.locator('.market-refresh:not([disabled])').waitFor()
  await page.getByRole('button', { name: '刷新插件市场', exact: true }).click()
  await page.locator('.market-refresh:not([disabled])').waitFor()
  await page.waitForFunction(() => document.querySelectorAll('[data-plugin-card]').length > 10)
}
