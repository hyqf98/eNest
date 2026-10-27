import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'
import postcss from 'postcss'
import ts from 'typescript'

const theme = dirname(fileURLToPath(import.meta.url))
const renderer = resolve(theme, '../..')
const read = path => readFileSync(join(renderer, path), 'utf8')
const moved = new Map([
  ...['FeaturedCarousel', 'MarketCategoryView', 'PluginCardView', 'PluginDetailView', 'ProductVisual', 'PluginScreenshotGallery', 'CategoryChips', 'SegmentTabs', 'SearchBox'].map(name => [`components/${name}.tsx`, `themes/default/workspace/${name}.tsx`]),
  ['components/usePluginDetailMotion.ts', 'themes/default/workspace/usePluginDetailMotion.ts'],
  ['components/pluginPresentation.ts', 'themes/default/workspace/pluginPresentation.ts'],
  ['hooks/useProductCarousel.ts', 'themes/default/workspace/useProductCarousel.ts'],
  ...['PluginCard', 'MarketCategorySection', 'PluginDetailModal', 'HomeSearch'].map(name => [`components/${name}.tsx`, `themes/default/workspace/preview/${name}.tsx`]),
  ['pages/MarketPage.tsx', 'themes/default/workspace/preview/MarketPage.tsx'],
  ['components/PaperSplash.tsx', 'themes/default/PaperSplash.tsx'],
  ...['splashMotion', 'logoAssembly'].map(name => [`gsap/${name}.ts`, `themes/default/motion/${name}.ts`]),
  ...['detail', 'market', 'featured', 'productVisual', 'categoryChips', 'homeSearch'].map(name => [`styles/${name}.css`, `themes/default/workspace/${name}.css`]),
  ['styles/splash.css', 'themes/default/splash.css'],
])

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })
}

function resolveSource(specifier, source) {
  const candidate = specifier.startsWith('@renderer/')
    ? join(renderer, specifier.slice('@renderer/'.length))
    : specifier.startsWith('@shared/')
      ? resolve(renderer, '../shared', specifier.slice('@shared/'.length))
      : specifier.startsWith('.') ? resolve(dirname(source), specifier) : undefined
  if (!candidate) return undefined
  return [candidate, ...['.ts', '.tsx', '.css', '.json', '/index.ts', '/index.tsx'].map(extension => candidate + extension)].find(existsSync)
}

function cssImport(node, filename) {
  const specifier = node.params.match(/^(?:url\()?['"]([^'"]+)['"]\)?$/)?.[1]
  assert.ok(specifier, `${filename}: unsupported import ${node.params}`)
  const target = resolveSource(specifier, filename)
  assert.ok(target, `${filename}: unresolved import ${specifier}`)
  return target
}

// Expand imports and selector groups without losing cascade, declaration, or condition order.
function cssFingerprint(entry) {
  const records = []
  const visited = new Set()
  const normalize = value => value.replace(/\s+/g, ' ').trim()
  function visit(filename, conditions = [], ancestry = []) {
    assert.equal(ancestry.includes(filename), false, `CSS import cycle: ${filename}`)
    assert.equal(visited.has(filename), false, `Repeated CSS import: ${filename}`)
    visited.add(filename)
    const root = postcss.parse(readFileSync(filename, 'utf8'), { from: filename })
    function descend(nodes, activeConditions) {
      for (const node of nodes) {
        if (node.type === 'comment') continue
        if (node.type === 'atrule' && node.name === 'import') {
          visit(cssImport(node, filename), activeConditions, [...ancestry, filename])
        } else if (node.type === 'rule') {
          const declarations = node.nodes.filter(child => child.type === 'decl')
            .map(child => [child.prop, normalize(child.value), Boolean(child.important)])
          for (const selector of postcss.list.comma(node.selector)) records.push([activeConditions, normalize(selector), declarations])
          assert.equal(node.nodes.some(child => !['decl', 'comment'].includes(child.type)), false, `${filename}: unexpected nested rule`)
        } else if (node.type === 'atrule' && node.nodes) {
          descend(node.nodes, [...activeConditions, `@${node.name} ${normalize(node.params)}`])
        } else if (node.type === 'atrule') records.push([activeConditions, `@${node.name} ${normalize(node.params)}`, []])
        else assert.fail(`${filename}: unexpected CSS node ${node.type}`)
      }
    }
    descend(root.nodes, conditions)
  }
  visit(join(renderer, entry))
  return {
    sha256: createHash('sha256').update(JSON.stringify(records)).digest('hex'),
    selectorRecords: records.length,
    files: visited.size,
  }
}

