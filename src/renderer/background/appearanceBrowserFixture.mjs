import { existsSync, readFileSync } from 'node:fs'
import { build } from 'esbuild'

export const chrome = process.env.ENEST_CHROME_EXECUTABLE ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync)

const output = await build({
  stdin: { resolveDir: process.cwd(), contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {AppBackground} from '@renderer/components/AppBackground';
    import {AppearanceSettingsSection} from '@renderer/components/AppearanceSettingsSection';
    import {useAppearanceStore} from '@renderer/hooks/useAppearance';
    import {BUILTIN_THEME_PACKS} from '@shared/theme/builtinThemes';
    import {migrateAppearanceSettings,patchThemeProfile,resolveAppearance,themeProfileKey} from '@shared/theme/appearance';
    const pack=BUILTIN_THEME_PACKS[0];
    let settings=migrateAppearanceSettings(undefined,{theme:{mode:'light',overrides:{}},general:{}});
    const key=themeProfileKey(pack); settings.profiles[key].values.motion='low';
    let mediaOverride;
    function snapshot(){
      const appearance=resolveAppearance({settings,pack,systemDark:false});
      if(mediaOverride!==undefined) appearance.background.media=mediaOverride;
      return {appearance,profile:settings.profiles[key],packs:[pack],customFonts:[]};
    }
    const root=createRoot(document.getElementById('root'));
    window.appearanceFixture={
      snapshot,
      async update(patch){
        settings={...settings,revision:settings.revision+1,profiles:{...settings.profiles,[key]:patchThemeProfile(pack,settings.profiles[key],patch)}};return snapshot()},
      async mode(mode){settings={...settings,mode,revision:settings.revision+1};return snapshot()},
      publish(values={}){settings={...settings,revision:settings.revision+1,profiles:{...settings.profiles,[key]:patchThemeProfile(pack,settings.profiles[key],{theme:{source:pack.source,id:pack.id},values})}};useAppearanceStore.getState().applySnapshot(snapshot())},
      media(value){mediaOverride=value;settings={...settings,revision:settings.revision+1};useAppearanceStore.getState().applySnapshot(snapshot())},
      setMode(mode){settings={...settings,mode,revision:settings.revision+1};useAppearanceStore.getState().applySnapshot(snapshot())},
      unmount(){root.unmount()},
    };
    useAppearanceStore.getState().applySnapshot(snapshot());
    root.render(React.createElement(React.Fragment,null,
      React.createElement('section',{id:'stage'},React.createElement(AppBackground)),
      React.createElement('aside',{className:'page-settings'},React.createElement(AppearanceSettingsSection))));
  ` },
  tsconfig: 'tsconfig.web.json', bundle: true, write: false, platform: 'browser', format: 'iife',
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty' },
  plugins: [{ name: 'appearance-schema-fixture', setup(builder) {
    const adapters = {
      '@renderer/hooks/useFpsGuard': 'export const useFpsGuard=()=>{};',
      '@renderer/stores/shellStore': 'export const useShellStore=selector=>selector({view:"home",pluginReady:false});',
      '@renderer/services/notifyService': 'export const notify={error(){},info(){},success(){}};',
      '@renderer/services/shellApi': `export const shellApi={getAppearance:async()=>window.appearanceFixture.snapshot(),
        updateThemeProfile:patch=>window.appearanceFixture.update(patch),setAppearanceMode:mode=>window.appearanceFixture.mode(mode),
        activateTheme:async()=>window.appearanceFixture.snapshot(),onEvent:()=>()=>{},
        importAppearanceFont:async()=>null,pickAppearanceMedia:async()=>null,
        setSettings:async()=>{throw new Error('Appearance fields must not write generic settings')}};export const isMockShell=true;`,
    }
    builder.onResolve({ filter: /.*/ }, ({ path }) => path in adapters ? { path, namespace: 'fixture' } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: adapters[path] }))
  } }],
})

const css = ['tokens.css', 'app.css', 'settingsBase.css', 'settings.css', 'appearance.css', 'appearanceSettings.css', 'backgroundEffect.css']
  .map(file => readFileSync(`src/renderer/styles/${file}`, 'utf8').replace(/^@import.*$/gm, '')).join('\n')
  + readFileSync('src/renderer/components/ui/ui.css', 'utf8')

export async function mountAppearanceFixture(page) {
  await page.setContent(`<style>${css}
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;color:var(--text)}
    #root{display:grid;grid-template-columns:minmax(240px,42%) minmax(0,1fr);gap:20px;height:100%;padding:20px}
    #stage{position:relative;height:100%;overflow:hidden;border-radius:var(--appearance-panel-radius)}
    #stage .app-bg{position:absolute}
    aside.page-settings{min-width:0;height:100%;padding:0;overflow:auto}.s-card{margin:0;}
    @media(max-width:650px){#root{grid-template-columns:minmax(0,1fr);grid-template-rows:170px minmax(0,1fr);padding:12px;gap:12px}}
  </style><div id="root"></div>`)
  await page.addScriptTag({ content: output.outputFiles[0].text })
  await page.waitForSelector('.appearance-settings [data-theme-field="backgroundEffect"]')
}
