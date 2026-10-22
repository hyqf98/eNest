import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { build, transform } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const require = createRequire(import.meta.url)
async function load(path, mocks = {}) {
  const output = await build({
    entryPoints: [path], tsconfig: 'tsconfig.web.json', bundle: true, write: false,
    format: 'cjs', platform: 'node', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' },
    plugins: [{ name: 'test-surfaces', setup(builder) {
      builder.onResolve({ filter: /^@renderer\// }, args => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'fixture' } : null)
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }))
    } }],
  })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output.outputFiles[0].text)(require, module, module.exports)
  return module.exports
}

const { BUILTIN_THEME_PACKS } = await load('src/shared/theme/builtinThemes.ts')
const { ThemeSelectionCards } = await load('src/renderer/components/ThemeSelectionCards.tsx')
const { ThemeSettingsFields, themeFieldValue, visibleThemeFields } = await load('src/renderer/components/ThemeSettingsFields.tsx')
const { colorWithPreservedAlpha } = await load('src/renderer/services/themeResources.ts')
const pack = BUILTIN_THEME_PACKS[0]
const appearance = { ...pack.variants.light, mode: 'light', requestedMode: 'light', theme: pack, animation: { requested: 'medium', effective: 'medium' } }
const noOp = () => {}

test('theme tab fields come entirely from the active schema, including Tab style and field-local font import', () => {
  const html = renderToStaticMarkup(createElement(ThemeSettingsFields, {
    schema: pack.settings, appearance, values: {}, customFonts: [], importingFont: null,
    onChange: noOp, onCommit: noOp, onPickMedia: noOp, onImportFont: noOp,
  }))
  const allFields = pack.settings.groups.flatMap(group => group.fields)
  for (const group of pack.settings.groups) assert.ok(html.includes(group.title), group.title)
  for (const field of visibleThemeFields(allFields, allFields, appearance, {})) {
    // token/color 组走色板网格：字段改以 aria-label 断言，不再有逐行 data-theme-field
    if (field.type === 'token' || field.type === 'color') assert.ok(html.includes(`选择${field.label}颜色`), field.key)
    else assert.ok(html.includes(`data-theme-field="${field.key}"`), field.key)
  }
  assert.ok(html.includes('appearance-swatch-grid'), 'token groups render as swatch grid')
  assert.match(html, /data-theme-field="tabStyle"/)
  assert.equal((html.match(/导入字体<\/button>/g) ?? []).length, allFields.filter(field => field.type === 'font').length)
  assert.doesNotMatch(html, /公共资源与启动画面|原有自定义|splashBackground/)

  const minimal = renderToStaticMarkup(createElement(ThemeSettingsFields, {
    schema: { version: 1, groups: [{ id: 'provider', title: 'Provider-defined settings', fields: [allFields.find(field => field.key === 'gap')] }] },
    appearance, values: {}, customFonts: [], importingFont: null,
    onChange: noOp, onCommit: noOp, onPickMedia: noOp, onImportFont: noOp,
  }))
  assert.match(minimal, /Provider-defined settings/)
  assert.doesNotMatch(minimal, /导入字体|data-theme-field="tabStyle"/)
})

test('schema bindings read effective appearance values and conditions tolerate absent fields', () => {
  const all = pack.settings.groups.flatMap(group => group.fields)
  const gap = all.find(field => field.key === 'gap')
  assert.equal(themeFieldValue(gap, { ...appearance, layout: { ...appearance.layout, gap: 23 } }, {}), 23)
  assert.equal(themeFieldValue(gap, appearance, { gap: 0 }), 0)
  const dependent = { ...gap, key: 'dependent', visibleWhen: { field: 'gap', equals: 23 } }
  assert.deepEqual(visibleThemeFields([dependent], [gap, dependent], appearance, { gap: 23 }), [dependent])
  assert.deepEqual(visibleThemeFields([dependent], [], appearance, {}), [])
  const effect = { key: 'effect', type: 'switch', default: true, binding: { target: 'background', key: 'effect' } }
  assert.equal(themeFieldValue(effect, { ...appearance, background: { ...appearance.background, effect: 'none' } }, {}), false)
  const tabStyle = all.find(field => field.key === 'tabStyle')
  assert.equal(themeFieldValue(tabStyle, { ...appearance, layout: { ...appearance.layout, tabStyle: 'orb' } }, {}), 'orb')
})

