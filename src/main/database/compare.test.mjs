import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const root=fileURLToPath(new URL('../../../',import.meta.url))
const bundle=await build({entryPoints:[root+'src/main/database/compare.ts'],tsconfig:root+'tsconfig.node.json',bundle:true,write:false,platform:'node',format:'esm'})
const {compareResults,comparisonValue}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))
const result=(names,rows,truncated=false)=>({columns:names.map(name=>({name})),rows,rowCount:rows.length,truncated,durationMs:1})

test('mapped keys and decimal rules preserve large integer precision across engines',()=>{
  const input={keyColumns:['id'],columnMappings:[{left:'id',right:'key',rule:'numeric'},{left:'amount',right:'value',rule:'numeric'}]}
  const equal=compareResults(result(['id','amount'],[['9007199254740993','001.2300']]),result(['key','value'],[[9007199254740993n,'123e-2']]),input)
  assert.equal(equal.rows[0].status,'equal')
  const different=compareResults(result(['id','amount'],[['1','9007199254740993']]),result(['key','value'],[[1,'9007199254740992']]),input)
  assert.equal(different.rows[0].status,'different')
  assert.equal(comparisonValue('-0.000','numeric'),comparisonValue(0,'numeric'))
  assert.notEqual(comparisonValue(null,'numeric'),comparisonValue(0,'numeric'))
})

test('JSON normalization, strict typing and explicit projections behave predictably',()=>{
  assert.equal(comparisonValue('{"b":2,"a":1}','json'),comparisonValue({a:1,b:2},'json'))
  assert.notEqual(comparisonValue('{"id":9007199254740993}','json'),comparisonValue('{"id":9007199254740992}','json'))
  assert.notEqual(comparisonValue(1,'strict'),comparisonValue('1','strict'))
  assert.equal(comparisonValue(1,'text'),comparisonValue('1','text'))
  assert.throws(()=>comparisonValue('not a number','numeric'),/non-numeric/)
  assert.throws(()=>comparisonValue('{bad}','json'),/invalid JSON/)
  const a=result(['id','left-only'],[[1,'data']]),b=result(['id'],[[1]])
  assert.equal(compareResults(a,b,['id']).rows[0].status,'different')
  assert.equal(compareResults(a,b,{keyColumns:['id'],columnMappings:[{left:'id',right:'id'}]}).rows[0].status,'equal')
})

test('duplicate keys remain ambiguous and capped result coverage stays explicit',()=>{
  const compared=compareResults(result(['id'],[[1],[1],[2]],true),result(['id'],[[1],[3]]),['id'])
  assert.deepEqual(compared.rows.map(row=>row.status),['ambiguous','left-only','right-only'])
  assert.equal(compared.partial,true)
  assert.deepEqual(compared.coverage,{leftRows:3,rightRows:2,leftTruncated:true,rightTruncated:false})
  assert.throws(()=>compareResults(result(['id','id'],[[1,2]]),result(['id'],[[1]]),['id']),/unique column/)
  assert.throws(()=>compareResults(result(['id'],[[1]]),result(['other'],[[1]]),['id']),/missing/)
})
