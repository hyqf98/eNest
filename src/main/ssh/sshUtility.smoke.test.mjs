/** ENEST_ELECTRON_SSH_SMOKE=1 node --test src/main/ssh/sshUtility.smoke.test.mjs */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
const require=createRequire(import.meta.url), run=promisify(execFile), root=fileURLToPath(new URL('../../../',import.meta.url))
async function freePort(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port}

test('packaged SSH and remote desktop utilities preserve OpenSSH, SFTP, tunnels and owner cleanup',{skip:process.env.ENEST_ELECTRON_SSH_SMOKE!=='1',timeout:45000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'enest-ssh-utility-'));let daemon,daemonExit,echo,daemonLog=''
 try{
  const sshd=process.env.ENEST_TEST_SSHD||'/usr/sbin/sshd',sftp=process.platform==='darwin'?'/usr/libexec/sftp-server':'/usr/lib/openssh/sftp-server'
  for(const name of ['host-key','client-key'])await run('ssh-keygen',['-q','-t','ed25519','-N','','-f',join(dir,name)])
  await writeFile(join(dir,'authorized_keys'),await readFile(join(dir,'client-key.pub')),{mode:0o600})
  const wrapper=join(dir,'command.sh');await writeFile(wrapper,`#!/bin/sh\ncase "$SSH_ORIGINAL_COMMAND" in\n '') exec /bin/cat ;;\n 'printf enest-utility-ok') exec /usr/bin/printf enest-utility-ok ;;\n 'internal-sftp') exec ${sftp} ;;\n *) exit 126 ;;\nesac\n`,{mode:0o700})
  const port=await freePort(),config=join(dir,'sshd_config')
  await writeFile(config,[`Port ${port}`,'ListenAddress 127.0.0.1',`HostKey ${dir}/host-key`,`AuthorizedKeysFile ${dir}/authorized_keys`,`PidFile ${dir}/sshd.pid`,'PasswordAuthentication no','KbdInteractiveAuthentication no','PubkeyAuthentication yes','UsePAM no','StrictModes no','UseDNS no','PermitRootLogin no',`AllowUsers ${userInfo().username}`,'PermitUserRC no','AllowAgentForwarding no','AllowTcpForwarding yes','X11Forwarding no',`ForceCommand ${wrapper}`,'Subsystem sftp internal-sftp','LogLevel ERROR',''].join('\n'))
  await run(sshd,['-t','-f',config]);daemon=spawn(sshd,['-D','-e','-f',config],{stdio:['ignore','pipe','pipe'],detached:true});daemonExit=new Promise(r=>daemon.once('exit',r));daemon.stderr.on('data',x=>daemonLog+=x);await delay(150);assert.equal(daemon.exitCode,null,daemonLog)
  const fingerprint='SHA256:'+createHash('sha256').update(Buffer.from((await readFile(join(dir,'host-key.pub'),'utf8')).split(' ')[1],'base64')).digest('base64').replace(/=+$/,'')
  echo=createServer(socket=>socket.pipe(socket));await new Promise(r=>echo.listen(0,'127.0.0.1',r));const echoPort=echo.address().port,tunnelPorts=[await freePort(),await freePort()]
  const adapters={
   '@main/plugin/pluginBackend':`export const resolvePluginBackendEntry=id=>${JSON.stringify(join(root,'eNest_plugin/plugins'))}+'/'+id+'/dist/backend/index.cjs';`,
   '@main/plugin/PluginPermissions':'export const authorizePluginPermission=async()=>{throw new Error("unexpected optional permission")};',
   '@main/plugin/PluginHost':'export const pluginHost={sendEvent:(...args)=>{globalThis.__sshEvents??=[];globalThis.__sshEvents.push(args)},getWebContents:()=>null,getContainerWindow:()=>null};',
   '@main/window/createQuickWindow':'export const acquireQuickInteraction=()=>()=>{};',
   '@main/vault/secretVault':'export const resolveSecret=()=>null;',
   '@main/db/pluginStorage':`const storage=new Map();export const getPluginStorageValue=(id,key)=>storage.has(id+key)?storage.get(id+key):key==='ssh.knownHosts.v1'?[{host:'127.0.0.1',port:${port},fingerprint:${JSON.stringify(fingerprint)},firstSeen:0}]:undefined;export const setPluginStorageValue=(id,key,value)=>storage.set(id+key,value);`,
   '@main/logs/logService':'export const logInfo=()=>{};export const logWarn=(...args)=>console.error(...args);'
  }
  await build({bundle:true,platform:'node',format:'esm',packages:'external',tsconfig:join(root,'tsconfig.node.json'),stdin:{resolveDir:root,contents:`
   import assert from 'node:assert/strict';import {app} from 'electron';import {writeFile,readFile,mkdir} from 'node:fs/promises';import {join} from 'node:path';import {createHash} from 'node:crypto';import {createConnection} from 'node:net';
   import * as ssh from '@main/ssh/sshSessionManager';import {sshWorkbench} from '@main/ssh/sshWorkbench';import {createRuntimeScope} from '@main/plugin/PluginRuntimeScope';import {grantLocalFile,releaseLocalFiles} from '@main/plugin/localFiles';import {hasPluginActivity} from '@main/plugin/activityRegistry';
   app.setPath('userData',${JSON.stringify(join(dir,'profile'))});app.disableHardwareAcceleration();const dir=${JSON.stringify(dir)},ids=['com.enest.ssh','com.enest.remote-desktop'],tunnelPorts=${JSON.stringify(tunnelPorts)};
   app.whenReady().then(async()=>{app.dock?.hide();const scopes=[],sessions=[],evidence=[];let firstHandle;try{
    for(let index=0;index<ids.length;index++){
     const id=ids[index],scope=createRuntimeScope({pluginId:id,generation:1,wcId:100+index});scopes.push(scope);const key=await grantLocalFile(id,join(dir,'client-key'));
     const connection=await ssh.sshConnect(id,{host:'127.0.0.1',port:${port},username:${JSON.stringify(userInfo().username)},authType:'key',privateKeyHandleId:key.id,fingerprintPolicy:'strict'});sessions.push(connection.sessionId);
     assert.equal(connection.fingerprint,${JSON.stringify(fingerprint)});assert.equal((await ssh.sshExec(id,{sessionId:connection.sessionId,command:'printf enest-utility-ok'})).stdout,'enest-utility-ok');
     const remote=join(dir,'remote-'+index+'.txt');const written=await sshWorkbench(id,{action:'files.write',sessionId:connection.sessionId,path:remote,content:'utility SFTP 中文'});const read=await sshWorkbench(id,{action:'files.read',sessionId:connection.sessionId,path:remote});assert.equal(read.content,'utility SFTP 中文');assert.equal(read.hash,written.hash);
     await assert.rejects(sshWorkbench(id,{action:'files.write',sessionId:connection.sessionId,path:remote,content:'stale',expectedHash:'wrong'}),/已被修改/);
     const payload=Buffer.alloc(262144,65+index),uploadPath=join(dir,'upload-'+index),destination=join(dir,'download-'+index);await writeFile(uploadPath,payload);await mkdir(destination);const upload=await grantLocalFile(id,uploadPath),download=await grantLocalFile(id,destination,{writable:true});
     if(index===0)firstHandle=upload.id;else await assert.rejects(ssh.sshSftpUpload(id,{sessionId:connection.sessionId,localHandleId:firstHandle,remotePath:remote}),/invalid or expired/);
     assert.equal((await ssh.sshSftpUpload(id,{sessionId:connection.sessionId,localHandleId:upload.id,remotePath:remote})).ok,true);assert.equal((await ssh.sshSftpDownload(id,{sessionId:connection.sessionId,localDirectoryHandleId:download.id,remotePath:remote})).ok,true);
     const digest=value=>createHash('sha256').update(value).digest('hex');assert.equal(digest(await readFile(join(destination,'remote-'+index+'.txt'))),digest(payload));await assert.rejects(ssh.sshSftpUpload(id,{sessionId:connection.sessionId,localPath:uploadPath,remotePath:remote}),/raw local paths/);
     const tunnel=await sshWorkbench(id,{action:'tunnel.open',sessionId:connection.sessionId,localPort:tunnelPorts[index],remoteHost:'127.0.0.1',remotePort:${echoPort}});
     const received=await new Promise((resolve,reject)=>{const socket=createConnection({host:'127.0.0.1',port:tunnelPorts[index]},()=>socket.write('through-plugin-tunnel'));socket.setTimeout(3000,()=>{socket.destroy();reject(new Error('tunnel timeout'))});socket.once('error',reject);socket.once('data',data=>{resolve(data.toString());socket.destroy()})});assert.equal(received,'through-plugin-tunnel');await sshWorkbench(id,{action:'tunnel.close',id:tunnel.id});assert.ok(scope.activityCount>=1);assert.equal(hasPluginActivity(id),true);
     evidence.push({pluginId:id,exec:true,sftpBytes:payload.length,sftpSha256:digest(payload),tunnel:true,backendPid:app.getAppMetrics().filter(x=>x.name?.includes(id)).map(x=>x.pid)});
    }
    for(let index=0;index<ids.length;index++){await ssh.sshDisconnect(ids[index],sessions[index]);assert.deepEqual(await ssh.sshListSessions(ids[index]),[]);scopes[index].markClosing();ssh.releaseSshSessions(ids[index],1);await scopes[index].dispose();releaseLocalFiles(ids[index]);assert.equal(hasPluginActivity(ids[index]),false)}
    await new Promise(resolve=>setTimeout(resolve,500));const remaining=app.getAppMetrics().filter(x=>x.name?.startsWith('eNest backend:'));assert.equal(remaining.length,0);
    console.log('ENEST_SSH_UTILITY '+JSON.stringify({electron:process.versions.electron,platform:process.platform,plugins:evidence,remainingBackendProcesses:remaining.length,boundary:'Real packaged utility processes and OpenSSH with production file grants; loader grants, storage and UI are isolated fixtures.'}));app.exit(0);
   }catch(error){console.error(error);for(const id of ids)ssh.releaseSshSessions(id);app.exit(1)}});
  `},outfile:join(dir,'bootstrap.mjs'),plugins:[{name:'fixtures',setup(b){b.onResolve({filter:/^@main\//},({path})=>path in adapters?{path,namespace:'fixture'}:undefined);b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:adapters[path],loader:'js'}))}}]})
  const output=await new Promise((resolve,reject)=>{const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(require('electron'),[join(dir,'bootstrap.mjs'),'--no-sandbox'],{env,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('SSH utility timed out\n'+out+'\n'+err+'\n'+daemonLog))},30000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);code===0?resolve(out):reject(new Error('Electron exit '+code+'\n'+out+'\n'+err+'\n'+daemonLog))})})
  const marker=output.split('\n').find(x=>x.startsWith('ENEST_SSH_UTILITY '));assert.ok(marker,output);const evidence=JSON.parse(marker.slice('ENEST_SSH_UTILITY '.length));assert.equal(evidence.plugins.length,2);assert.equal(evidence.remainingBackendProcesses,0)
  if(process.env.ENEST_ELECTRON_SSH_OUTPUT)await writeFile(process.env.ENEST_ELECTRON_SSH_OUTPUT,JSON.stringify(evidence,null,2)+'\n');console.log('Packaged SSH utility evidence:',JSON.stringify(evidence))
 }finally{if(daemon&&daemon.exitCode===null&&daemon.signalCode===null){try{process.kill(-daemon.pid,'SIGTERM')}catch{};await Promise.race([daemonExit,delay(2000)]);if(daemon.exitCode===null&&daemon.signalCode===null){try{process.kill(-daemon.pid,'SIGKILL')}catch{}}}if(echo)await new Promise(r=>echo.close(r));await rm(dir,{recursive:true,force:true})}
})
