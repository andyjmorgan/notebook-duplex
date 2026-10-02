import {spawn} from 'node:child_process'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../',import.meta.url))
const children=[]
let stopping=false
function stop(code=0){
 if(stopping)return
 stopping=true
 for(const child of children){try{process.platform==='win32'?child.kill():process.kill(-child.pid,'SIGTERM')}catch{}}
 setTimeout(()=>process.exit(code),200)
}
function run(command,args){
 const child=spawn(command,args,{cwd:root,stdio:'inherit',detached:process.platform!=='win32'})
 children.push(child)
 child.on('error',error=>{console.error(error.message);stop(1)})
 child.on('exit',code=>{if(!stopping)stop(code??0)})
 return child
}
process.on('SIGINT',()=>stop())
process.on('SIGTERM',()=>stop())
run(process.execPath,['agent/broker.mjs'])
let connected=false
for(let attempt=0;attempt<60&&!connected;attempt++){
 await new Promise(resolve=>setTimeout(resolve,100))
 try{const connection=JSON.parse(await readFile(new URL('../.runtime/connection.json',import.meta.url),'utf8'));const res=await fetch(connection.url+'/state',{headers:{Authorization:'Bearer '+connection.token}});connected=res.ok}catch{}
}
if(!connected){console.error('Broker did not start.');stop(1)}
else run(process.platform==='win32'?'npm.cmd':'npm',['run','desktop'])
