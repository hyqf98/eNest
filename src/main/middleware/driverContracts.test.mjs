import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

async function fixture() {
  const adapters = {
    mqtt: 'export default {};',
    amqplib: 'export async function connect(){throw new Error("network disabled in fixture")}',
    '@main/middleware/httpRequest': `export const calls=[]; export let answer={}; export const respond=value=>{answer=value}; export async function mwHttpJson(url,options){calls.push({url,options});return answer};export const mwHttp=mwHttpJson;`
  }
  const result = await build({stdin:{resolveDir:process.cwd(),contents:"export {mqttDriver} from '@main/middleware/drivers/mqtt';export {rocketmqDriver} from '@main/middleware/drivers/rocketmq';export {rabbitmqDriver} from '@main/middleware/drivers/rabbitmq';export {calls,respond} from '@main/middleware/httpRequest';"},tsconfig:'tsconfig.node.json',bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'offline-services',setup(b){b.onResolve({filter:/.*/},({path})=>path in adapters?{path,namespace:'stub'}:undefined);b.onLoad({filter:/.*/,namespace:'stub'},({path})=>({contents:adapters[path]}))}}]})
  return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text + `\n// ${Math.random()}`).toString('base64'))
}

test('EMQX queries carry the detected management endpoint and credentials', async () => {
  const c=await fixture()
  const h={runtime:{mgmt:{version:'v5',base:'https://broker.test:18083',username:'test-key',password:'test-secret'}}}
  c.respond({data:[{topic:'events',clientid:'test'}]})
  const topics=await c.mqttDriver.topicsList(h,{})
  assert.equal(topics[0].name,'events')
  assert.equal(c.calls[0].url,'https://broker.test:18083/api/v5/subscriptions?limit=200')
  assert.equal(c.calls[0].options.basicAuth.username,'test-key')
  assert.equal(c.calls[0].options.basicAuth.password,'test-secret')
  h.runtime.mgmt.version='v4'
  c.respond({code:0,data:[]})
  await c.mqttDriver.clientsList(h,{})
  assert.equal(c.calls.at(-1).url,'https://broker.test:18083/api/v4/connections')
})

test('RocketMQ key and message-id query inputs match the plugin form contract', async () => {
  const c=await fixture(),h={config:{},runtime:{base:'https://dashboard.test'}}
  c.respond({status:0,data:{msgList:[{msgId:'one',topic:'events',body:'test'}]}})
  const keyed=await c.rocketmqDriver.messagesQuery(h,{topic:'events',from:'key',key:'order/1'})
  assert.equal(keyed[0].messageId,'one')
  assert.match(c.calls[0].url,/key=order%2F1$/)
  c.respond({status:0,data:{messageView:{msgId:'two',topic:'events',body:'message'}}})
  const byId=await c.rocketmqDriver.messagesQuery(h,{topic:'events',from:'id',messageId:'two'})
  assert.equal(byId[0].messageId,'two')
  assert.match(c.calls.at(-1).url,/viewMessage.query\?msgId=two$/)
  await assert.rejects(c.rocketmqDriver.messagesQuery(h,{topic:'events',from:'id'}),/messageId/)
})

test('middleware HTTP drivers verify certificates unless a connection explicitly opts out', async () => {
  const c = await fixture()
  c.respond({ status: 200 })
  for (const [driver, endpoint] of [
    [c.rabbitmqDriver, { managementUrl: 'https://fixture.invalid' }],
    [c.rocketmqDriver, { dashboardUrl: 'https://fixture.invalid' }]
  ]) {
    for (const tlsRejectUnauthorized of [undefined, true, false]) {
      await driver.test({ ...endpoint, tlsRejectUnauthorized }, 'synthetic')
      assert.equal(c.calls.at(-1).options.insecureTls, tlsRejectUnauthorized === false)
    }
  }
  for (const insecureTls of [undefined, false, true]) {
    c.respond({ data: [] })
    await c.mqttDriver.clientsList({ runtime: { mgmt: { version: 'v5', base: 'https://fixture.invalid', username: 'fixture', password: 'synthetic', insecureTls } } }, {})
    assert.equal(c.calls.at(-1).options.insecureTls, insecureTls === true)
  }
})