const orderedCss = new Map([
  // app: frozen ordered AST reassembly; the other entries were compared directly before/after extraction.
  ['styles/app.css', { sha256: 'd92c7fdb4342750e470cd187f0add57fae27161b510bef561349917285cac5b9', selectorRecords: 449, files: 44 }],
  ['styles/backgroundEffect.css', { sha256: 'd4db729c8d3b6132bc3adabf68ba905425e6aee6fa49ce55d21056bf4b335567', selectorRecords: 21, files: 8 }],
  ['styles/appearance.css', { sha256: '05436214a21c062eb15632805070616a21dc610f40805cd8ca7565467b40f05e', selectorRecords: 45, files: 5 }],
])

test('default-theme presentation and launch implementations have one physical owner', () => {
  assert.equal(moved.size, 27)
  for (const [previous, current] of moved) {
    assert.equal(existsSync(join(renderer, previous)), false, previous)
    assert.equal(existsSync(join(renderer, current)), true, current)
  }
  assert.equal(existsSync(join(renderer, 'gsap/ambientFlow.ts')), false)
})

test('relocated real TypeScript modules compile and resolve their local contract imports', () => {
  const modules = [...moved.values(), 'themes/default/motion/workspaceMotion.ts'].filter(path => /\.tsx?$/.test(path))
  assert.equal(modules.length, 21)
  for (const path of modules) {
    const filename = join(renderer, path)
    const source = read(path)
    const compiled = ts.transpileModule(source, {
      fileName: filename,
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
    })
    assert.deepEqual((compiled.diagnostics ?? []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error), [], path)
    const syntax = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
    for (const statement of syntax.statements) {
      if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) || !statement.moduleSpecifier) continue
      const specifier = statement.moduleSpecifier.text
      if (/^(?:@renderer\/|@shared\/|\.)/.test(specifier)) assert.ok(resolveSource(specifier, filename), `${path}: ${specifier}`)
      assert.equal(specifier.startsWith('../'), false, `${path}: use aliases across directories`)
    }
  }
})

