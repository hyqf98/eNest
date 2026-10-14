import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,mkdir,readFile,writeFile,readdir,symlink,rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
const output=await build({entryPoints:['src/main/paths/migrate.ts'],tsconfig:'tsconfig.node.json',bundle:true,write:false,format:'esm',platform:'node'})
const {migrateLegacyRoot}=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'))
async function fixture(fn){const root=await mkdtemp(join(tmpdir(),'enest-migrate-'));const source=join(root,'old'),target=join(root,'new');await mkdir(source);await mkdir(target);try{await fn({source,target,root})}finally{await rm(root,{recursive:true,force:true})}}
test('verified legacy data moves with SQLite integrity and conflicting target content preserved',async()=>fixture(async({source,target})=>{
 await mkdir(join(source,'data'));let db=new DatabaseSync(join(source,'data/enest.db'));db.exec('CREATE TABLE notes(value TEXT);INSERT INTO notes VALUES (\'hello\')');db.close()
 await writeFile(join(source,'settings.json'),'old');await writeFile(join(target,'settings.json'),'new');await writeFile(join(source,'unique'),'keep')
 await migrateLegacyRoot(source,target)
 assert.equal(existsSync(source),false);assert.equal(await readFile(join(target,'unique'),'utf8'),'keep');assert.equal(await readFile(join(target,'settings.json'),'utf8'),'new')
 const [snapshot]=await readdir(join(target,'migration-imports'));assert.equal(await readFile(join(target,'migration-imports',snapshot,'settings.json'),'utf8'),'old')
 db=new DatabaseSync(join(target,'data/enest.db'),{readOnly:true});assert.equal(db.prepare('SELECT value FROM notes').get().value,'hello');db.close()
}))
test('invalid database or symlink preserves the entire legacy source',async()=>fixture(async({source,target,root})=>{
 await mkdir(join(source,'data'));await writeFile(join(source,'data/enest.db'),'invalid database')
 await assert.rejects(migrateLegacyRoot(source,target));assert.equal(await readFile(join(source,'data/enest.db'),'utf8'),'invalid database')
 await writeFile(join(root,'secret'),'private');await symlink(join(root,'secret'),join(source,'link'))
 await assert.rejects(migrateLegacyRoot(source,target),/符号链接/);assert.equal(existsSync(source),true)
}))
