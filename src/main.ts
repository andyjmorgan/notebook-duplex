import '@fontsource/noto-sans/latin-400.css'
import '@fontsource/noto-sans/latin-600.css'
import '@fontsource/roboto-mono/latin-400.css'
import './style.css'
import { Editor, Extension } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import UniqueID from '@tiptap/extension-unique-id'
import { Markdown } from '@tiptap/markdown'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { invoke } from '@tauri-apps/api/core'

type Block = { id:string; text:string; revision:string; plain:boolean }
type Proposal = {id:string;jobId:string;blockId:string;before:string;after:string;explanation:string;status:string;stale:boolean}
type Job = {id:string;instruction:string;status:string;message?:string;kind:string;sessionId:string}
type Session = {id:string;name:string;repo:string;connected:boolean}
type State = { document:{id:string;revision:number;json:any;title:string;markdown:string}; jobs:Job[]; proposals:Proposal[]; sessions:Session[] }
let connection:{url:string;token:string}|undefined
let state:State|undefined
let revision=0, ready=false, busy=false, dirty=false, syncing=false
let scopeId:string|undefined
let pendingSync:ReturnType<typeof setTimeout>|undefined
let syncChain:Promise<void>=Promise.resolve()
let lastEdit=0
const proofreadRevisions=new Map<string,string>()
let proofreadEnabled=false
let mode='editing'
let slashIndex=0
const app=document.querySelector<HTMLDivElement>('#app')!
app.innerHTML=`
<header class="appbar"><div class="brand"><span class="logo">m</span><span>Notebook Duplex <small>LOCAL NOTEBOOK</small></span></div><div class="connection"><span id="dot" class="dot"></span><span id="connection-label">Connecting to editor broker</span></div><div class="header-actions"><select id="mode" aria-label="Notebook mode"><option value="editing">Editing</option><option value="viewing">Viewing</option></select><button id="export" class="quiet">Export Markdown ↗</button></div></header>
<div class="workspace">
<nav class="outline" aria-label="Table of contents"><div class="outline-title">Contents</div><div id="toc"></div><div class="outline-note">Local document<br/>Changes save as you type.</div></nav>
<main class="writing"><div class="notebook-labels"><button id="favorite" aria-label="Favorite notebook" aria-pressed="false">☆ Favorite</button><span>▤ Documentation</span><span class="local-tag">Local</span></div><div class="document-heading"><input id="title" aria-label="Document title" value="Working notes"/></div><div class="document-meta"><span class="avatar">AM</span><span>You</span><span class="meta-divider"></span><span id="save-state">Starting…</span></div>
<nav class="toolbar" aria-label="Formatting toolbar">
<button data-action="bold" title="Bold">B</button><button data-action="italic" title="Italic"><i>I</i></button><span class="divider"></span>
<button data-action="h1">H1</button><button data-action="h2">H2</button><button data-action="h3">H3</button><button data-action="paragraph">Normal text</button><span class="divider"></span>
<button data-action="bullet">• List</button><button data-action="ordered">1. List</button><button data-action="quote">Quote</button><button data-action="code">Code</button><span class="divider"></span>
<button data-action="table">＋ Table</button><button data-action="undo">↶</button><button data-action="redo">↷</button>
</nav>
<nav id="table-tools" class="table-tools" aria-label="Table management" hidden><span>Table</span><button data-action="row">＋ Row</button><button data-action="column">＋ Column</button><button data-action="deleteRow">− Row</button><button data-action="deleteColumn">− Column</button><button data-action="header">Header row</button><button data-action="deleteTable">Remove table</button></nav>
<div id="editor" class="page"></div>
<footer class="document-footer"><span id="word-count">0 words</span><span>Type <kbd>/agent</kbd> then Space · your changes stay yours</span><button id="import" class="quiet">Import .md</button><input id="file" type="file" accept=".md,.markdown,text/markdown,text/plain" hidden/></footer>
</main>
<aside class="collaborator"><div class="aside-heading"><span class="eyebrow">COLLABORATION</span><h2>Agent suggestions</h2><p>Claude works in your repo. You decide what changes.</p></div>
<label class="field-label" for="session">Claude session</label><select id="session"><option value="">No session connected</option></select><p id="repo" class="repo">Launch Claude in your repo using the bridge.</p>
<div class="agent-actions"><button id="agent" class="primary">＋ Ask agent</button><button id="directive" class="quiet">Run [tk: …]</button></div>
<label class="proofreading"><input id="proofread" type="checkbox"/> Proofread settled paragraphs <span class="beta">EXPERIMENTAL</span></label>
<div class="section-label"><span>Suggestions</span><span id="suggestion-count">0</span></div><div id="suggestions" class="suggestions"></div>
<div class="section-label"><span>Work in progress</span><span id="job-count">0</span></div><div id="jobs"></div>
<details class="setup"><summary>Connect your Claude session</summary><p>Start the broker, register the bridge in your repo, then launch Claude with the custom channel enabled. The README has the exact commands.</p><p>Session tools propose text; only this editor accepts it. Initial Claude trust and server approval stay in the terminal.</p></details>
<button id="demo" class="test-button">Try a local test suggestion</button><p class="test-caption">No agent request. Tests approval on the selected plain-text paragraph.</p>
</aside>
</div>
<div id="slash-menu" role="listbox" aria-label="Insert content" hidden></div>
<div id="toast" role="status" aria-live="polite"></div>
<dialog id="command-dialog"><form id="command-form"><span class="eyebrow">ASK YOUR AGENT</span><h2>A thought to work on</h2><p id="scope-label"></p><textarea id="instruction" rows="4" placeholder="Find evidence for this claim, or suggest a clearer version…" required></textarea><label class="scope-check"><input id="whole-document" type="checkbox"/> Give the agent the whole document as its edit scope</label><div class="dialog-actions"><button type="button" id="dismiss" class="quiet">Cancel</button><button type="submit" class="primary">Send command →</button></div></form></dialog>
`
const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T
function escape(text:string){return text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))}
function notify(message:string){$('toast').textContent=message;$('toast').classList.add('visible');setTimeout(()=>$('toast').classList.remove('visible'),5500)}
const proposalKey=new PluginKey('margin-proposals')
const suggestionDecorations=Extension.create({
 name:'marginSuggestions',
 addProseMirrorPlugins(){return [new Plugin({key:proposalKey,props:{decorations(editorState){
  const pending=(state?.proposals??[]).filter(p=>p.status==='pending'&&!p.stale)
  const ids=new Set(pending.map(p=>p.blockId))
  const decorations:Decoration[]=[]
  editorState.doc.descendants((node,pos)=>{if(ids.has(node.attrs.id))decorations.push(Decoration.node(pos,pos+node.nodeSize,{class:'has-suggestion'}))})
  return DecorationSet.create(editorState.doc,decorations)
 }}})]},
})
const initialMarkdown=`Write with your local Claude session.

This is your document. You can keep writing while Claude researches a claim or suggests a clearer paragraph. Nothing changes until you accept it.

## Try the collaboration

Select this paragraph and choose **Ask agent**, or type /agent on an empty line and press Space.

Use the local test suggestion to try the approval flow without connecting Claude. Rewrite its target paragraph before accepting to see stale protection.

## A simple table

| Idea | Next step |
| --- | --- |
| Write freely | Let the agent work in the background |
| Review deliberately | Accept only what helps |

## A note to return to

[tk: Find a primary source about local-first software.]
`
const editor=new Editor({
 element:$('editor'),
 extensions:[StarterKit,TableKit.configure({table:{resizable:false}}),UniqueID.configure({types:['paragraph','heading','table','tableRow','tableCell','tableHeader','listItem']}),Markdown,suggestionDecorations],
 content:initialMarkdown,contentType:'markdown',
 editorProps:{
  attributes:{'aria-label':'Markdown document',spellcheck:'true'},
  handleKeyDown(view,event){
   if (!$('slash-menu').hidden && ['ArrowDown','ArrowUp','Enter','Tab','Escape'].includes(event.key)) {
    event.preventDefault()
    if(event.key==='Escape') $('slash-menu').hidden=true
    else if(event.key==='ArrowDown'||event.key==='ArrowUp'){const choices=slashChoices();slashIndex=(slashIndex+(event.key==='ArrowDown'?1:-1)+choices.length)%choices.length;updateSlashMenu()}
    else executeSlash(slashChoices()[slashIndex]?.command)
    return true
   }
   if(event.key===' '&&view.state.selection.$from.parent.textContent==='/agent'){
    event.preventDefault()
    const from=view.state.selection.$from.start()
    view.dispatch(view.state.tr.delete(from,from+6))
    openCommand();return true
   }
   return false
  },
 },
 onUpdate(){if(!ready)return;dirty=true;lastEdit=Date.now();queueSync();refreshFormatting();updateSlashMenu()},
 onSelectionUpdate(){refreshFormatting();if(ready)updateSlashMenu()},
})
function currentBlockId(){
 const sel=editor.state.selection.$from
 for(let depth=sel.depth;depth>=0;depth--){const node=sel.node(depth);if(['paragraph','heading'].includes(node.type.name)&&node.attrs.id)return node.attrs.id as string}
 let result:string|undefined
 editor.state.doc.descendants(node=>{if(!result&&node.type.name==='paragraph'&&node.textContent&&node.attrs.id)result=node.attrs.id})
 return result
}
function refreshFormatting(){
 $('table-tools').hidden=mode!=='editing'||!editor.isActive('table')
 const words=editor.getText().trim().split(/\s+/).filter(Boolean).length
 $('word-count').textContent=words+' words'
 renderOutline()
 document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button=>{
  const action=button.dataset.action
  const active=action==='h1'?editor.isActive('heading',{level:1}):action==='h2'?editor.isActive('heading',{level:2}):action==='bold'?editor.isActive('bold'):action==='italic'?editor.isActive('italic'):false
  button.classList.toggle('active',active)
 })
}
async function api(path:string,data?:unknown){
 if(!connection)throw new Error('Start the broker with npm run broker.')
 const response=await fetch(connection.url+path,{method:data===undefined?'GET':'POST',headers:{Authorization:'Bearer '+connection.token,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)})
 const result=await response.json()
 if(!response.ok)throw new Error(result.error??'Request failed')
 return result
}
function sync(){
 syncChain=syncChain.then(async()=>{
  syncing=true
  try{
   const json=editor.getJSON()
   const saved=await api('/sync',{json,markdown:editor.getMarkdown(),title:$<HTMLInputElement>('title').value,expectedRevision:revision})
   revision=saved.revision
   dirty=JSON.stringify(json)!==JSON.stringify(editor.getJSON())
   $('save-state').textContent=dirty?'Saving…':'Saved locally'
  }finally{syncing=false}
 }).catch(error=>{dirty=true;$('save-state').textContent='Unsaved — broker unavailable';notify(error.message)})
 return syncChain
}
function queueSync(){clearTimeout(pendingSync);$('save-state').textContent='Saving…';pendingSync=setTimeout(()=>void sync(),400)}
async function flush(){clearTimeout(pendingSync);await sync();if(dirty)throw new Error('Document has not been saved. Try again after the broker reconnects.')}
function selectedSession(){return $<HTMLSelectElement>('session').value}
function openCommand(instruction=''){
 if(!ready){notify('Start the local broker first.');return}
 scopeId=currentBlockId()
 $('scope-label').textContent=scopeId?'The agent will suggest changes to your selected paragraph.':'The agent will work with the document.'
 $<HTMLTextAreaElement>('instruction').value=instruction
 $<HTMLInputElement>('whole-document').checked=!scopeId
 $<HTMLDialogElement>('command-dialog').showModal()
 $<HTMLTextAreaElement>('instruction').focus()
}
$('agent').onclick=()=>openCommand()
$('dismiss').onclick=()=>$<HTMLDialogElement>('command-dialog').close()
$('directive').onclick=()=>{
 const id=currentBlockId();let text=''
 editor.state.doc.descendants(node=>{if(node.attrs.id===id)text=node.textContent})
 const directive=text.match(/^\[tk:\s*([\s\S]+?)\]$/)
 if(!directive){notify('Select a paragraph containing [tk: your command].');return}
 openCommand(directive[1])
}
$('command-form').onsubmit=async(event)=>{
 event.preventDefault()
 try{
  await flush()
  await api('/jobs',{instruction:$<HTMLTextAreaElement>('instruction').value,blockIds:$<HTMLInputElement>('whole-document').checked?[]:scopeId?[scopeId]:[],sessionId:selectedSession()})
  $<HTMLDialogElement>('command-dialog').close();notify('Command queued. You can keep writing.');await poll()
 }catch(error){notify((error as Error).message)}
}
$('title').oninput=()=>{dirty=true;queueSync()}
$('demo').onclick=async()=>{
 try{await flush();await api('/demo',{blockId:currentBlockId()});await poll();notify('Local test suggestion ready. No agent was called.')}
 catch(error){notify((error as Error).message)}
}
$('proofread').onchange=()=>{
 proofreadEnabled=$<HTMLInputElement>('proofread').checked
 proofreadRevisions.clear()
 notify(proofreadEnabled?'Proofreading enabled for settled plain-text paragraphs.':'Proofreading paused.')
}
async function review(id:string,decision:string){
 if(busy)return
 if(mode!=='editing'){notify('Switch to Editing to review changes.');return}
 busy=true;editor.setEditable(false)
 try{
  await flush()
  const result=await api('/review',{id,decision})
  if(result.stale)notify('This paragraph changed. The suggestion is stale and was not applied.')
  else if(result.document){
   const proposal=result.proposal as Proposal
   let target:{pos:number;size:number}|undefined
   editor.state.doc.descendants((node,pos)=>{if(node.attrs.id===proposal.blockId)target={pos,size:node.nodeSize}})
   if(!target)throw new Error('Target disappeared. Reload the document.')
   const {pos,size}=target as {pos:number;size:number}
   revision=result.document.revision
   const tr=editor.state.tr.replaceWith(pos+1,pos+size-1,proposal.after?editor.schema.text(proposal.after):[])
   editor.view.dispatch(tr)
   await sync()
   notify('Suggestion accepted. Undo is available.')
  } else notify('Suggestion rejected.')
  await poll()
 }catch(error){notify((error as Error).message)}
 finally{busy=false;editor.setEditable(mode==='editing')}
}
let lastPanels=''
function render(){
 if(!state)return
 const select=$<HTMLSelectElement>('session')
 const selected=select.value
 const sessions=state.sessions.filter(s=>s.connected)
 const optionSignature=JSON.stringify(sessions.map(s=>[s.id,s.name,s.repo]))
 if(select.dataset.signature!==optionSignature){
  select.dataset.signature=optionSignature
  select.innerHTML='<option value="">Choose a Claude session</option>'+sessions.map(s=>'<option value="'+escape(s.id)+'">'+escape(s.name)+'</option>').join('')
  if(sessions.some(s=>s.id===selected))select.value=selected
  else if(sessions.length===1)select.value=sessions[0].id
 }
 const session=sessions.find(s=>s.id===select.value)
 $('repo').textContent=session?.repo??'Launch Claude in your repo using the bridge.'
 $('connection-label').textContent=session?'Claude · '+session.name:'Editor ready · no Claude connected'
 $('dot').classList.toggle('connected',Boolean(session))
 const signature=JSON.stringify([state.jobs,state.proposals])
 if(signature===lastPanels)return
 lastPanels=signature
 const proposals=state.proposals.filter(p=>p.status==='pending'||p.status==='stale')
 $('suggestion-count').textContent=String(proposals.length)
 $('suggestions').innerHTML=proposals.length?proposals.map(p=>`<article class="suggestion ${p.stale||p.status==='stale'?'stale':''}"><div class="suggestion-label">${p.stale||p.status==='stale'?'TARGET CHANGED':'PROPOSED CHANGE'}</div><div class="diff"><div class="before">${escape(p.before||'(empty paragraph)')}</div><div class="after">${escape(p.after||'(remove text)')}</div></div><p>${escape(p.explanation)}</p><div class="review-actions">${p.status==='pending'?`<button class="accept" data-review="${p.id}" data-decision="accept" ${p.stale?'disabled':''}>Accept</button><button class="quiet" data-review="${p.id}" data-decision="reject">Reject</button>`:'<span>Stale — ask for a new suggestion</span>'}<button class="quiet jump" data-jump="${p.blockId}">↗ Locate</button></div></article>`).join(''):'<div class="empty-state"><span>✦</span><p>No suggestions yet.</p><small>Your words stay untouched until you approve a change.</small></div>'
 const jobs=[...state.jobs].reverse().slice(0,12)
 $('job-count').textContent=String(state.jobs.filter(j=>['queued','running','needs_permission'].includes(j.status)).length)
 $('jobs').innerHTML=jobs.map(j=>`<article class="job"><div><span class="job-status ${escape(j.status)}">${escape(j.status.replaceAll('_',' '))}</span>${j.kind==='proofread'?'<span class="proofread-tag">proofread</span>':''}</div><p>${escape(j.instruction)}</p>${j.message?`<small>${escape(j.message)}</small>`:''}${['queued','running','needs_permission'].includes(j.status)?`<button class="quiet cancel" data-cancel="${j.id}">Cancel</button>`:''}</article>`).join('')||'<p class="no-jobs">Nothing waiting. Space to write.</p>'
 editor.view.dispatch(editor.state.tr.setMeta(proposalKey,true))
 document.querySelectorAll<HTMLButtonElement>('[data-review]').forEach(button=>button.onclick=()=>void review(button.dataset.review!,button.dataset.decision!))
 document.querySelectorAll<HTMLButtonElement>('[data-cancel]').forEach(button=>button.onclick=async()=>{await api('/cancel',{id:button.dataset.cancel});await poll()})
 document.querySelectorAll<HTMLButtonElement>('[data-jump]').forEach(button=>button.onclick=()=>{
  editor.state.doc.descendants((node,pos)=>{if(node.attrs.id===button.dataset.jump){editor.commands.setTextSelection(pos+1);editor.commands.scrollIntoView();editor.commands.focus()}})
 })
}
$('session').onchange=()=>render()
let polling=false
async function poll(){
 if(!ready||polling)return
 polling=true
 try{state=await api('/state');render()}catch{ $('connection-label').textContent='Broker disconnected · writing is unsaved';$('dot').classList.remove('connected');try{connection=(window as any).__TAURI_INTERNALS__?await invoke('broker_connection'):await fetch('/connection').then(r=>r.json());if(dirty)await sync()}catch{} }
 finally{polling=false}
}
async function maybeProofread(){
 if(!ready||!proofreadEnabled||busy||dirty||syncing||Date.now()-lastEdit<2200||!selectedSession())return
 try{
  const json=editor.getJSON()
  const blocks: {id:string;text:string}[]=[]
  function walk(node:any){if(node.type==='paragraph'&&node.attrs?.id&&(node.content??[]).every((n:any)=>n.type==='text'&&!n.marks?.length)){const text=(node.content??[]).map((n:any)=>n.text??'').join('');if(text.trim().length>20&&!text.startsWith('[tk:'))blocks.push({id:node.attrs.id,text})}for(const child of node.content??[])walk(child)}
  walk(json)
  const block=blocks.find(b=>proofreadRevisions.get(b.id)!==b.text&&!state?.jobs.some(j=>j.kind==='proofread'&&['queued','running'].includes(j.status)))
  if(!block)return
  await api('/jobs',{instruction:'Proofread the selected paragraph for spelling, grammar, and clarity. Return a proposal only if a change helps; otherwise report completion. Preserve the writer’s meaning.',blockIds:[block.id],sessionId:selectedSession(),kind:'proofread'})
  proofreadRevisions.set(block.id,block.text)
 }catch{/* Connection state is shown by polling. */}
}
document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button=>{
 button.onmousedown=event=>event.preventDefault()
 button.onclick=()=>{
  if(!ready||busy||mode!=='editing')return
  const chain=editor.chain().focus()
  switch(button.dataset.action){
   case'bold':chain.toggleBold().run();break
   case'italic':chain.toggleItalic().run();break
   case'h1':chain.toggleHeading({level:1}).run();break
   case'h2':chain.toggleHeading({level:2}).run();break
   case'h3':chain.toggleHeading({level:3}).run();break
   case'paragraph':chain.setParagraph().run();break
   case'bullet':chain.toggleBulletList().run();break
   case'ordered':chain.toggleOrderedList().run();break
   case'quote':chain.toggleBlockquote().run();break
   case'code':chain.toggleCodeBlock().run();break
   case'table':chain.insertTable({rows:3,cols:2,withHeaderRow:true}).run();break
   case'row':chain.addRowAfter().run();break
   case'column':chain.addColumnAfter().run();break
   case'deleteRow':chain.deleteRow().run();break
   case'deleteColumn':chain.deleteColumn().run();break
   case'header':chain.toggleHeaderRow().run();break
   case'deleteTable':chain.deleteTable().run();break
   case'undo':chain.undo().run();break
   case'redo':chain.redo().run();break
  }
  refreshFormatting()
 }
})
$('export').onclick=()=>{
 const blob=new Blob([editor.getMarkdown()],{type:'text/markdown;charset=utf-8'})
 const url=URL.createObjectURL(blob),link=document.createElement('a')
 link.href=url;link.download=($<HTMLInputElement>('title').value||'document').replace(/[^a-z0-9 _-]/gi,'')+'.md'
 link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
}
$('import').onclick=()=>{if(mode!=='editing'){notify('Switch to Editing before importing.');return}$<HTMLInputElement>('file').click()}
$('file').onchange=async()=>{
 const file=$<HTMLInputElement>('file').files?.[0]
 if(!file)return
 if(!confirm('Replace the current document? This prototype supports basic Markdown and GFM tables. Obsidian extensions and rich HTML may not round-trip. Export your current document first.'))return
 try{
  const markdown=await file.text()
  editor.commands.setContent(markdown,{contentType:'markdown'})
  $<HTMLInputElement>('title').value=file.name.replace(/\.(md|markdown)$/i,'')
  dirty=true;await flush();notify('Markdown imported. Check its formatting before exporting.')
 }catch(error){notify((error as Error).message)}
 $<HTMLInputElement>('file').value=''
}

