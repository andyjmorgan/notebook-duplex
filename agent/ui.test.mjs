import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {JSDOM} from 'jsdom'
import {build} from 'esbuild'
import {startBroker,until} from './test-helpers.mjs'
test('editor renders, keeps stable IDs, accepts a suggestion, and supports undo',async t=>{
 const {connection,request}=await startBroker(t)
 const dom=new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>',{url:'http://127.0.0.1:5173',pretendToBeVisual:true})
 const keys=['window','document','navigator','HTMLElement','Element','Node','MutationObserver','DOMParser','getComputedStyle','requestAnimationFrame','cancelAnimationFrame']
 const previous=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]))
 for(const key of keys)Object.defineProperty(globalThis,key,{configurable:true,value:typeof dom.window[key]==='function'&&['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'].includes(key)?dom.window[key].bind(dom.window):dom.window[key]})
 dom.window.Range.prototype.getClientRects=()=>[]
 dom.window.Range.prototype.getBoundingClientRect=()=>({left:0,right:0,top:0,bottom:0,width:0,height:0})
 const originalFetch=globalThis.fetch
 globalThis.fetch=(url,options)=>url==='/connection'?Promise.resolve(new Response(JSON.stringify(connection),{headers:{'Content-Type':'application/json'}})):originalFetch(url,options)
 const timeoutIds=[]
 const originalTimeout=globalThis.setTimeout
 globalThis.setTimeout=(...args)=>{const id=originalTimeout(...args);timeoutIds.push(id);return id}
 const intervalIds=[]
 const originalInterval=globalThis.setInterval
 globalThis.setInterval=(...args)=>{const id=originalInterval(...args);intervalIds.push(id);return id}
 let editor
 t.after(async()=>{
  intervalIds.forEach(clearInterval)
  timeoutIds.forEach(clearTimeout)
  await new Promise(resolve=>originalTimeout(resolve,150))
  timeoutIds.forEach(clearTimeout)
  editor?.destroy()
  globalThis.setInterval=originalInterval;globalThis.setTimeout=originalTimeout;globalThis.fetch=originalFetch
  dom.window.close()
  for(const key of keys){const descriptor=previous.get(key);if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}
 })
 const source=await readFile(new URL('../src/main.ts',import.meta.url),'utf8')
 const bundled=await build({stdin:{contents:source+'\nexport { editor };',resolveDir:fileURLToPath(new URL('../src/',import.meta.url)),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',loader:{'.css':'empty'},logLevel:'silent'})
 const module=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'))
 editor=module.editor
 await until(()=>dom.window.document.getElementById('save-state').textContent==='Saved locally')
 assert.equal(editor.isEditable,true)
 assert.equal(dom.window.document.querySelectorAll('#toc button').length,3)
 const initial=(await request('/state')).data
 const paragraphs=initial.document.json.content.filter(node=>node.type==='paragraph')
 assert.equal(paragraphs.every(node=>Boolean(node.attrs.id)),true)
 assert.equal(new Set(paragraphs.map(node=>node.attrs.id)).size,paragraphs.length)
 dom.window.document.getElementById('demo').click()
 await until(()=>dom.window.document.querySelector('[data-decision="accept"]'))
 const before=editor.getText()
 dom.window.document.querySelector('[data-decision="accept"]').click()
 await until(()=>editor.getText().includes('This sentence is a local test suggestion.'))
 await until(()=>editor.isEditable)
 assert.equal(editor.commands.undo(),true)
 assert.equal(editor.getText(),before)
 const mode=dom.window.document.getElementById('mode')
 mode.value='viewing';mode.dispatchEvent(new dom.window.Event('change'))
 assert.equal(editor.isEditable,false)
 assert.equal(dom.window.document.querySelector('.toolbar').hidden,true)
 mode.value='editing';mode.dispatchEvent(new dom.window.Event('change'))
 assert.equal(editor.isEditable,true)
 editor.commands.insertContentAt(editor.state.doc.content.size,'<p>/table</p>')
 const last=editor.state.doc.lastChild
 const lastPos=editor.state.doc.content.size-last.nodeSize+1
 editor.commands.setTextSelection(lastPos+6)
 await until(()=>!dom.window.document.getElementById('slash-menu').hidden)
 dom.window.document.querySelector('[data-slash="table"]').click()
 assert.equal(editor.getJSON().content.filter(node=>node.type==='table').length,2)
 assert.match(editor.getMarkdown(),/\| Idea\s+\| Next step\s+\|/)
 await until(()=>dom.window.document.getElementById('save-state').textContent==='Saved locally')
})
