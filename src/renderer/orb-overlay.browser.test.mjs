import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

test('dock smoothly reverses avatar/settings layers, preserves focus and loads only the latest local avatar', { skip: process.env.ENEST_ORB_DOCK_UI !== '1', timeout: 45000 }, async () => {
  const output = await build({ entryPoints:['src/renderer/orb-overlay.ts'], tsconfig:'tsconfig.web.json', bundle:true, write:false, outfile:'orb.js', format:'iife', platform:'browser', define:{'import.meta.hot':'undefined'} })
  const browser = await chromium.launch({executablePath:process.env.ENEST_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']})
  const page = await browser.newPage({viewport:{width:400,height:260},deviceScaleFactor:3})
  const errors=[], remote=[];page.on('pageerror',error=>errors.push(error.message))
  page.on('request',request=>{if(/^https?:/.test(request.url())&&!request.url().startsWith('http://orb.fixture/'))remote.push(request.url())})
  const evidence={checks:[],traces:{},errors,remoteRequests:remote}
  const directory='docs/engineering/orb-dock-validation-2026-10-15'
  try {
    await page.route('http://orb.fixture/**',route=>route.fulfill({contentType:'text/html',body:`<html data-anim="low"><head><style>${output.outputFiles.find(file=>file.path.endsWith('.css')).text}#orb-root{width:80px;height:72px}</style></head><body><div id="orb-root"></div></body></html>`}))
    await page.goto('http://orb.fixture/orb-overlay.html?part=dock&anim=low')
    await page.evaluate(()=>{
      const make=(color,label)=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=80;const context=canvas.getContext('2d');context.fillStyle=color;context.fillRect(0,0,80,80);context.fillStyle='#ffffff';context.font='bold 42px system-ui';context.textAlign='center';context.textBaseline='middle';context.fillText(label,40,42);return canvas.toDataURL()}
      window.avatars=[make('#407e96','A'),make('#b86b43','B'),make('#6a8d47','C')]
      window.current={view:'home',tabStyle:'orb',activeTabId:null,animationLevel:'low',theme:{mode:'light',tokens:{}},profile:null,tabs:[]}
      window.calls=[];window.offCount=0;window.push=patch=>{window.current={...window.current,...patch};window.listener?.({state:window.current})}
      window.enestShell={onOrbEvent:listener=>{window.listener=listener;return()=>{window.offCount++;window.listener=null}},getOrbState:()=>new Promise(resolve=>{window.resolveInitial=resolve}),setShellView:async view=>{window.calls.push(view);window.push({view})}}
      window.snapshot=()=>{const style=selector=>{const element=document.querySelector(selector),css=getComputedStyle(element);return{opacity:Number(css.opacity),transform:css.transform,duration:css.transitionDuration}};return{time:performance.now(),avatar:style('.orb-dock-avatar'),icon:style('.orb-dock-icon'),slot:document.querySelector('.orb-dock-avatar').dataset.avatarSlot,images:[...document.querySelectorAll('.orb-avatar-img')].map(image=>({opacity:Number(getComputedStyle(image).opacity),source:window.avatars.indexOf(image.getAttribute('src'))}))}}
      window.trace=ms=>new Promise(resolve=>{const rows=[],start=performance.now();const tick=()=>{rows.push(window.snapshot());if(performance.now()-start<ms)requestAnimationFrame(tick);else resolve(rows)};requestAnimationFrame(tick)})
    })
    await page.addScriptTag({content:output.outputFiles.find(file=>file.path.endsWith('.js')).text})
    const button=page.getByRole('button',{name:'设置',exact:true})
    await button.waitFor()
    await page.evaluate(()=>{window.buttonIdentity=document.querySelector('[data-settings]');window.push({profile:{name:'本地账号 A',avatar:window.avatars[0]}});window.resolveInitial({...window.current,profile:null})})
    await page.waitForFunction(()=>document.querySelector('.orb-dock-avatar').dataset.avatarSlot!=='none')
    await page.waitForTimeout(190)
    assert.equal(await page.locator('[data-settings]').getAttribute('aria-label'),'本地账号 A · 设置','late startup read cannot roll back a newer account event')
    await mkdir(directory,{recursive:true});await page.screenshot({path:directory+'/avatar.png',omitBackground:true,clip:{x:0,y:0,width:80,height:72}})

    const buttonNow=page.locator('[data-settings]')
    for(const level of ['low','medium','high']){
      await page.mouse.move(75,2);await page.evaluate(level=>window.push({animationLevel:level,view:'home'}),level);await page.waitForTimeout(310)
      const tracePromise=page.evaluate(()=>window.trace(400));await page.mouse.move(30,34);const trace=await tracePromise
      evidence.traces[level]=trace
      assert.ok(trace.some(frame=>frame.icon.opacity>0.02&&frame.icon.opacity<0.98),`${level}: settings must fade through intermediate frames`)
      assert.ok(trace.some(frame=>frame.avatar.opacity>0.02&&frame.avatar.opacity<0.98),`${level}: avatar must fade through intermediate frames`)
      assert.ok(trace.at(-1).icon.opacity>0.99)
      evidence.traces[level]=trace;evidence.checks.push(`${level} hover crossfade`)
    }
    await page.screenshot({path:directory+'/settings-hover.png',omitBackground:true,clip:{x:0,y:0,width:80,height:72}})
    await page.mouse.move(75,2);await page.waitForTimeout(310);await page.mouse.move(30,34);await page.waitForTimeout(65)
    const before=await page.evaluate(()=>window.snapshot())
    await page.mouse.move(75,2);const reverse=await page.evaluate(()=>window.trace(340))
    assert.ok(Math.abs(reverse[0].icon.opacity-before.icon.opacity)<0.35,'reversal starts from the current visible opacity')
    assert.ok(reverse.some(frame=>frame.icon.opacity>0.01&&frame.icon.opacity<before.icon.opacity))
    assert.ok(reverse.at(-1).avatar.opacity>0.99);evidence.traces.reverse=reverse

    await page.keyboard.press('Tab');assert.equal(await buttonNow.evaluate(el=>document.activeElement===el),true)
    await page.waitForTimeout(310);assert.ok((await page.evaluate(()=>window.snapshot())).icon.opacity>0.99)
    await page.keyboard.press('Enter');assert.deepEqual(await page.evaluate(()=>window.calls),['settings'])
    await page.evaluate(()=>document.querySelector('[data-settings]').blur());await page.waitForTimeout(310)
    assert.ok((await page.evaluate(()=>window.snapshot())).icon.opacity>0.99,'settings stays visible when the page is active')
    await page.evaluate(()=>window.push({view:'home'}));const activeExit=await page.evaluate(()=>window.trace(340))
    assert.ok(activeExit.some(frame=>frame.avatar.opacity>0.01&&frame.avatar.opacity<0.99));evidence.traces.activeExit=activeExit
    assert.equal(await page.evaluate(()=>window.buttonIdentity===document.querySelector('[data-settings]')),true)
    evidence.checks.push('interrupted reversal','keyboard focus and Enter','active page fade','stable button identity')

    await page.evaluate(()=>window.push({profile:{name:'本地账号 B',avatar:window.avatars[1]}}))
    await page.waitForTimeout(55)
    const accountTrace=page.evaluate(()=>window.trace(700))
    await page.evaluate(()=>window.push({profile:{name:'本地账号 C',avatar:window.avatars[2]}}))
    const avatars=await accountTrace;evidence.traces.avatars=avatars
    assert.ok(avatars.some(frame=>frame.images.filter(image=>image.opacity>0.01&&image.opacity<0.99).length===2),'account change crossfades two decoded buffers')
    const visible=avatars.at(-1).images.find(image=>image.opacity>0.99);assert.equal(visible?.source,2,'latest avatar wins')
    assert.equal(await page.locator('[data-settings]').getAttribute('aria-label'),'本地账号 C · 设置')
    await page.evaluate(()=>window.push({profile:{name:'无法加载',avatar:'data:image/png;base64,broken'}}))
    await page.waitForFunction(()=>document.querySelector('.orb-dock-avatar').dataset.avatarSlot==='none')
    await page.waitForTimeout(310)
    assert.equal(await page.locator('.orb-avatar-img[src]').count(),0)
    await page.evaluate(()=>window.push({profile:{name:'不远程加载',avatar:'https://private.invalid/avatar.png'}}))
    await page.waitForTimeout(50);assert.deepEqual(remote,[])
    await page.evaluate(()=>window.push({profile:{name:'本地账号 A',avatar:window.avatars[0]}}))
    await page.waitForTimeout(310);await page.evaluate(()=>window.push({profile:null}));await page.waitForTimeout(310)
    assert.equal(await page.locator('.orb-avatar-img[src]').count(),0)
    assert.equal(await page.locator('[data-settings]').getAttribute('aria-label'),'设置')
    evidence.checks.push('decoded avatar crossfade','latest update wins','broken image fallback','no remote avatar request','logout clears images and account label')

    await page.emulateMedia({reducedMotion:'reduce'});await page.mouse.move(75,2);await page.waitForTimeout(180)
    const reducedTrace=page.evaluate(()=>window.trace(220));await page.mouse.move(30,34);const reduced=await reducedTrace
    assert.ok(reduced.every(frame=>frame.avatar.transform==='none'&&frame.icon.transform==='none'))
    assert.ok(reduced.some(frame=>frame.icon.opacity>0.01&&frame.icon.opacity<0.99));evidence.traces.reduced=reduced
    assert.equal(await buttonNow.evaluate(el=>getComputedStyle(el).pointerEvents),'auto')
    assert.equal(await page.locator('#orb-root').evaluate(el=>getComputedStyle(el).pointerEvents),'none')
    assert.equal(await page.locator('body').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)')
    assert.equal(await page.locator('.orb-dock-icon').evaluate(el=>getComputedStyle(el).pointerEvents),'none')
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))
    assert.equal(await page.evaluate(()=>window.offCount),1)
    evidence.checks.push('reduced motion opacity only','transparent canvas and unchanged hit regions','pagehide cleanup')
    assert.deepEqual(errors,[]);evidence.status='pass'
    await writeFile(directory+'/result.json',JSON.stringify(evidence,null,2));await rm(directory+'/failure.json',{force:true})
  }catch(error){await mkdir(directory,{recursive:true});await writeFile(directory+'/failure.json',JSON.stringify({...evidence,failure:String(error)},null,2));throw error}
  finally{await browser.close()}
})
