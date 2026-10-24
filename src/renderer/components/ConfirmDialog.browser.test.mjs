import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const enabled = process.env.ENEST_CONFIRM_UI === '1'
test('shared confirmation protects real plugin actions, cancels safely and traps/restores keyboard focus', { skip: !enabled, timeout: 45000 }, async () => {
  const output = await build({
    stdin: { contents: `
      import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
      import {ConfirmDialog} from '@renderer/components/ConfirmDialog';
      import {confirmAction} from '@renderer/services/confirmAction';
      import {PluginCard} from '@renderer/themes/default/workspace/preview/PluginCard';
      import {PluginDetailModal} from '@renderer/themes/default/workspace/preview/PluginDetailModal';
      import {DevConsoleSection} from '@renderer/components/DevConsoleSection';
      import {useShellStore} from '@renderer/stores/shellStore';
      import '@renderer/themes/default/workspace/detail.css';
      const plugin={id:'com.example.memo', name:'备忘录', description:'随手记录想法与待办事项',version:'1.2.0',latestVersion:'1.3.0',installed:true,enabled:true,category:'效率',permissions:[],dev:true,glyph:'M'};
      window.confirmAction=confirmAction;window.calls=[];window.detailCloseCount=0;window.nativeConfirms=0;
      window.confirm=()=>{window.nativeConfirms++;return false};
      useShellStore.setState({plugins:[plugin],removeDevPlugin:async id=>window.calls.push(['remove',id])});
      function Fixture(){const[page,setPage]=useState('card');const[mounted,setMounted]=useState(true);
        window.setPage=setPage;window.setMounted=setMounted;
        return <React.StrictMode><main style={{padding:32,maxWidth:800,margin:'auto'}}><h1>eNest 插件管理</h1><button id="outside">外部控件</button>
          {page==='card'?<PluginCard plugin={plugin} onOpen={()=>{}}/>:page==='detail'?<PluginDetailModal plugin={plugin} onClose={()=>window.detailCloseCount++} onInstall={()=>{}}/>:<DevConsoleSection/>}
        </main>{mounted&&<ConfirmDialog/>}</React.StrictMode>}
      createRoot(document.getElementById('root')).render(<Fixture/>);
    `, resolveDir: process.cwd(), loader: 'tsx' },
    tsconfig: 'tsconfig.web.json', bundle: true, write: false, outfile: 'test.js', platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"', 'import.meta.hot': 'undefined' },
    plugins: [{ name: 'shell', setup(b) {
      b.onResolve({filter:/^@renderer\/services\/shellApi$/},()=>({path:'shell',namespace:'fixture'}));
      b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const shellApi={onEvent:()=>()=>{},getSettings:async()=>({}),getPluginReadme:async()=>'',uninstallPlugin:async id=>window.calls.push(['uninstall',id]),installMarketPlugin:async(id,options)=>window.calls.push(['update',id,options]),systemNotify:async()=>{}}`}))
    } }]
  })
  const browser = await chromium.launch({ executablePath: process.env.ENEST_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 }, reducedMotion: 'reduce' })
  page.setDefaultTimeout(10000)
  const errors=[];page.on('pageerror',error=>errors.push(error.message))
  const evidenceDir='docs/engineering/settings-ui-validation-2026-10-15'
  try {
    const css = await Promise.all(['src/renderer/styles/tokens.css','src/renderer/styles/app.css','src/renderer/themes/default/workspace/market.css','src/renderer/styles/settings.css'].map(path=>readFile(path,'utf8')))
    await page.setContent(`<html lang="zh-CN" data-theme="light" data-anim="low"><style>${css.join('\n')}\n${output.outputFiles.find(file=>file.path.endsWith('.css')).text}</style><body><div id="root"></div></body></html>`)
    await page.addScriptTag({content:output.outputFiles.find(file=>file.path.endsWith('.js')).text})
    const confirm = page.locator('.confirm-overlay')
    const panel = page.locator('.confirm-panel')
    const open = page.getByRole('button',{name:'备忘录 · 卸载',exact:true})
    const cancel = panel.getByRole('button',{name:'取消',exact:true})
    const accept = panel.getByRole('button',{name:'卸载',exact:true})
    const active = locator=>locator.evaluate(el=>document.activeElement===el)
    const calls = ()=>page.evaluate(()=>window.calls)
    await open.click();await confirm.waitFor({state:'visible'})
    assert.equal(await active(cancel),true,'default focus is the safe action')
    assert.deepEqual(await calls(),[])
    await page.keyboard.press('Shift+Tab');assert.equal(await active(accept),true)
    await page.keyboard.press('Tab');assert.equal(await active(cancel),true)
    await page.evaluate(()=>document.querySelector('#outside').focus());assert.equal(await active(cancel),true,'modal makes background inert')
    await mkdir(evidenceDir,{recursive:true})
    await page.screenshot({path:`${evidenceDir}/confirm-uninstall-light.png`})
    await page.keyboard.press('Enter');await confirm.waitFor({state:'detached'})
    assert.deepEqual(await calls(),[],'Enter on initially focused Cancel does not uninstall')
    assert.equal(await active(open),true,'focus returns to opener')
    await open.click();await confirm.waitFor({state:'visible'})
    assert.equal(await page.evaluate(()=>window.confirmAction({title:'重复请求',message:'不应显示',confirmLabel:'继续'})),false)
    assert.equal(await confirm.count(),1)
    await page.mouse.click(12,12);await confirm.waitFor({state:'detached'});assert.deepEqual(await calls(),[])
    await open.click();await confirm.waitFor({state:'visible'});await accept.click();await confirm.waitFor({state:'detached'})
    assert.deepEqual(await calls(),[['uninstall','com.example.memo']])

    await page.evaluate(()=>{window.calls=[];window.setPage('detail')})
    const detail=page.locator('.detail-modal')
    await detail.getByRole('button',{name:'卸载',exact:true}).click();await confirm.waitFor({state:'visible'})
    await page.keyboard.press('Escape');await confirm.waitFor({state:'detached'})
    assert.equal(await page.evaluate(()=>window.detailCloseCount),0,'Escape cannot close the underlying detail modal')
    assert.deepEqual(await calls(),[])
    await detail.getByRole('button',{name:'卸载',exact:true}).click();await accept.click();await confirm.waitFor({state:'detached'})
    assert.deepEqual(await calls(),[['uninstall','com.example.memo']])

    await page.evaluate(()=>{window.calls=[];window.setPage('card')});await open.waitFor()
    await page.evaluate(()=>window.setPage('detail'))
    await detail.getByRole('button',{name:/更新/}).click();await confirm.waitFor({state:'visible'})
    await cancel.click();await confirm.waitFor({state:'detached'});assert.deepEqual(await calls(),[])
    await detail.getByRole('button',{name:/更新/}).click();await confirm.waitFor({state:'visible'})
    await page.evaluate(()=>document.documentElement.dataset.theme='dark')
    await page.screenshot({path:`${evidenceDir}/confirm-update-dark.png`})
    await page.keyboard.press('Tab');await page.keyboard.press('Enter');await confirm.waitFor({state:'detached'})
    assert.deepEqual(await calls(),[['update','com.example.memo',{force:true}]])

    await page.evaluate(()=>{window.calls=[];window.setPage('dev')})
    const remove=page.getByRole('button',{name:'移出',exact:true})
    await remove.click();await confirm.waitFor({state:'visible'});await cancel.click();await confirm.waitFor({state:'detached'})
    assert.deepEqual(await calls(),[])
    await remove.click();await confirm.waitFor({state:'visible'})
    await panel.getByRole('button',{name:'移出',exact:true}).click();await confirm.waitFor({state:'detached'})
    assert.deepEqual(await calls(),[['remove','com.example.memo']])
    await remove.click();await confirm.waitFor({state:'visible'})
    await page.evaluate(()=>window.setMounted(false));await confirm.waitFor({state:'detached'})
    assert.deepEqual(await calls(),[['remove','com.example.memo']],'unmount cancels pending action')
    await page.evaluate(()=>window.setMounted(true));await remove.click();await confirm.waitFor({state:'visible'})
    await page.setViewportSize({width:390,height:600})
    assert.equal(await panel.evaluate(el=>el.scrollWidth>el.clientWidth),false)
    await page.screenshot({path:`${evidenceDir}/confirm-remove-narrow.png`})
    await page.keyboard.press('Escape');await confirm.waitFor({state:'detached'})
    assert.equal(await page.evaluate(()=>window.nativeConfirms),0)
    assert.deepEqual(errors,[])
    await writeFile(`${evidenceDir}/confirm-result.json`,JSON.stringify({status:'pass',checks:['four real action entry points','cancel and confirm','initial safe focus','keyboard focus cycle','focus restoration','background inert','Escape keeps detail open','backdrop cancel','duplicate request rejected','unmount cancels','390px no overflow'],nativeConfirmCalls:0},null,2))
  } catch(error) { throw new Error(`${error.stack}\nBrowser errors: ${JSON.stringify(errors)}`) }
  finally { await browser.close() }
})
