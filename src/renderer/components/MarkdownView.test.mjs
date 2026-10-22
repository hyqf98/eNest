import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const output=await build({entryPoints:['src/renderer/components/MarkdownView.tsx'],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'react',setup(b){b.onResolve({filter:/^react$/},()=>({path:'react',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const Fragment=Symbol();export const createElement=()=>null;'}))}}]})
const {resolveMarkdownImage}=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'))
test('Markdown images only resolve declared same-package local paths and versioned remote attachments',()=>{
 const local='enest://plugin/com.example.test/assets/market/README.md'
 assert.equal(resolveMarkdownImage('./screenshots/one.png',local),'enest://plugin/com.example.test/assets/market/screenshots/one.png')
 for(const value of ['../secret.png','%2e%2e/secret.png','https://evil.test/track.png','//evil.test/one.png','javascript:x','file:///a.png','screenshots/x.png?q=1'])assert.equal(resolveMarkdownImage(value,local),undefined,value)
 const remote='https://example.com/release/test@1.0-README.md'
 assert.equal(resolveMarkdownImage('./screenshots/one.png',remote,{'screenshots/one.png':'https://example.com/release/test@1.0-screenshot-1.png'}),'https://example.com/release/test@1.0-screenshot-1.png')
 assert.equal(resolveMarkdownImage('./screenshots/one.png',remote,{'screenshots/one.png':'https://evil.test/track.png'}),undefined)
})
test('Home README images use only the same plugin declared screenshot slots',()=>{
 const base='enest-home://catalog/com.example.test/readme'
 const image='enest-home://catalog/com.example.test/screenshot/0'
 assert.equal(resolveMarkdownImage('./screenshots/one.png',base,{'screenshots/one.png':image}),image)
 assert.equal(resolveMarkdownImage('./screenshots/one.png',base),undefined)
 for(const target of ['enest-home://catalog/com.other/screenshot/0','enest-home://catalog/com.example.test/icon','enest-home://catalog/com.example.test/screenshot/8','enest-home://catalog/com.example.test/screenshot/0?url=https://evil.test','https://evil.test/one.png']){
  assert.equal(resolveMarkdownImage('./screenshots/one.png',base,{'screenshots/one.png':target}),undefined,target)
 }
})
