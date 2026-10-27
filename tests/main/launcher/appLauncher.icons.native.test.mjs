// ENEST_ICON_SMOKE=1 node --test tests/main/launcher/appLauncher.icons.native.test.mjs
// Uses a separate Electron process and temporary output; no application build required.
import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
test('installed macOS applications produce distinct native colour icons and instant cached reuse', {
  skip: process.env.ENEST_ICON_SMOKE !== '1' || process.platform !== 'darwin', timeout: 60_000
}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'enest-app-icons-native-'))
  const paths = ['/Applications/Safari.app', '/Applications/Microsoft Edge.app', '/Applications/ChatGPT.app',
    '/System/Applications/Calculator.app', '/System/Applications/Calendar.app', '/System/Library/CoreServices/Finder.app']
  const output = join(dir, 'results.json'), main = join(dir, 'main.cjs')
  const result = await build({
    stdin: { resolveDir: root, contents: `
      import {app,nativeImage} from 'electron';
      import {writeFile} from 'node:fs/promises';
      import {createHash} from 'node:crypto';
      import {join} from 'node:path';
      import {getAppIconDataUrl} from '@main/launcher/appLauncher';
      app.setPath('userData',${JSON.stringify(join(dir, 'user-data'))});
      app.setActivationPolicy('prohibited');
      app.whenReady().then(async()=>{
        const paths=${JSON.stringify(paths)};
        const start=performance.now();
        const icons=await Promise.all(paths.map(path=>getAppIconDataUrl(path)));
        const coldMs=performance.now()-start;
        const warmStart=performance.now();
        const cached=await Promise.all(paths.map(path=>getAppIconDataUrl(path)));
        const warmMs=performance.now()-warmStart;
        const results=[];
        for(let i=0;i<icons.length;i++){
          const url=icons[i];
          if(!url){results.push({path:paths[i],missing:true});continue}
          const image=nativeImage.createFromDataURL(url),png=image.toPNG(),pixels=image.toBitmap();
          let colourPixels=0;
          for(let p=0;p<pixels.length;p+=4)if(pixels[p+3]>20&&Math.max(pixels[p],pixels[p+1],pixels[p+2])-Math.min(pixels[p],pixels[p+1],pixels[p+2])>25)colourPixels++;
          await writeFile(join(${JSON.stringify(dir)},i+'.png'),png);
          results.push({path:paths[i],size:image.getSize(),bytes:png.length,sha256:createHash('sha256').update(png).digest('hex'),colourPixels,cacheEqual:url===cached[i]});
        }
        await writeFile(${JSON.stringify(output)},JSON.stringify({coldMs,warmMs,results},null,2));
        app.quit();
      }).catch(error=>{console.error(error);app.exit(1)});
    ` }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['electron'], tsconfig: join(root, 'tsconfig.node.json'),
    plugins: [{ name: 'isolate', setup(builder) {
      builder.onResolve({ filter: /(?:^\.\/appScanner$|^@main\/logs\/logService$)/ }, ({ path }) => ({ path, namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path.includes('appScanner') ? 'export const getCachedApps=()=>null' : 'export const logError=()=>{};export const logWarn=()=>{};export const logInfo=()=>{}' }))
    } }]
  })
  await writeFile(main, result.outputFiles[0].text)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  await promisify(execFile)(createRequire(import.meta.url)('electron'), [main], { env, timeout: 55_000 })
  const evidence = JSON.parse(await readFile(output, 'utf8'))
  assert.equal(evidence.results.length, paths.length)
  assert.ok(evidence.results.every(icon => !icon.missing && icon.size.width <= 96 && icon.size.height <= 96 && icon.cacheEqual))
  assert.equal(new Set(evidence.results.map(icon => icon.sha256)).size, paths.length)
  assert.ok(evidence.results.filter(icon => icon.colourPixels > 100).length >= 5)
  t.diagnostic(JSON.stringify({ artifacts: dir, ...evidence }))
})
