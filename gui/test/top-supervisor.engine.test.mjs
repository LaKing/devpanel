import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { startStage } from './browser/stage.mjs'
export default async function(t){
 const stage=await startStage({control:{script:{fitVerdict:false}}})
 try{
 const base=YAML.parse(await fs.readFile(path.join(stage.configRoot,'roster/opus-5.yaml'),'utf8'))
 await fs.writeFile(path.join(stage.configRoot,'roster/supervisor-test.yaml'),YAML.stringify({...base,id:'supervisor-test',harness:'claude',verification:{...base.verification,status:'verified'}}))
 await fs.writeFile(path.join(stage.harnessDir,'claude.mjs'),`let turn=0;export async function invoke(args){
 const p=JSON.parse(args.prompt),e=p.event;let action=null;const project=p.focus[0]??p.projects[0].id;
 switch(++turn){
 case 1:action={type:'list_issues',project};break;
 case 2:action={type:'get_issue',project,issueId:e.result.issues[0].id};break;
 case 3:action={type:'preview',project,issueId:e.result.issue.id,playbook:'implementation'};break;
 case 4:action={type:'start_run',project,issueId:e.action.issueId,previewId:e.result.previewId};break;
 }
 return {session:args.session??{id:'supervisor-engine-session'},response:JSON.stringify({message:'Coordinating turn '+turn,action}),usage:{costUsd:0}}
 }`)
 const created=await stage.request('/api/projects/'+stage.project+'/issues',{method:'POST',body:JSON.stringify({input:'# Supervisor integration\n\nRead this audit evidence.'})})
 const result=await stage.request('/api/supervisor/start',{method:'POST',body:JSON.stringify({model:'supervisor-test',projects:[stage.project],message:'Handle this issue',limits:{maxCalls:12,maxRuns:1,maxConcurrent:1}})})
 t.eq('top-level activation accepted',result.status,201)
 const scoped=await stage.request('/api/supervisor/campaign',{method:'POST',body:JSON.stringify({campaign:{leaveReporters:['reporter-a']}})})
 t.eq('the campaign route sets the scope while it runs',[scoped.status,scoped.body.campaign?.leaveReporters],[200,['reporter-a']])
 let state
 const end=Date.now()+20000
 do{state=(await stage.request('/api/supervisor')).body;if(state.ownedRuns[0]?.status==='completed'&&state.status==='active'&&state.messages.some(m=>m.prompt?.includes('run-changed')))break;await new Promise(r=>setTimeout(r,50))}while(Date.now()<end)
 t.eq('supervisor launched an actual engine run',state.ownedRuns.length,1)
 t.eq('run reached completion',state.ownedRuns[0]?.status,'completed')
 t.ok('original report reaches supervisor',state.messages.some(m=>m.role==='tool'&&m.action.type==='get_issue'&&m.text.includes('Read this audit evidence.')))
 const run=await stage.run(created.body.id,state.ownedRuns[0].runId)
 t.eq('engine persists the durable launch reservation identifier',run.supervisorLaunchId,state.launches[0].id)
 t.eq('issue engine performed triage',run.timeline[0]?.stepId,'triage')
 t.eq('supervisor observed actual rejected result',run.result,'rejected')
 t.ok('completion delivered back to persistent agent',state.messages.some(m=>m.prompt?.includes('run-changed')&&m.prompt.includes('triage-rejected')))
 await stage.request('/api/supervisor/stop',{method:'POST',body:'{}'})
 }finally{await stage.stop()}
}
