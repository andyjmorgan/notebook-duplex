import {spawnSync,spawn} from 'node:child_process'
import {mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'

const root=fileURLToPath(new URL('../',import.meta.url))
const profile=join(root,'.personal-claude')
const bridge=join(root,'agent','bridge.mjs')
const cli=process.env.NOTEBOOK_DUPLEX_CLAUDE_BIN || 'claude'
const env={...process.env,CLAUDE_CONFIG_DIR:profile,MARGIN_SESSION_NAME:'Personal demo'}
for(const key of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','ANTHROPIC_PROFILE','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY']) delete env[key]
await mkdir(profile,{recursive:true,mode:0o700})
function run(args,stdio='inherit'){
 const result=spawnSync(cli,args,{cwd:root,env,stdio,encoding:'utf8'})
 if(result.error)throw result.error
 return result
}
try{
 const existing=run(['mcp','get','notebook-duplex'],'pipe')
 if(existing.status!==0){
  const added=run(['mcp','add','--transport','stdio','--scope','user','notebook-duplex','--',process.execPath,bridge])
  if(added.status!==0)process.exit(added.status??1)
 }else if(!existing.stdout.includes(bridge)){
  throw new Error('The personal profile has a different notebook-duplex bridge. Remove it with this profile selected before registering this checkout.')
 }
 console.log('Personal profile: '+profile)
 const args=process.argv.slice(2)
 if(args.includes('--register-only'))process.exit(0)
 if(args.includes('--login')){
  const login=run(['auth','login','--claudeai'])
  process.exit(login.status??1)
 }
 const child=spawn(cli,['--dangerously-load-development-channels','server:notebook-duplex',...args],{cwd:root,env,stdio:'inherit'})
 child.on('error',error=>{console.error(error.message);process.exitCode=1})
 child.on('exit',(code)=>{process.exitCode=code??1})
}catch(error){console.error(error.message);process.exitCode=1}
