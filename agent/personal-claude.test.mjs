import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm,copyFile,realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
test('personal launcher isolates configuration and registers the portable bridge',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'duplex-profile-')))
 t.after(()=>rm(root,{recursive:true,force:true}))
 await mkdir(join(root,'agent'))
 await copyFile(new URL('./personal-claude.mjs',import.meta.url),join(root,'agent','personal-claude.mjs'))
 const log=join(root,'calls.jsonl')
 const mock=join(root,'claude-mock')
 await writeFile(mock,'#!/usr/bin/env node\n'+`const fs=require('node:fs');fs.appendFileSync(process.env.TEST_LOG,JSON.stringify({args:process.argv.slice(2),profile:process.env.CLAUDE_CONFIG_DIR,apiKey:process.env.ANTHROPIC_API_KEY,provider:process.env.CLAUDE_CODE_USE_BEDROCK,restriction:process.env.CLAUDE_CODE_RESTRICTED})+'\\n');process.exit(process.argv[2]==='mcp'&&process.argv[3]==='get'?1:0)`,{mode:0o700})
 const env={...process.env,NOTEBOOK_DUPLEX_CLAUDE_BIN:mock,TEST_LOG:log,ANTHROPIC_API_KEY:'test-work-key',CLAUDE_CODE_USE_BEDROCK:'1',CLAUDE_CONFIG_DIR:'/test/work-profile',CLAUDE_CODE_RESTRICTED:'1'}
 const result=spawnSync(process.execPath,[join(root,'agent','personal-claude.mjs'),'--register-only'],{env,encoding:'utf8'})
 assert.equal(result.status,0,result.stderr)
 const calls=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line))
 assert.equal(calls.length,2)
 assert.equal(calls[0].profile,join(root,'.personal-claude'))
 assert.equal(calls[0].apiKey,undefined)
 assert.equal(calls[0].provider,undefined)
 assert.equal(calls[0].restriction,'1','restriction controls must remain inherited')
 assert.deepEqual(calls[1].args,['mcp','add','--transport','stdio','--scope','user','notebook-duplex','--',process.execPath,join(root,'agent','bridge.mjs')])
})
