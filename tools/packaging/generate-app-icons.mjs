import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const icons = join(root, 'assets', 'icons')
const source = readFileSync(join(icons, 'enest.svg'), 'utf8')
const lightColors = {
  '#062520': '#16463b', '#001512': '#092b25', '#20dbae': '#45e5b5',
  '#13c9a1': '#24d4a3', '#20d6ad': '#47e2b7', '#ffb43a': '#ffc054'
}

function exportIcons(staging, svg, runtimeDirectory, packageDirectory) {
  mkdirSync(runtimeDirectory, { recursive: true })
  const iconset = join(staging, 'eNest.iconset')
  mkdirSync(iconset)
  const vector = join(staging, 'enest.svg'), master = join(staging, 'master.png')
  writeFileSync(vector, svg)
  execFileSync('/usr/bin/sips', ['-s', 'format', 'png', vector, '--out', master])
  copyFileSync(master, join(runtimeDirectory, 'dock-runtime.png'))
  for (const points of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = String(points * scale)
      const frame = join(iconset, `icon_${points}x${points}${scale === 1 ? '' : '@2x'}.png`)
      execFileSync('/usr/bin/sips', ['-z', pixels, pixels, master, '--out', frame])
    }
  }
  copyFileSync(join(iconset, 'icon_256x256.png'), join(runtimeDirectory, 'enest-icon-256.png'))
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', '-o', join(packageDirectory, 'icon.icns'), iconset])
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
  const streams = sizes.flatMap((size, index) => ['-map', '0:v', `-filter:v:${index}`, `scale=${size}:${size}:flags=lanczos`,
    `-c:v:${index}`, size === 256 ? 'png' : 'bmp', `-pix_fmt:v:${index}`, size === 256 ? 'rgba' : 'bgra', `-threads:v:${index}`, '1'])
  execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-i', master, ...streams, '-f', 'ico', join(packageDirectory, 'icon.ico')])
}

function exportComposerIcon(staging, variants) {
  const composer = join(icons, 'eNest.icon'), layers = join(composer, 'Assets')
  mkdirSync(layers, { recursive: true })
  const gradient = mode => {
    const colors = [...variants[mode].match(/<linearGradient id="pine"[^>]*>([\s\S]*?)<\/linearGradient>/)[1].matchAll(/stop-color="#([\da-f]{6})"/g)]
    return { 'linear-gradient': colors.map(([, hex]) => `srgb:${hex.match(/../g).map(pair => (parseInt(pair, 16) / 255).toFixed(5)).join(',')},1`),
      orientation: { start: { x: 0, y: 0 }, stop: { x: 0.8, y: 1 } } }
  }
  const glyphs = Object.entries(variants).map(([mode, svg]) => {
    const foreground = svg.replace(/<path id="tile"[^>]+\/>/, '').replace('viewBox="0 0 1024 1024"', 'viewBox="100 100 824 824"')
    if (foreground.includes('id="tile"') || !foreground.includes('viewBox="100 100 824 824"')) throw new Error('Invalid Icon Composer foreground geometry')
    const vector = join(staging, `glyph-${mode}.svg`), image = `glyph-${mode}.png`
    writeFileSync(vector, foreground)
    execFileSync('/usr/bin/sips', ['-s', 'format', 'png', vector, '--out', join(layers, image)])
    return { name: `eNest ${mode}`, 'image-name': image, glass: false, hidden: mode === 'dark',
      'hidden-specializations': [{ appearance: 'dark', value: mode !== 'dark' }] }
  })
  const manifest = { fill: gradient('light'), 'fill-specializations': [{ appearance: 'dark', value: gradient('dark') }],
    groups: [{ layers: glyphs, specular: false, shadow: { kind: 'neutral', opacity: 0 }, translucency: { enabled: false, value: 0 } }],
    'supported-platforms': { squares: 'shared' } }
  writeFileSync(join(composer, 'icon.json'), JSON.stringify(manifest, null, 2) + '\n')
}

const staging = mkdtempSync(join(tmpdir(), 'enest-icons-'))
try {
  const variants = { dark: source, light: source.replace(/#[\da-f]{6}\b/gi, color => lightColors[color] ?? color) }
  for (const [mode, svg] of Object.entries(variants)) {
    const working = join(staging, mode)
    mkdirSync(working)
    const light = mode === 'light', destination = light ? join(icons, 'light') : icons
    exportIcons(working, svg, destination, light ? destination : join(root, 'build'))
  }
  copyFileSync(join(icons, 'dock-runtime.png'), join(root, 'build', 'icon.png'))
  exportComposerIcon(staging, variants)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