test('theme cards support arbitrary provider IDs and derive their preview from semantic tokens and geometry', () => {
  const provider = structuredClone(pack)
  provider.source = 'com.example.future-theme'
  provider.name = 'A full future theme name'
  provider.variants.light.layout.columns = 5
  provider.variants.light.layout.tabStyle = 'orb'
  provider.variants.light.components.cardRadius = 18
  provider.variants.light.tokens['--accent'] = '#137355'
  const html = renderToStaticMarkup(createElement(ThemeSelectionCards, {
    packs: [pack, provider], selected: provider, mode: 'light', onSelect: noOp,
  }))
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1, 'identity includes source as well as ID')
  assert.match(html, /A full future theme name/)
  assert.match(html, /--preview-columns:5/)
  assert.match(html, /--preview-card-radius:9px/)
  assert.match(html, /--preview-accent:#137355/)
  assert.match(html, /data-tab-style="orb"/)
  const css = readFileSync(new URL('../styles/appearanceSettings.css', import.meta.url), 'utf8')
  assert.doesNotMatch(css, /data-(?:variant|appearance-theme)=|appearance-legacy/)
  assert.match(css, /overflow-wrap: anywhere/)
})

test('group headings keep one typographic scale above field labels', () => {
  const css = readFileSync(new URL('../styles/appearanceSettings.css', import.meta.url), 'utf8')
  const rule = selector => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css)
    assert.ok(match, `${selector} rule exists`)
    return match[1]
  }
  const title = rule('.appearance-group-title')
  assert.match(title, /font-size: calc\(15px \* var\(--appearance-font-scale, 1\)\)/, 'group title keeps its baseline hierarchy while following the theme font scale')
  assert.match(title, /font-weight: 600/)
  // 分组头承担小节分隔：全宽发丝线 + 上方留白，而不是压在标题自身
  const head = rule('.appearance-group-head')
  assert.match(head, /border-top: 1px solid var\(--border\)/)
  assert.match(head, /padding-top: 2[0-9]px/)
  assert.doesNotMatch(title, /border-top/)
  // 字段标签必须比分组标题轻，否则「分组」与「字段」读成同级
  const label = rule('.page-settings .field.appearance-field .label')
  assert.match(label, /font-weight: 500/)
  // 主题页只保留 16/15/13/12 四级字号，避免再出现 12.5px、10px 之类的碎档
  const sizes = [...css.matchAll(/font-size:\s*(?:calc\()?([\d.]+)px/g)].map(match => Number(match[1]))
  assert.ok(!sizes.includes(12.5), 'no stray 12.5px step')
  assert.ok(!sizes.includes(10), 'no stray 10px step')
})

