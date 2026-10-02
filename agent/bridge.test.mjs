import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {realpath} from 'node:fs/promises'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js'
import {z} from 'zod'
import {startBroker,until} from './test-helpers.mjs'
test('MCP bridge delivers commands and returns reviewable proposals',async t=>{
 let client
 t.after(()=>client?.close())
 const {runtime,connection,request}=await startBroker(t)
 const notifications=[]
 client=new Client({name:'margin-test',version:'1.0.0'},{capabilities:{}})
 client.setNotificationHandler(z.object({method:z.literal('notifications/claude/channel'),params:z.object({content:z.string(),meta:z.record(z.string())})}),event=>{notifications.push(event.params)})
 const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./bridge.mjs',import.meta.url))],cwd:runtime,env:{...process.env,MARGIN_RUNTIME_DIR:runtime,MARGIN_SESSION_NAME:'Integration test'}})
 await client.connect(transport)
 assert.deepEqual(client.getServerCapabilities().experimental['claude/channel'],{})
 const session=await until(async()=>{const {data}=await request('/state');return data.sessions[0]})
 assert.equal(await realpath(session.repo),await realpath(runtime))
 assert.equal(session.secret,undefined,'session secrets must not appear in the UI state')
 const document={type:'doc',content:[{type:'paragraph',attrs:{id:'p'},content:[{type:'text',text:'A draft paragraph.'}]}]}
 assert.equal((await request('/sync',{json:document,markdown:'A draft paragraph.',title:'Test',expectedRevision:0})).ok,true)
 const {data:job}=await request('/jobs',{instruction:'Improve this paragraph.',blockIds:['p'],sessionId:session.id})
 await until(()=>notifications.some(n=>n.meta.job_id===job.id))
 const claim=await client.callTool({name:'claim_job',arguments:{jobId:job.id}})
 const snapshot=JSON.parse(claim.content[0].text).snapshot
 const block=snapshot.blocks[0]
 const proposalResult=await client.callTool({name:'propose_changes',arguments:{jobId:job.id,blockId:block.id,blockRevision:block.revision,before:block.text,after:'A clearer paragraph.',explanation:'More direct.'}})
 assert.notEqual(proposalResult.isError,true)
 const proposal=JSON.parse(proposalResult.content[0].text)
 assert.equal((await request('/state')).data.document.json.content[0].content[0].text,'A draft paragraph.','proposal must not change canonical text')
 const accepted=await request('/review',{id:proposal.id,decision:'accept'})
 assert.equal(accepted.data.document.json.content[0].content[0].text,'A clearer paragraph.')
 const reread=await client.callTool({name:'get_document_snapshot',arguments:{jobId:job.id}})
 assert.equal(JSON.parse(reread.content[0].text).blocks[0].text,'A draft paragraph.','job snapshots remain immutable after acceptance')
 const unauthorized=await fetch(connection.url+'/state')
 assert.equal(unauthorized.status,401)
 const crossOrigin=await fetch(connection.url+'/state',{headers:{Authorization:'Bearer '+connection.token,Origin:'https://untrusted.example'}})
 assert.equal(crossOrigin.status,403)
 const tools=await client.listTools()
 assert.equal(tools.tools.some(tool=>/accept|review/.test(tool.name)),false)
 await client.callTool({name:'report_job_status',arguments:{jobId:job.id,status:'completed',message:'Suggestion submitted'}})
 assert.equal((await request('/state')).data.jobs[0].status,'completed')
})
