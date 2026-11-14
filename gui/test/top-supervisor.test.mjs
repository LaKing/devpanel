import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTopSupervisor } from '../server/top-supervisor.mjs'
const wait=async test=>{const end=Date.now()+4000;while(!test()){if(Date.now()>end)throw Error('Timed out');await new Promise(r=>setTimeout(r,10))}}
export default async function(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devpanel-supervisor-test-'))
 const invocations=[], starts=[], stopped=[];let script=[], modelGate=null
 const runs=new Map()
 const models=async()=>[{id:'test-model',title:'Test model',model:'wire-model',defaultEffort:'high',verification:{status:'verified'}}]
 const adapter={invoke:async args=>{
  invocations.push(args)
  if(modelGate)await new Promise((resolve,reject)=>{modelGate=resolve;args.signal.addEventListener('abort',()=>reject(Object.assign(Error('cancelled'),{name:'AbortError',termination:{confirmedAt:Date.now()}})),{once:true})})
  const event=JSON.parse(args.prompt).event
  const action=script.shift()?.(event)??null
  return {session:args.session??{id:'persistent-session'},response:JSON.stringify({message:'Supervisor reply',action}),usage:{costUsd:0.01}}
 }}
 const tools={projects:async()=>[{id:'one-project'}],playbooks:async()=>[],
  infrastructure:async()=>({staging:{id:'configured-stage'},orientation:'Use the configured candidate test drive'}),
  // Which models the run SEATS may be filled with. A playbook listing shows
  // only its defaults, and a supervisor reading that as the whole menu refuses
  // work it could do.
  seatModels:async()=>[{id:'seat-model-a',title:'Provider A (via Claude Code)',harness:'claude',profile:'a',efforts:null,verified:true,performance:{status:'ok',stale:false,startupMs:50,responseMs:200,totalMs:400,measuredAt:'2026-09-16T00:00:00Z'}},
                       {id:'seat-model-b',title:'Provider B',harness:'codex',profile:'default',efforts:['low','high'],verified:false}],
  listIssues:async()=>[{id:'issue'}],getIssue:async()=>({name:'issue'}),
  preview:async()=>({ok:true,configHash:'snapshot-hash'}),
  start:async p=>{starts.push(p);const r={runId:'r'+starts.length,status:'running'};runs.set(r.runId,r);return r},
  getRun:async(_p,_i,id)=>runs.get(id),stop:async r=>{stopped.push(r.runId);runs.get(r.runId).status='cancelled'},
  archive:async()=>{throw Error('must not archive')},createIssue:async()=>({id:'created'}),addNote:async()=>({number:'000'})}
 let agent=await createTopSupervisor({dir,models,adapter,tools,pollMs:20})
 const options={model:'test-model',projects:['one-project'],message:'Coordinate this project',limits:{maxCalls:20,maxRuns:2,maxConcurrent:1,maxStartsPerIssue:1}}
 try{
 script=[()=>({type:'list_issues',project:'one-project'}),()=>({type:'preview',project:'one-project',issueId:'issue',playbook:'test'}),e=>({type:'start_run',project:'one-project',issueId:'issue',previewId:e.result.previewId})]
 await agent.start({...options,limits:{...options.limits,minutes:1}})
 await wait(()=>agent.get().status==='active'&&invocations.length===4)
 t.eq('supervisor executes preview and starts issue run',starts.length,1)
 t.eq('there is no activation time limit',agent.get().limits.minutes,undefined)
 {
  // The app bar polls this; it must agree with the full view and carry no conversation.
  const brief=agent.status(), full=agent.get()
  t.eq('status agrees with the full view',[brief.status,brief.calls,brief.starts,brief.limits.maxCalls],[full.status,full.calls,full.starts,full.limits.maxCalls])
  t.ok('status carries no conversation or prompts',!('messages' in brief)&&JSON.stringify(brief).length<2000,String(JSON.stringify(brief).length))
  t.eq('status quotes the last supervisor message, shortened',brief.last?.text,full.messages.findLast(m=>m.role==='assistant')?.text?.slice(0,280)??undefined)
 }
 {
  // Its own adapter: the shared script and invocation count belong to the main flow.
  const quiet={invoke:async args=>({session:args.session??{id:'quiet'},response:JSON.stringify({message:'ok',action:null}),usage:{costUsd:0}})}
  const fresh=await createTopSupervisor({dir:await fs.mkdtemp(path.join(os.tmpdir(),'sup-defaults-')),models,adapter:quiet,tools,pollMs:20})
  await fresh.start({model:'test-model',projects:['one-project'],message:'defaults'})
  t.eq('generous defaults retain bounded calls, starts and concurrency',JSON.stringify(fresh.get().limits),JSON.stringify({maxCalls:2000,maxRuns:200,maxConcurrent:3,maxStartsPerIssue:20}))
  await fresh.stop();await fresh.shutdown()
 }
 let unknownLimit=false;try{await agent.start({...options,limits:{...options.limits,hours:1}})}catch{unknownLimit=true}
 t.ok('an unknown limit is refused rather than ignored',unknownLimit)
 t.eq('start bound to preview hash',starts[0].configHash,'snapshot-hash')
 t.ok('native session reused',invocations.slice(1).every(i=>i.session.id==='persistent-session'))
 t.ok('runtime tools restricted on every invocation',invocations.every(i=>i.supervisorOnly===true))
 t.ok('the first supervisor turn receives project infrastructure in full',JSON.parse(invocations[0].prompt).infrastructure['one-project'].staging.id==='configured-stage')
 t.ok('later turns of the same session a marker naming get_context',invocations.slice(1).every(i=>{const m=JSON.parse(i.prompt).infrastructure['one-project'];return m.staging?.id==='configured-stage'||(m.unchanged===true&&m.get==='get_context {"block":"infrastructure","project":"one-project"}')}))
 t.eq('latest performance sample reaches supervisor prompt',JSON.parse(invocations[0].prompt).seatModels[0].performance.totalMs,400)
 t.ok('and the models its run seats may be filled with',JSON.parse(invocations[0].prompt).seatModels?.[0]?.id==='seat-model-a'&&invocations.every(i=>{const s=JSON.parse(i.prompt).seatModels;return s?.[0]?.id==='seat-model-a'||s?.unchanged===true}))
 t.ok('with what each one is and whether it may run live',JSON.parse(invocations[0].prompt).seatModels[1].verified===false&&JSON.parse(invocations[0].prompt).seatModels[1].harness==='codex')
 const originalGetRun=tools.getRun
 let raceReads=0
 tools.getRun=async(p,i,id)=>{
  if(id==='r1'){
   if(raceReads++===0)return {...runs.get(id),status:'running'}
   runs.get(id).status='completed'
  }
  return originalGetRun(p,i,id)
 }
 await wait(()=>invocations.length===5&&agent.get().status==='active')
 tools.getRun=originalGetRun
 t.eq('completion discovered by spending refresh still wakes supervisor',JSON.parse(invocations[4].prompt).event.type,'run-changed')
 await agent.chat('Now explain the result')
 await wait(()=>invocations.length===6&&agent.get().status==='active')
 t.eq('chat uses same session',invocations[5].session.id,'persistent-session')
 script=[()=>({type:'archive_issue',project:'one-project',issueId:'issue'})]
 await agent.chat('Consider archiving')
 await wait(()=>invocations.length===8&&agent.get().status==='active')
 t.ok('archive permission enforced by engine',agent.get().messages.some(m=>m.role==='tool'&&m.text.includes('not enabled')))
 // Visibility is no longer a boundary: what is refused is a project that does
 // not exist, not one the operator left out of the focus list.
 script=[()=>({type:'list_issues',project:'no-such-project'})]
 await agent.chat('Read a project that is not there')
 await wait(()=>invocations.length===10&&agent.get().status==='active')
 t.ok('a project that is not on the panel is refused by identity',agent.get().messages.some(m=>m.role==='tool'&&/No project .*no-such-project.* on this panel/.test(m.text)))
 t.eq('and the focus is reported as an ordering, not a fence',JSON.parse(invocations.at(-1).prompt).focus,['one-project'])
 t.ok('while every project on the panel is visible',JSON.parse(invocations.at(-1).prompt).projects.some(p=>p.id==='one-project'))
 script=[()=>({type:'preview',project:'one-project',issueId:'issue',playbook:'test'}),e=>({type:'start_run',project:'one-project',issueId:'issue',previewId:e.result.previewId})]
 await agent.chat('Retry the same issue')
 await wait(()=>invocations.length===13&&agent.get().status==='active')
 t.ok('a second start of the same issue is refused by the per-issue limit',agent.get().messages.some(m=>m.role==='tool'&&m.text.includes('Start limit reached for this issue')))
 t.eq('and did not spend a start',starts.length,1)
 script=[()=>({type:'preview',project:'one-project',issueId:'second',playbook:'test'}),e=>({type:'start_run',project:'one-project',issueId:'second',previewId:e.result.previewId})]
 await agent.chat('Start the next issue')
 await wait(()=>invocations.length===16&&agent.get().status==='active')
 await agent.stop()
 t.ok('stop cancels owned issue runs',stopped.includes('r2'))
 t.eq('idle stop preserves session',agent.get().session.id,'persistent-session')
 const history=agent.get().messages.length
 agent=await createTopSupervisor({dir,models,adapter,tools,pollMs:20})
 t.eq('chat persisted across restart',agent.get().messages.length,history)
 const callsSoFar=agent.get().calls,invocationsSoFar=invocations.length
 await agent.start({...options,limits:{...options.limits,maxCalls:1}})
 await wait(()=>agent.get().status==='stopped')
 t.eq('Start resumes the session call allowance rather than resetting it',agent.get().calls,callsSoFar)
 t.eq('so an exhausted allowance is enforced before any invocation',invocations.length,invocationsSoFar)
 t.ok('and the reason says so',/model-call limit/.test(agent.get().reason),agent.get().reason)
 modelGate=true
 await agent.start(options)
 await wait(()=>agent.get().status==='working')
 await agent.chat('Queued while thinking')
 t.ok('chat is durable during a turn',JSON.parse(await fs.readFile(path.join(dir,'state.json'),'utf8')).queue.some(q=>q.text==='Queued while thinking'))
 await agent.stop()
 t.eq('confirmed cancellation stops supervisor',agent.get().status,'stopped')
 modelGate=null
 const disk=JSON.parse(await fs.readFile(path.join(dir,'state.json'),'utf8'));disk.status='working';disk.pending={kind:'action',action:{type:'start_run'}};await fs.writeFile(path.join(dir,'state.json'),JSON.stringify(disk))
 agent=await createTopSupervisor({dir,models,adapter,tools,pollMs:20})
 t.eq('interrupted action cannot silently replay',agent.get().status,'recovery-required')
 let refused=false;try{await agent.start(options)}catch{refused=true}
 t.ok('ambiguous restart refuses paid work',refused)
 const archived=agent.get()
 // The ledger is not session state. A fresh conversation must not touch what was
 // reserved or spent — that is the whole point of keeping it in its own file.
 const ledgerFile=path.join(dir,'ledger.jsonl')
 const ledgerBefore='{"kind":"reserve","id":"r1","subject":"run-start","at":"2026-09-15T10:00:00.000Z","day":"2026-09-15","month":"2026-09","reservedUsdMicros":5000000,"unpriced":false,"meta":{}}\n'
 await fs.writeFile(ledgerFile,ledgerBefore)
 await agent.reset()
 t.eq('New session leaves the ledger byte-for-byte alone',await fs.readFile(ledgerFile,'utf8'),ledgerBefore)
 {
  const { createLedger } = await import('../server/runtime/ledger.mjs')
  const ledger = createLedger({ file: ledgerFile }); await ledger.load()
  t.eq('the reservation is still outstanding afterwards',ledger.outstanding().map(r=>r.id),['r1'])
  t.eq('and the window still holds it',ledger.usage(Date.parse('2026-09-15T11:00:00Z')).day.committedUsdMicros,5_000_000)
 }
 t.eq('reset is the way out of recovery-required',agent.get().status,'stopped')
 t.eq('reset drops the pending operation',agent.get().pending,undefined)
 t.eq('reset discards the native session',agent.get().session,null)
 t.eq('reset leaves only its own notice in the chat',agent.get().messages.length,1)
 t.eq('reset keeps the last settings for the next start',agent.get().model.id,'test-model')
 t.eq('reset starts the cost from zero',agent.get().costUsd,0)
 const archive=JSON.parse(await fs.readFile(path.join(dir,agent.get().reset.archive),'utf8'))
 t.eq('the previous state is archived, not deleted',archive.messages.length,archived.messages.length)
 t.eq('the archive keeps the pending operation',archive.pending.kind,'action')
 // A fresh session is not a way to launder a spending cap, and it is not a way
 // to inherit last week's finished work as this week's business.
 t.eq('settled runs do not follow the new session',agent.get().ownedRuns.filter(r=>['completed','cancelled','failed','blocked','deleted','retired'].includes(r.status)).length,0)
 t.eq('but they are still in the archive',archive.ownedRuns.length,archived.ownedRuns.length)
 t.eq('the new session has fresh start allowances',[agent.get().starts,JSON.stringify(agent.get().startsByIssue),agent.get().calls],[0,'{}',0])
 t.eq('and what the old one used is history',[agent.get().history.starts,JSON.stringify(agent.get().history.startsByIssue)],[archived.starts,JSON.stringify(archived.startsByIssue)])
 t.ok('and the notice says the allowances begin again',/begin again from zero/.test(agent.get().messages[0].text),agent.get().messages[0].text)
 t.ok('the notice says what was retired',/settled run/.test(agent.get().messages[0].text)||agent.get().reset.retired.runs===0,agent.get().messages[0].text)
 t.ok('an open run would have been kept',agent.get().ownedRuns.every(r=>['pending','preflighting','running','stopping','paused','recovery-required'].includes(r.status)||!r.status),JSON.stringify(agent.get().ownedRuns))
 const before=invocations.length
 await agent.start(options)
 await wait(()=>invocations.length>before)
 t.eq('the next start opens a new native session',invocations[before].session,null)
 t.ok('and the model is not shown the old conversation',!invocations[before].history?.length)
 let liveReset=false;try{await agent.reset()}catch(e){liveReset=e.status===409}
 t.ok('reset is refused while the supervisor is live',liveReset)
 await agent.stop()
 }finally{await agent.shutdown();await fs.rm(dir,{recursive:true,force:true})}
}