test('settings host exposes appearance only under its theme tab and the shared CSS parses', async () => {
  const source = readFileSync(new URL('../pages/SettingsPage.tsx', import.meta.url), 'utf8')
  assert.equal((source.match(/<AppearanceSettingsSection\s*\/>/g) ?? []).length, 1)
  assert.match(source, /settingsTab === 'appearance' && <AppearanceSettingsSection/)
  assert.doesNotMatch(source, /settings\.general\.tabStyle|const tabStyle|setTabStyle/)
  const renderer = readFileSync(new URL('./AppearanceSettingsSection.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(renderer, /THEME_PROFILE_LEGACY|公共资源与启动画面|splashBackground/)
  assert.match(renderer, /schema=\{activePack\.settings\}/)
  // 主题 Tab 拆成两张卡：先切换主题，再渲染该主题支持的动态参数
  assert.match(renderer, /appearance-card-switch/)
  assert.match(renderer, /appearance-card-tuning/)
  assert.match(renderer, /<h2>切换主题<\/h2>/)
  assert.match(renderer, /<h2>主题参数<\/h2>/)
  assert.ok(renderer.indexOf('<h2>切换主题</h2>') < renderer.indexOf('<h2>主题参数</h2>'), 'switcher card precedes the dynamic tuning card')
  assert.match(renderer, /packs=\{appearance\.packs\}/, 'every installed pack, including plugin themes, is listed by the switcher')
  const result = await transform(readFileSync(new URL('../styles/appearanceSettings.css', import.meta.url), 'utf8'), { loader: 'css' })
  assert.deepEqual(result.warnings, [])
})

test('theme fields retain old color picker alpha, effect thumbnails, gradient cards and separate font menus', () => {
  assert.equal(colorWithPreservedAlpha('rgba(41,44,46,.08)', '#102030'), 'rgba(16, 32, 48, 0.08)')
  assert.equal(colorWithPreservedAlpha('rgba(242,243,243,.16)', '#abcdef'), 'rgba(171, 205, 239, 0.16)')
  assert.equal(colorWithPreservedAlpha('#bd542b', '#102030'), '#102030')
  const html = renderToStaticMarkup(createElement(ThemeSettingsFields, {
    schema: pack.settings, appearance, values: { backgroundType: 'gradient', splashType: 'image' }, customFonts: [], importingFont: null,
    onChange: noOp, onCommit: noOp, onPickMedia: noOp, onImportFont: noOp, onResetColors: noOp, onPreviewSplash: noOp,
  }))
  assert.doesNotMatch(html, /type="color"/)
  assert.match(html, /class="color-swatch-btn/)
  assert.match(html, /class="bg-effect-grid"/)
  assert.match(html, /class="theme-gradient-grid"/)
  assert.match(html, /bg-effect-tunnel/)
  assert.match(html, /data-theme-field="fontFamilyEn"/)
  assert.match(html, /data-theme-field="fontFamily"/)
  assert.match(html, /重播启动画面/)
  assert.match(html, /恢复配色/)
  assert.match(html, /启动背景图片/)
  assert.match(html, /山海可期/)
})

test('atmosphere and effect choices share four aligned columns across two rows', () => {
  const html = renderToStaticMarkup(createElement(ThemeSettingsFields, {
    schema: pack.settings, appearance, values: { backgroundType: 'gradient' }, customFonts: [], importingFont: null,
    onChange: noOp, onCommit: noOp, onPickMedia: noOp, onImportFont: noOp,
  }))
  assert.match(html, /class="theme-gradient-grid"[^>]*style="--theme-choice-columns:4"/)
  assert.match(html, /class="bg-effect-grid"[^>]*style="--theme-choice-columns:4"/)
  const css = readFileSync(new URL('../styles/appearanceSettings.css', import.meta.url), 'utf8')
  assert.match(css, /grid-template-columns: repeat\(var\(--theme-choice-columns, 4\), minmax\(96px, 1fr\)\)/)
  assert.match(css, /grid-auto-rows: 100px/)
  assert.match(css, /\.bg-effect-thumbnail, \.theme-gradient-preview \{[^}]*height: 60px; flex: 0 0 60px;/)
  assert.match(css, /overflow-x: auto/)
})

test('numeric micro-tunings collapse into one compact cluster instead of a full row each', () => {
  const html = renderToStaticMarkup(createElement(ThemeSettingsFields, {
    schema: pack.settings, appearance, values: {}, customFonts: [], importingFont: null,
    onChange: noOp, onCommit: noOp, onPickMedia: noOp, onImportFont: noOp, onResetColors: noOp, onPreviewSplash: noOp,
  }))
  const clusters = [...html.matchAll(/<div class="appearance-slider-cluster">(.*?)<\/div><\/section>/gs)].map(match => match[1])
  assert.equal(clusters.length, 2, 'layout and surface groups each collapse into one cluster')
  const surfaces = clusters.find(cluster => cluster.includes('控件圆角'))
  assert.ok(surfaces, 'the surface cluster is rendered')
  for (const key of ['radius', 'cardRadius', 'panelRadius', 'borderWidth', 'notificationRadius', 'notificationBorderWidth', 'notificationDensity']) {
    assert.match(surfaces, new RegExp(`data-theme-field="${key}"`), `${key} lives in the cluster`)
  }
  // 这些字段不再各占一整行 .field，滑杆标签直接写在紧凑块内
  for (const key of ['radius', 'panelRadius', 'notificationDensity']) {
    assert.doesNotMatch(html, new RegExp(`class="field appearance-field appearance-field-slider"[^>]*data-theme-field="${key}"`), key)
  }
  assert.match(surfaces, /appearance-slider-label">面板圆角/)
  // 背景类型等非微调滑杆仍保持单行 field
  assert.match(html, /data-theme-field="backgroundOpacity"/)
})

test('font fields put type specimen beside the label and keep one shared control column', () => {
  const css = readFileSync(new URL('../styles/appearanceSettings.css', import.meta.url), 'utf8')
  const html = renderToStaticMarkup(createElement(ThemeSettingsFields, {
    schema: pack.settings, appearance, values: {}, customFonts: [], importingFont: null,
    onChange: noOp, onCommit: noOp, onPickMedia: noOp, onImportFont: noOp, onResetColors: noOp, onPreviewSplash: noOp,
  }))
  // 字体绑定字段带语义类，三种字体与字号比例共用一条右列
  for (const key of ['fontFamilyEn', 'fontFamily', 'monoFont', 'fontScale']) {
    assert.match(html, new RegExp(`class="field appearance-field appearance-field-[a-z]+ appearance-field-target-font[^"]*" data-theme-field="${key}"`), key)
  }
  const rule = selector => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css)
    assert.ok(match, `${selector} rule exists`)
    return match[1]
  }
  // 右列固定 400px 且标签左对齐，四行控件才是同一条竖线
  const field = rule('.page-settings .field.appearance-field-target-font')
  assert.ok(field.includes('grid-template-columns: minmax(0, 1fr) minmax(0, 400px)'), 'shared 400px control column')
  // 字样在左侧标签下方，不占控件列
  const specimen = rule('.appearance-field-target-font .appearance-font-preview')
  assert.match(specimen, /white-space: nowrap/)
  assert.match(specimen, /text-overflow: ellipsis/)
  // 各槽位显示各自的示例文，而不是同一句混排
  assert.match(html, /The quick brown fox/)
  assert.match(html, /永字八法/)
  assert.match(html, /const nest = &quot;eNest&quot;/)
})

test('declared presentation and option previews drive host-rendered cards, never theme markup', () => {
  const custom = {
    version: 2,
    groups: [{ id: 'look', title: '外观', fields: [
      { key: 'atmosphere', label: '氛围配色', type: 'select', default: 'studioGlow', presentation: 'cards', options: [
        { label: '暖光', value: 'studioGlow', preview: { kind: 'asset', src: 'enest://plugin/com.example.studio/assets/previews/glow.webp' } },
        { label: '随主题', value: 'theme', preview: { kind: 'swatch', stops: ['#f6eee6', '#e4cbb9'] } },
      ], binding: { target: 'background', key: 'palette' } },
      { key: 'tabStyle', label: '标签页样式', type: 'select', default: 'classic', presentation: 'segmented', options: [{ label: '顶部标签', value: 'classic' }, { label: '左侧圆轨', value: 'orb' }], binding: { target: 'layout', key: 'tabStyle' } },
    ] }],
  }
  const palettes = [{ id: 'studioGlow', name: '工作室暖光', css: 'linear-gradient(160deg,#f6eee6,#e4cbb9)', swatch: 'linear-gradient(135deg,#d9b3a0,#f6eee6)' }]
  const html = renderToStaticMarkup(createElement(ThemeSettingsFields, {
    schema: custom, appearance, values: {}, customFonts: [], importingFont: null, palettes,
    onChange: noOp, onCommit: noOp, onPickMedia: noOp, onImportFont: noOp,
  }))
  // asset 预览走包内协议 URL；swatch 预览渲染成渐变小样。
  assert.match(html, /enest:\/\/plugin\/com\.example\.studio\/assets\/previews\/glow\.webp/)
  assert.match(html, /linear-gradient\(135deg, #f6eee6, #e4cbb9\)/)
  assert.match(html, /bg-effect-grid/, '声明 cards 时走卡片网格')
  // 声明 segmented 时走分段控件，而不是卡片。
  assert.match(html, /theme-setting-segmented/)
  assert.doesNotMatch(html, /<style|onclick=|javascript:/i, '预览数据不会变成可执行标记')
})

test('a custom atmosphere without an explicit preview still renders its declared swatch', () => {
  const schema = {
    version: 2,
    groups: [{ id: 'look', title: '外观', fields: [
      { key: 'atmosphere', label: '氛围配色', type: 'select', default: 'studioGlow', options: [{ label: '暖光', value: 'studioGlow' }], binding: { target: 'background', key: 'palette' } },
    ] }],
  }
  const palettes = [{ id: 'studioGlow', name: '工作室暖光', css: 'linear-gradient(160deg,#f6eee6,#e4cbb9)', swatch: 'linear-gradient(135deg,#d9b3a0,#f6eee6)' }]
  const html = renderToStaticMarkup(createElement(ThemeSettingsFields, {
    schema, appearance, values: {}, customFonts: [], importingFont: null, palettes,
    onChange: noOp, onCommit: noOp, onPickMedia: noOp, onImportFont: noOp,
  }))
  assert.match(html, /linear-gradient\(135deg,#d9b3a0,#f6eee6\)/, 'declared swatch 被渲染')
  assert.doesNotMatch(html, /bg-effect-none/, '不落回占位符')
})