test('restricted Workspace presentation does not import the trusted preview adapter', () => {
  const modules = files(join(theme, 'workspace')).filter(path => /\.tsx?$/.test(path) && !path.includes('/preview/'))
  for (const path of [...modules, join(theme, 'DefaultWorkspace.tsx')]) {
    const source = readFileSync(path, 'utf8')
    assert.doesNotMatch(source, /@renderer\/(?:services\/shellApi|themes\/default\/workspace\/preview\/)/, path)
  }
  const shell = read('layout/ShellLayout.tsx')
  assert.match(shell, /const MarketPage = import\.meta\.env\.DEV\s*\? lazy\(/)
  assert.match(shell, /isMockShell && MarketPage \? <MarketPage \/> : <HomeRecovery \/>/)
  assert.match(read('services/shellApi.ts'), /import\.meta\.env\.DEV/)
  const compile = development => transformSync(shell, {
    loader: 'tsx', format: 'esm', minify: true, treeShaking: true,
    define: { 'import.meta.env.DEV': String(development) },
  }).code
  assert.doesNotMatch(compile(false), /workspace\/preview\/MarketPage/)
  assert.match(compile(true), /workspace\/preview\/MarketPage/)
})

test('generic motion budgets remain shared while Workspace and Tab choreography belong to the theme', () => {
  const shared = read('gsap/marketMotion.ts')
  const specific = read('themes/default/motion/workspaceMotion.ts')
  for (const name of ['d', 'dy', 'ease', 'applyLevelToDefaults', 'getEffectiveMotionTokens', 'notifyIn', 'playUpdateDialogIn']) {
    assert.match(shared, new RegExp(`export function ${name}\\(`))
  }
  for (const name of ['playHeroIn', 'animateCards', 'animateTabIn']) {
    assert.doesNotMatch(shared, new RegExp(`export function ${name}\\(`))
    assert.match(specific, new RegExp(`export function ${name}\\(`))
  }
  assert.doesNotMatch(shared, /data-detail-(?:backdrop|modal)|\.carousel-block|\.home-toolbar/)
  assert.doesNotMatch(shared, /playModalIn|playModalOut/)
  assert.match(read('themes/default/chrome/TabStrip.tsx'), /themes\/default\/motion\/workspaceMotion/)
})

test('CSS fragments retain cascade order and separate shared foundations from default-theme presentation', () => {
  assert.match(read('styles/app.css'), /@import '\.\/markdown\.css'/)
  assert.doesNotMatch(read('components/MarkdownView.tsx'), /themes\/default/)
  assert.match(read('styles/markdown.css'), /\.markdown-body \.md-pre code/)
  assert.match(read('styles/markdown.css'), /@media \(max-width: 640px\)/)
  assert.match(read('styles/markdown.css'), /\.md-link-text/)
  assert.match(read('styles/base.css'), /\.sr-only \{/)
  assert.doesNotMatch(read('themes/default/workspace/detail.css'), /\.markdown-body/)
  assert.doesNotMatch(read('themes/default/workspace/market.css'), /\.sr-only/)

  for (const [entry, expected] of orderedCss) {
    const root = postcss.parse(read(entry), { from: join(renderer, entry) })
    assert.ok(root.nodes.every(node => node.type === 'comment' || (node.type === 'atrule' && node.name === 'import')), entry)
    assert.deepEqual(cssFingerprint(entry), expected, entry)
  }
  const privateSelector = /\.(?:profile-[\w-]+|dev-[\w-]+|settings-[\w-]+|tab-style-[\w-]+|classic-icon\b|orb-icon\b|notify-pos-[\w-]+|center-icon\b|corner-icon\b|quick-[\w-]+|hotkey-[\w-]+|path-(?:actions|text)\b|proxy-[\w-]+|anim-(?:settings|level-seg)\b|splash-[\w-]+|plugin-slider-[\w-]+|detail-(?:overlay|modal)\b|page-home\b|market-source-notice\b|card-(?:description|author)\b|theme-row\b|field\b|s-card\b)/
  for (const filename of files(join(renderer, 'styles')).filter(path => path.endsWith('.css'))) {
    const root = postcss.parse(readFileSync(filename, 'utf8'), { from: filename })
    root.walkRules(rule => {
      if (filename === join(renderer, 'styles/semanticAppearance.css')) {
        // The standard material adapter keeps mixed :is() groups intact to preserve specificity.
        if (privateSelector.test(rule.selector)) {
          assert.match(rule.selector, /^:where\(:root\[data-appearance-theme\]\[data-appearance-legacy='false'\]\) :is\(/)
          assert.ok(rule.nodes.every(node => node.type === 'comment' || (node.type === 'decl' && ['border-width', 'border-radius', 'font-family'].includes(node.prop))))
        }
      } else assert.doesNotMatch(rule.selector, privateSelector, filename)
    })
  }
  for (const [path, selector] of [
    ['settings/profileAndFields.css', /\.profile-user/],
    ['settings/controlPreviews.css', /\.notify-pos-icon/],
    ['settings/quickHotkeyPresets.css', /\.quick-hotkey-block/],
    ['settings/developerConsole.css', /\.dev-card-head/],
    ['workspace/detailPerspective.css', /\.detail-modal/],
    ['splashBackground.css', /\.splash--effect/],
    ['quick/atmosphereSurfaces.css', /\.quick-shell/],
    ['quick/semanticAppearance.css', /\.quick-shell/],
  ]) assert.match(read(`themes/default/${path}`), selector, path)
})

test('production renderer references do not target the retired implementation paths', () => {
  const retired = [...moved.keys()].map(path => `@renderer/${path.replace(/\.(?:tsx?|mjs)$/, '')}`)
  for (const path of files(renderer).filter(path => ['.ts', '.tsx', '.css'].includes(extname(path)))) {
    const source = readFileSync(path, 'utf8')
    for (const alias of retired) {
      assert.equal(source.includes(`'${alias}'`) || source.includes(`"${alias}"`), false, `${path}: ${alias}`)
    }
  }
})
