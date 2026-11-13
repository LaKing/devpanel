import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { startStage } from './browser/stage.mjs'
export default async function(t){
 const stage=await startStage()
 const state=async()=>(await stage.request('/api/supervisor')).body
 const wait=async pred=>{const end=Date.now()+8000;while(!pred(await state())){if(Date.now()>end)throw Error('timeout');await new Promise(r=>setTimeout(r,20))}}
 const send=(url,body)=>stage.request('/api/supervisor/'+url,{method:'POST',body:JSON.stringify(body)})
 try{
 for(const [id,harness]of [['gpt-6-astra','codex'],['opus-5','claude']]){
 const file=path.join(stage.configRoot,'roster',id+'.yaml');const m=YAML.parse(await fs.readFile(file,'utf8'));m.harness=harness;m.verification.status='verified';await fs.writeFile(file,YAML.stringify(m))
 await fs.writeFile(path.join(stage.harnessDir,harness+'.mjs'),`let n=0;export async function invoke(a){if(a.harness!=='${harness}'||!a.supervisorOnly)throw Error('Wrong dispatch');return {session:a.session??{id:'${harness}-'+(++n)},response:JSON.stringify({message:'${harness} replies',action:null}),usage:{costUsd:null}}}`)
 }
 const models=(await stage.request('/api/supervisor/models')).body
 t.ok('GPT model selectable',models.some(m=>m.id==='gpt-6-astra'))
 const options={model:'gpt-6-astra',projects:[stage.project],message:'Coordinate issues',limits:{maxCalls:5,maxRuns:1,maxConcurrent:1}}
 t.eq('GPT supervisor starts',(await send('start',options)).status,201)
 await wait(s=>s.status==='active'&&s.calls===1)
 // Calls are a session allowance: every later Start resumes the count.
 t.eq('Codex discovered session captured',(await state()).session.id,'codex-1')
 await send('messages',{text:'Continue'})
 await wait(s=>s.status==='active'&&s.calls===2)
 t.eq('GPT chat resumes same session',(await state()).session.id,'codex-1')
 t.eq('unknown cost stays unknown',(await state()).unknownCostCalls,2)
 await send('stop',{});await wait(s=>s.status==='stopped')
 await send('start',{...options,model:'opus-5'})
 await wait(s=>s.status==='active'&&s.calls===3)
 t.eq('switch starts correct harness session',(await state()).session.id,'claude-1')
 t.ok('GPT history remains visible',(await state()).messages.some(m=>m.text==='codex replies'))
 t.eq('previous native session retained as history',(await state()).sessionHistory[0].session.id,'codex-1')
 await send('stop',{});await wait(s=>s.status==='stopped')
 await send('start',options);await wait(s=>s.status==='active'&&s.calls===4)
 t.eq('return to GPT creates a fresh native session',(await state()).session.id,'codex-2')
 t.ok('new native session receives shared recent conversation',JSON.parse((await stage.request('/api/supervisor/prompts/'+(await state()).messages.filter(m=>m.role==='assistant').at(-1).invocationId)).body.prompt).history.some(m=>m.text==='claude replies'))
 await send('stop',{});await wait(s=>s.status==='stopped')
 }finally{await stage.stop()}
}
