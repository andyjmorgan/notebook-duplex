import {spawn} from 'node:child_process'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
export async function until(predicate,timeout=7000){
 const started=Date.now()
 while(Date.now()-started<timeout){const result=await predicate();if(result)return result;await new Promise(r=>setTimeout(r,50))}
 throw new Error('Timed out waiting for expected state')
}
export async function startBroker(t){
 const runtime=await mkdtemp(join(tmpdir(),'margin-test-'))
 const script=fileURLToPath(new URL('./broker.mjs',import.meta.url))
 const child=spawn(process.execPath,[script],{env:{...process.env,MARGIN_RUNTIME_DIR:runtime},stdio:['ignore','pipe','pipe']})
 let error=''
 child.stderr.on('data',chunk=>error+=chunk)
 const connection=await until(async()=>{try{return JSON.parse(await readFile(join(runtime,'connection.json'),'utf8'))}catch{return false}}).catch(e=>{child.kill();throw new Error(e.message+' '+error)})
 const request=async(path,data)=>{
  const res=await fetch(connection.url+path,{method:data===undefined?'GET':'POST',headers:{Authorization:'Bearer '+connection.token,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)})
  return {ok:res.ok,status:res.status,data:await res.json()}
 }
 t.after(async()=>{child.kill();await until(()=>child.exitCode!==null||child.signalCode!==null);await rm(runtime,{recursive:true,force:true})})
 return {runtime,connection,request,child}
}