const slashCommands=[
 {command:'agent',icon:'✦',label:'Ask agent',description:'Send a task to your Claude session'},
 {command:'table',icon:'▦',label:'Table',description:'Insert a text table'},
 {command:'h1',icon:'H₁',label:'Heading 1',description:'Large section heading'},
 {command:'h2',icon:'H₂',label:'Heading 2',description:'Section heading'},
 {command:'h3',icon:'H₃',label:'Heading 3',description:'Small section heading'},
 {command:'quote',icon:'❞',label:'Block quote',description:'Set a quote apart'},
 {command:'code',icon:'⌘',label:'Code block',description:'Insert formatted code'},
]
function slashChoices(){
 const text=editor.state.selection.$from.parent.textContent
 return slashCommands.filter(item=>item.command.includes(text.slice(1).toLowerCase()))
}
function updateSlashMenu(){
 const menu=$('slash-menu')
 const selection=editor.state.selection
 const text=selection.$from.parent.textContent
 if(mode!=='editing'||!selection.empty||selection.$from.parent.type.name!=='paragraph'||!/^\/[a-z0-9]*$/.test(text)){menu.hidden=true;return}
 const choices=slashChoices()
 if(!choices.length){menu.hidden=true;return}
 slashIndex=Math.min(slashIndex,choices.length-1)
 const coords=editor.view.coordsAtPos(selection.from)
 menu.hidden=false
 menu.style.left=Math.min(coords.left,window.innerWidth-360)+'px'
 menu.style.top=Math.min(coords.bottom+8,window.innerHeight-360)+'px'
 menu.innerHTML='<div class="slash-heading">Insert content</div>'+choices.map((item,index)=>'<button role="option" aria-selected="'+(index===slashIndex)+'" data-slash="'+item.command+'" class="'+(index===slashIndex?'selected':'')+'"><span class="slash-icon">'+item.icon+'</span><span>'+item.label+'<small>'+item.description+'</small></span><kbd>/'+item.command+'</kbd></button>').join('')+'<div class="slash-footer"><kbd>↑ ↓</kbd> navigate <kbd>Enter</kbd> select <kbd>Esc</kbd> close</div>'
 menu.querySelectorAll<HTMLButtonElement>('[data-slash]').forEach(button=>{button.onmousedown=e=>e.preventDefault();button.onclick=()=>executeSlash(button.dataset.slash)})
}
function executeSlash(command?:string){
 if(!command)return
 const selection=editor.state.selection
 const from=selection.$from.start()
 editor.view.dispatch(editor.state.tr.delete(from,from+selection.$from.parent.content.size))
 $('slash-menu').hidden=true;slashIndex=0
 if(command==='agent'){openCommand();return}
 const chain=editor.chain().focus()
 if(command==='table')chain.insertTable({rows:3,cols:2,withHeaderRow:true}).run()
 else if(command==='h1'||command==='h2'||command==='h3')chain.setHeading({level:Number(command[1]) as 1|2|3}).run()
 else if(command==='quote')chain.toggleBlockquote().run()
 else if(command==='code')chain.toggleCodeBlock().run()
}
let outlineSignature=''
function renderOutline(){
 const headings:{id:string;text:string;level:number;pos:number}[]=[]
 editor.state.doc.descendants((node,pos)=>{if(node.type.name==='heading')headings.push({id:node.attrs.id,text:node.textContent||'Untitled section',level:node.attrs.level,pos})})
 const signature=JSON.stringify(headings)
 if(signature===outlineSignature)return
 outlineSignature=signature
 $('toc').innerHTML=headings.length?headings.map(h=>'<button data-position="'+h.pos+'" style="padding-left:'+((h.level-1)*12+12)+'px">'+escape(h.text)+'</button>').join(''):'<p>Add headings to build an outline.</p>'
 $('toc').querySelectorAll<HTMLButtonElement>('button').forEach(button=>button.onclick=()=>{
  editor.commands.setTextSelection(Number(button.dataset.position)+1);editor.commands.scrollIntoView()
  if(mode==='editing')editor.commands.focus()
 })
}
$('favorite').onclick=()=>{
 const active=$('favorite').getAttribute('aria-pressed')!=='true'
 $('favorite').setAttribute('aria-pressed',String(active));$('favorite').textContent=active?'★ Favorited':'☆ Favorite'
}
$('mode').onchange=()=>{
 mode=$<HTMLSelectElement>('mode').value
 $<HTMLInputElement>('title').readOnly=mode==='viewing'
 editor.setEditable(ready&&mode==='editing')
 document.querySelector<HTMLElement>('.toolbar')!.hidden=mode==='viewing'
 if(mode==='viewing')$('table-tools').hidden=true
 else refreshFormatting()
}

async function connect(){
 try{
  connection=(window as any).__TAURI_INTERNALS__?await invoke('broker_connection'):await fetch('/connection').then(async r=>{if(!r.ok)throw new Error('Start npm run broker in a terminal.');return r.json()})
  state=await api('/state');revision=state!.document.revision
  if(state!.document.json)editor.commands.setContent(state!.document.json,{emitUpdate:false})
  if(state!.document.title)$<HTMLInputElement>('title').value=state!.document.title==='Untitled'?'Working notes':state!.document.title
  ready=true;dirty=true;await flush();editor.setEditable(mode==='editing');render();refreshFormatting()
 }catch(error){$('connection-label').textContent=(error as Error).message;$('save-state').textContent='Broker required';setTimeout(()=>void connect(),3000)}
}
editor.setEditable(false)
void connect()
setInterval(()=>void poll(),900)
setInterval(()=>void maybeProofread(),2500)
refreshFormatting()
