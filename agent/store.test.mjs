import test from 'node:test'
import assert from 'node:assert/strict'
import {Store} from './store.mjs'
const doc=()=>({type:'doc',content:[{type:'paragraph',attrs:{id:'a'},content:[{type:'text',text:'Original'}]},{type:'paragraph',attrs:{id:'b'},content:[{type:'text',text:'Other'}]}]})
function setup(){
 const store=new Store()
 store.sync({json:doc(),markdown:'Original\n\nOther',title:'Test',expectedRevision:0})
 const job=store.enqueue({instruction:'Improve paragraph',sessionId:'s',blockIds:['a']})
 store.claim(job.id,'s')
 const block=job.snapshot.blocks[0]
 const proposal=store.propose({jobId:job.id,blockId:'a',blockRevision:block.revision,before:'Original',after:'Improved',explanation:'Clearer'},'s')
 return {store,job,proposal}
}
test('accept preserves unrelated writing',()=>{
 const {store,proposal}=setup()
 const next=doc();next.content[1].content[0].text='User keeps typing'
 store.sync({json:next,expectedRevision:1})
 const result=store.review(proposal.id,'accept')
 assert.equal(result.document.json.content[0].content[0].text,'Improved')
 assert.equal(result.document.json.content[1].content[0].text,'User keeps typing')
})
test('changed target is stale and never overwritten',()=>{
 const {store,proposal}=setup()
 const next=doc();next.content[0].content[0].text='Writer rewrite'
 store.sync({json:next,expectedRevision:1})
 assert.equal(store.review(proposal.id,'accept').stale,true)
 assert.equal(store.snapshot().blocks[0].text,'Writer rewrite')
})
test('deleted target is stale',()=>{
 const {store,proposal}=setup();const next=doc();next.content.shift()
 store.sync({json:next,expectedRevision:1})
 assert.equal(store.review(proposal.id,'accept').stale,true)
})
test('scope and session ownership are enforced',()=>{
 const {store,job}=setup()
 assert.throws(()=>store.claim(job.id,'other'))
 const b=job.snapshot.blocks[1]
 assert.throws(()=>store.propose({jobId:job.id,blockId:b.id,blockRevision:b.revision,before:b.text,after:'Wrong'},'s'))
})
test('cancel invalidates proposals and late results',()=>{
 const {store,job,proposal}=setup();store.cancel(job.id)
 assert.throws(()=>store.review(proposal.id,'accept'))
 assert.throws(()=>store.propose({jobId:job.id},'s'))
 assert.equal(proposal.status,'cancelled')
})
test('reject leaves canonical text intact',()=>{
 const {store,proposal}=setup();store.review(proposal.id,'reject')
 assert.equal(store.snapshot().blocks[0].text,'Original')
})
test('duplicate acceptance cannot apply twice',()=>{
 const {store,proposal}=setup();store.review(proposal.id,'accept')
 assert.throws(()=>store.review(proposal.id,'accept'))
})
test('formatting change invalidates proposal even if text is unchanged',()=>{
 const {store,proposal}=setup();const next=doc();next.content[0].content[0].marks=[{type:'bold'}]
 store.sync({json:next,expectedRevision:1})
 assert.equal(store.review(proposal.id,'accept').stale,true)
})

test('changed proofreading targets supersede jobs and reject late proposals',()=>{
 const store=new Store()
 store.sync({json:doc(),expectedRevision:0})
 const job=store.enqueue({instruction:'Proofread',sessionId:'s',blockIds:['a'],kind:'proofread'})
 store.claim(job.id,'s')
 const next=doc();next.content[0].content[0].text='New draft'
 store.sync({json:next,expectedRevision:1})
 assert.equal(job.status,'superseded')
 const block=job.snapshot.blocks[0]
 assert.throws(()=>store.propose({jobId:job.id,blockId:block.id,blockRevision:block.revision,before:block.text,after:'Old result'},'s'))
})
test('job snapshots remain immutable through accepted edits',()=>{
 const {store,job,proposal}=setup()
 store.review(proposal.id,'accept')
 assert.equal(job.snapshot.blocks[0].text,'Original')
 assert.equal(job.snapshot.json.content[0].content[0].text,'Original')
})
