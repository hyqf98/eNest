import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import ts from 'typescript'
const require=createRequire(import.meta.url)
function load(file,mocks={}) { const js=ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const module={exports:{}};new Function('require','module','exports',js)(name=>mocks[name]??require(name),module,module.exports);return module.exports }
function fixture() {
 const events=[],clients=[],scopeApi=load('../plugin/PluginRuntimeScope.ts'),scope=scopeApi.createRuntimeScope({pluginId:'auth-test',generation:1,wcId:100})
 class Channel extends EventEmitter { destroy() {} }
 class Client extends EventEmitter {
  constructor(){super();clients.push(this)}
  connect(config){this.config=config;queueMicrotask(()=>this.emit('keyboard-interactive','Two-factor','Enter credentials','',[{prompt:'Password:',echo:false},{prompt:'OTP:'}],answers=>{this.answers=answers;this.emit('ready')}));return this}
  shell(_options,callback){callback(null,new Channel())}
  destroy(){if(!this.destroyed){this.destroyed=true;this.emit('close')}}
 }
 const api=load('./sshSessionManager.ts',{ssh2:{Client},electron:{dialog:{}},'@main/plugin/PluginPermissions':{authorizePluginPermission:async()=>{throw new Error('permission denied')}},'@main/plugin/localFiles':{resolveLocalFileHandle:async()=>'/tmp/selected-file',resolveLocalDirectoryTarget:async()=>'/tmp/selected-file'},'@main/plugin/PluginRuntimeScope':scopeApi,'@main/ssh/sshProxy': load('./sshProxy.ts'), '@main/vault/secretVault':{},'@main/ssh/commandDict':{},'@main/window/createShellWindow':{},'@main/plugin/PluginHost':{pluginHost:{sendEvent:(_id,event)=>events.push(event)}},'@main/logs/logService':{logInfo(){},logWarn(){}},'@main/ssh/sshTrust':{},'@main/ssh/sshSystem':{releaseSystemState(){}},'@main/plugin/activityRegistry':{acquirePluginActivity:()=>()=>{}},'@main/window/createQuickWindow':{}})
 return {api,events,clients,scope,connect:()=>api.sshConnect('auth-test',{host:'test',username:'user',authType:'keyboard-interactive'})}
}
test('interactive authentication exposes prompts without credentials and accepts answers only from owner',async()=>{
 const f=fixture(),pending=f.connect();await new Promise(resolve=>setImmediate(resolve));const challenge=f.events.find(e=>e.type==='ssh.auth')
 assert.ok(challenge);assert.equal(challenge.prompts[1].echo,false);assert.equal(f.clients[0].config.tryKeyboard,true)
 assert.throws(()=>f.api.sshRespondAuth('other-plugin',challenge.challengeId,['secret','123456']),/过期/)
 assert.throws(()=>f.api.sshRespondAuth('auth-test',challenge.challengeId,['only-one']),/无效/)
 f.api.sshRespondAuth('auth-test',challenge.challengeId,['secret','123456']);const session=await pending
 assert.deepEqual(f.clients[0].answers,['secret','123456']);assert.throws(()=>f.api.sshRespondAuth('auth-test',challenge.challengeId,['again','again']),/过期/)
 f.api.sshDisconnect('auth-test',session.sessionId);f.scope.markClosing()
})
test('cancelling an auth prompt rejects pending connection and releases the challenge',async()=>{
 const f=fixture(),pending=f.connect();await new Promise(resolve=>setImmediate(resolve));const challenge=f.events.find(e=>e.type==='ssh.auth')
 f.api.sshRespondAuth('auth-test',challenge.challengeId,null);await assert.rejects(pending,/closing/)
 assert.equal(f.scope.activityCount,0);assert.equal(f.clients[0].destroyed,true);assert.throws(()=>f.api.sshRespondAuth('auth-test',challenge.challengeId,[]),/过期/);f.scope.markClosing()
})
test('closing runtime removes an unanswered auth prompt',async()=>{
 const f=fixture(),pending=f.connect();await new Promise(resolve=>setImmediate(resolve));const challenge=f.events.find(e=>e.type==='ssh.auth')
 f.scope.markClosing();await assert.rejects(pending,/closing/);assert.throws(()=>f.api.sshRespondAuth('auth-test',challenge.challengeId,['secret','otp']),/过期/)
})
