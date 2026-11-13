import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { parseSupervisorResponse } from '../server/supervisor-response.mjs'
import { createTopSupervisor } from '../server/top-supervisor.mjs'
export default async function(t){
 const response={message:'Read the issue',action:{type:'get_issue',project:'example.invalid-project',issueId:'test'}}
 const json=JSON.stringify(response)
 t.eq('plain JSON accepted',parseSupervisorResponse(json),response)
 t.eq('fenced JSON accepted',parseSupervisorResponse('```json\n'+json+'\n```'),response)
 t.eq('actual preamble shape accepted',parseSupervisorResponse('Five open issues, and my limits allow at most 3 runs (2 concurrent). Let me read the issues before choosing.\n\n'+json),response)
 const nested={message:'A brace } and escaped quote " inside text',action:{type:'preview',project:'p',issueId:'i',playbook:'b',runOptions:{budgets:{maxSteps:3}}}}
 t.eq('nested objects and escaped strings preserved',parseSupervisorResponse('Preface\n'+JSON.stringify(nested)),nested)
 for(const [label,input]of [
  ['two actions',json+'\n'+json],['array instead of envelope',JSON.stringify([response])],
  ['missing closing brace',json.slice(0,-1)],['malformed action','{"message":"x","action":[]}'],
  ['missing action','{"message":"x"}'],['unknown action','{"message":"x","action":{"type":"shell","project":"p"}}'],
  ['malformed competing object','{"message":"bad", "action": }\n'+json]
 ]){let refused=false;try{parseSupervisorResponse(input)}catch{refused=true}t.ok(label+' refused',refused)}
 // A landing by hand carries its evidence: what, where (commit or checkout), and what was changed beyond the patch.
 const landed={message:'Recording the operator\'s landing',action:{type:'mark_landed',project:'p',issueId:'i',runId:'r',applied:'the approved patch',handChanges:'none',commit:'abc1234'}}
 t.eq('mark_landed with a commit accepted',parseSupervisorResponse(JSON.stringify(landed)),landed)
 for(const [label,action]of [
  ['mark_landed without commit or checkout',{...landed.action,commit:undefined}],
  ['mark_landed without handChanges',{...landed.action,handChanges:undefined}],
  ['mark_landed with an unknown argument',{...landed.action,outcome:'resolved'}]
 ]){let refused=false;try{parseSupervisorResponse(JSON.stringify({message:'x',action}))}catch{refused=true}t.ok(label+' refused',refused)}
 const actual=JSON.parse(await fs.readFile(new URL('../../issues/.supervisor/state.json',import.meta.url),'utf8').catch(()=>'{"messages":[]}')).messages.findLast(m=>m.rawResponse?.startsWith('Five open issues, and my limits'))
 if(actual)t.eq('recorded live failure now parses',parseSupervisorResponse(actual.rawResponse).action.type,'get_issue')
 async function scenario(replies,maxCalls=5){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'supervisor-response-'));const calls=[],actions=[]
  // Hold asynchronous prompt preparation long enough for the observer to see
  // it: a dequeued repair is working, even before adapter.invoke is entered.
  const agent=await createTopSupervisor({dir,pollMs:1000,models:async()=>[{id:'test',model:'test',verification:{status:'verified'}}],adapter:{invoke:async a=>{calls.push(a);return{session:a.session??{id:'same-session'},response:replies.shift(),usage:{costUsd:0.01}}}},tools:{projects:async()=>{await new Promise(r=>setTimeout(r,30));return[{id:'p'}]},playbooks:async()=>[],listIssues:async()=>[],getIssue:async(p,id)=>{actions.push(id);return{id}}}})
  await agent.start({model:'test',projects:['p'],message:'Inspect issues',limits:{maxCalls,maxRuns:1,maxConcurrent:1,minutes:1}})
  const deadline=Date.now()+3000
  while(!['stopped','recovery-required'].includes(agent.get().status)&&!(agent.get().status==='active'&&!agent.get().queue.length)) {if(Date.now()>deadline)throw Error('timeout');await new Promise(r=>setTimeout(r,10))}
  const state=agent.get();await agent.shutdown();t.eq('shutdown drains the final state save', JSON.parse(await fs.readFile(path.join(dir,'state.json'),'utf8')).status,agent.get().status);await fs.rm(dir,{recursive:true,force:true});return{state,calls,actions}
 }
 const repaired=await scenario(['not JSON',JSON.stringify({message:'Now formatted',action:{type:'get_issue',project:'p',issueId:'i'}}),'{"message":"Done","action":null}'])
 t.eq('repair uses the same native session',repaired.calls[1].session.id,'same-session')
 t.eq('repair is explicitly requested',JSON.parse(repaired.calls[1].prompt).event.type,'protocol-repair')
 t.eq('action executes only once after valid repair',repaired.actions,['i'])
 t.eq('repair counts against model budget',repaired.state.calls,3)
 t.ok('invalid response retained with diagnosis',repaired.state.messages.some(m=>m.rawResponse==='not JSON'&&m.protocol?.valid===false))
 const exhausted=await scenario(['bad','still bad'])
 t.eq('repair bounded to one extra attempt',exhausted.calls.length,2)
 t.eq('invalid replies execute nothing',exhausted.actions,[])
 t.eq('exhaustion does not end the activation: it stays active for the next event, and Stop ends it',[exhausted.state.status,exhausted.state.ownFailures,/format repair exhausted/.test(exhausted.state.reason)],['active',1,true])
 t.ok('exhaustion explains why it stopped',exhausted.state.reason.includes('format repair exhausted'))
 const capped=await scenario(['bad'],1)
 t.eq('budget can prevent repair invocation',capped.calls.length,1)

 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'supervisor-preparation-stop-'))
 let agent,release,entered,invoked=0
 const preparing=new Promise(r=>{entered=r})
 const gate=new Promise(r=>{release=r})
 agent=await createTopSupervisor({dir,pollMs:1000,models:async()=>[{id:'test',model:'test',verification:{status:'verified'}}],
  adapter:{invoke:async()=>{invoked++;throw Error('must not invoke after Stop')}},
  tools:{projects:async()=>{if(agent?.get().status==='working'){entered();await gate}return[{id:'p'}]},playbooks:async()=>[],listIssues:async()=>[]}})
 try{
  await agent.start({model:'test',projects:['p'],message:'Inspect issues'})
  await preparing
  t.eq('prompt preparation is working with an empty queue', [agent.get().status,agent.get().queue.length], ['working',0])
  const stopping=agent.stop()
  release()
  await stopping
  t.eq('Stop during preparation never invokes the adapter',invoked,0)
  t.eq('no model call charged during preparation',agent.get().calls,0)
  t.eq('preparation stop completes without recovery',agent.get().status,'stopped')
 }finally{release();await agent.shutdown();await fs.rm(dir,{recursive:true,force:true})}
}
