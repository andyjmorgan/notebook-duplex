import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises'
import { Store } from './store.mjs'
import { pathToFileURL } from 'node:url'
const runtime = process.env.MARGIN_RUNTIME_DIR ? pathToFileURL(process.env.MARGIN_RUNTIME_DIR.replace(/\/$/,'')+'/') : new URL('../.runtime/',import.meta.url)
await mkdir(runtime,{recursive:true,mode:0o700})
await chmod(runtime,0o700)
let state
try { state = JSON.parse(await readFile(new URL('state.json',runtime),'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
const store = new Store(state)
const token = randomBytes(32).toString('hex')
const sessions = new Map()
async function save() {
  const tmp = new URL('state.tmp',runtime)
  await writeFile(tmp,JSON.stringify(store.state),{mode:0o600})
  await rename(tmp,new URL('state.json',runtime))
}
function json(res,status,data) { res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'}); res.end(JSON.stringify(data)) }
const allowedOrigins = new Set(['http://127.0.0.1:5173','http://tauri.localhost','https://tauri.localhost','tauri://localhost'])
let sequence = Promise.resolve()
const server = createServer((req,res)=>{
  const origin=req.headers.origin
  if (origin && !allowedOrigins.has(origin)) { json(res,403,{error:'Origin not allowed'}); return }
  if (origin) res.setHeader('Access-Control-Allow-Origin',origin)
  res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type')
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS')
  if(req.method==='OPTIONS') { res.writeHead(204); res.end(); return }
  if (req.headers.authorization !== 'Bearer '+token) { json(res,401,{error:'Unauthorized'}); return }
  let body=''
  req.on('data',chunk=>{body+=chunk; if(body.length>2_000_000) req.destroy()})
  req.on('end',()=>{
    sequence = sequence.then(async()=>{
      try {
        const data=body ? JSON.parse(body) : {}
        const path=new URL(req.url,'http://localhost').pathname
        let result
        if(req.method==='GET' && path==='/state') result={...store.view(),sessions:[...sessions.values()].map(({secret,...s})=>({...s,connected:Date.now()-s.lastSeen<12000}))}
        else if(req.method==='POST' && path==='/sync') result=store.sync(data)
        else if(req.method==='POST' && path==='/session') {
          const id=data.id || randomUUID()
          const existing=sessions.get(id)
          if(existing && existing.secret!==data.secret) throw new Error('Invalid session secret')
          const session={id,secret:existing?.secret ?? randomBytes(24).toString('hex'),name:String(data.name ?? 'Claude').slice(0,120),repo:String(data.repo ?? '').slice(0,1000),lastSeen:Date.now()}
          sessions.set(id,session); result=session
        } else if(req.method==='POST' && path==='/jobs') {
          if(!sessions.has(data.sessionId) || Date.now()-sessions.get(data.sessionId).lastSeen>12000) throw new Error('Select a connected Claude session.')
          result=store.enqueue(data)
        } else if(req.method==='POST' && path==='/cancel') {store.cancel(data.id);result={ok:true}}
        else if(req.method==='POST' && path==='/review') result=store.review(data.id,data.decision)
        else if(req.method==='POST' && path==='/demo') {
          const block=store.snapshot().blocks.find(b=>b.id===data.blockId && b.plain && b.text)
          if(!block) throw new Error('Select a plain-text paragraph for the local test.')
          const job=store.enqueue({instruction:'Local approval test — no agent involved',blockIds:[block.id],sessionId:'local-test'})
          store.claim(job.id,'local-test')
          result=store.propose({jobId:job.id,blockId:block.id,blockRevision:block.revision,before:block.text,after:block.text+' This sentence is a local test suggestion.',explanation:'A fixture for testing accept, reject, and stale detection. No Claude request was sent.'},'local-test')
          store.status(job.id,'local-test','completed','Local fixture generated')
        } else if(req.method==='POST' && path.startsWith('/agent/')) {
          const session=sessions.get(data.sessionId)
          if(!session || session.secret!==data.sessionSecret) throw new Error('Invalid session')
          session.lastSeen=Date.now()
          if(path==='/agent/poll') result={jobs:store.state.jobs.filter(j=>j.sessionId===session.id && ['queued','delivered'].includes(j.status)).map(j=>({id:j.id,instruction:j.instruction,documentId:j.documentId,revision:j.snapshot.revision,blockIds:j.blockIds}))}
          else if(path==='/agent/claim') result=store.claim(data.jobId,session.id)
          else if(path==='/agent/propose') result=store.propose(data,session.id)
          else if(path==='/agent/status') result=store.status(data.jobId,session.id,data.status,data.message)
          else if(path==='/agent/snapshot') result= data.jobId ? store.job(data.jobId,session.id).snapshot : store.snapshot()
          else throw new Error('Unknown agent route')
        } else {json(res,404,{error:'Not found'});return}
        await save(); json(res,200,result)
      } catch(e) {json(res,400,{error:e.message})}
    }).catch(e=>{if(!res.writableEnded) json(res,500,{error:e.message})})
  })
})
server.listen(0,'127.0.0.1',async()=>{
  const url='http://127.0.0.1:'+server.address().port
  await writeFile(new URL('connection.json',runtime),JSON.stringify({url,token}),{mode:0o600})
  console.log('Notebook Duplex broker listening at '+url)
})
