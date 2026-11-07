import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Engine, plan, boundedReports, releaseAssessmentAccepted } from '../server/runtime/engine.mjs'
import { captureWindow } from '../server/runtime/current-window.mjs'
import { retireLegacyJournal } from '../server/runtime/legacy-journal.mjs'
import { inspectRunJournal, requireCompleteEvents } from '../server/runtime/store.mjs'
import { classifyFailure } from '../server/runtime/failure.mjs'
import { summariseStep } from '../server/supervisor-summary.mjs'
import { createStartGate } from '../server/supervisor-starts.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { sandbox } from './helpers.mjs'
import YAML from 'yaml'
const policy={protocolRepair:{maxAttempts:2},substantial:{anyOf:[{blocking:true},{severity:['critical','major']}]}}
const approved={valid:true,contract:'releaseAssessment',output:{summary:'Verified',verdict:'approved',findings:[],openQuestions:[]}}
export default async function(t){
 t.section('release closure uses effective agent attempts, not bookkeeping')
 for(const variant of ['clean','operator','repair','minor','blocking']){
  const e=Object.create(Engine.prototype)
  e.snapshot={tactic:'staging',participants:{coordinator:{},'release-operator':{}},reviewPolicy:policy,checks:{requirement:'none'},autoClose:{minimumVerification:'review-only'},completion:{requires:['coordinatorConfirmation','deliveryCompleted'],delivery:{action:'none'}}}
  e.run={issue:{project:'fixture'},workspace:{},release:{status:'completed',commands:[]},revisions:[],approvals:[],checkResults:[],steps:[{number:'001',role:'release-operator',stepId:'assess',phase:'release',round:0},{number:'004',role:'coordinator',stepId:'confirm',phase:'confirm',round:0}]}
  e.outputs={'001':structuredClone(approved),'004':{valid:true,contract:'closureConfirmation',output:{satisfied:true,criteria:[]}}}
  if(variant==='operator')e.run.steps.splice(1,0,{number:'002',role:'operator',decision:{answer:'continue'}})
  if(variant==='repair'){
   e.run.steps.splice(1,0,{number:'002',role:'verifier-1',stepId:'verify',phase:'verify',round:0,attempt:1},{number:'003',role:'verifier-1',stepId:'verify',phase:'verify',round:0,attempt:2})
   e.outputs['002']={valid:false,contract:'releaseAssessment'};e.outputs['003']=approved
  }
  if(['minor','blocking'].includes(variant))e.outputs['001'].output.findings=[{id:'note',description:'A finding',severity:variant==='minor'?'minor':'major',blocking:variant==='blocking'}]
  e.assertJournal=async()=>{};e.clock={iso:()=>new Date().toISOString()}
  await e.evaluateClosure()
  t.eq(`${variant}: closure decision`,e.run.status,variant==='blocking'?'blocked':'completed')
 }
 t.ok('legacy empty release assessments stay compatible',releaseAssessmentAccepted({valid:true,contract:'investigationResult',output:{findings:[],openQuestions:[]}}))
 const snapshot={reviewPolicy:policy,participants:{auditor:{}},phases:[{id:'implementation',loop:{maxRounds:2,consensus:true,until:'review.verdict == approved',steps:[{id:'audit',role:'auditor',context:[]}]}}]}
 const result=plan(snapshot,[{number:1,revision:'sha256:current'},{number:2,phase:'implementation',stepId:'audit',round:0,attempt:1}],{2:{valid:true,contract:'reviewResult',output:{verdict:'approved',artifactRevision:'sha256:previous',findings:[],priorFindings:[]}}})
 t.eq('wrong revision gets a repair turn',result.kind,'turn');t.eq('repair attempt increments',result.attempt,2)
 t.eq('token counts are not HTTP failures',classifyFailure({message:'failed after 503 tokens'}).class,'runtime')
 t.eq('actual HTTP 503 remains transient',classifyFailure({message:'HTTP 503'}).class,'transient')
 t.eq('structured HTTP status remains classified',classifyFailure({message:'provider error',payload:{status:429}}).class,'rate-limit')
 const broken=Object.create(Engine.prototype),original=new Error('original runtime failure')
 broken.run={status:'running'};broken.controller=new AbortController()
 broken.assertJournal=async()=>{};broken.refusalReason=()=>null;broken.persist=async()=>{}
 // What drive() reads before its budget check: nothing may throw first.
 broken.pauseAtBoundary=async()=>false;broken.snapshot={completion:{requires:[]}}
 broken.budgetExceeded=()=>{throw original};broken.recoverUnacceptedRelease=async()=>{throw new Error('recovery persistence failure')}
 let caught;try{await broken.drive()}catch(error){caught=error}
 t.eq('recovery persistence cannot replace original error',caught,original)
 t.ok('secondary recovery error is retained',caught.recoveryError==='recovery persistence failure')
 t.ok('string steps work',summariseStep({timeline:[{number:'001'}]},'1','response'))
 t.ok('numeric historical/fixture steps work',summariseStep({timeline:[{number:1}]},'001','response'))
 const steps=Array.from({length:120},(_,i)=>({number:i+1,role:'auditor-'+i%5,stepId:'audit-'+i%5,phase:'review',round:i,response:'x'.repeat(10000),reportFile:'/evidence/'+i+'.json'}))
 const reports=boundedReports({windowLimits:{maxPromptChars:12000}}, {}, steps, {})
 t.eq('history keeps the latest report from every seat',reports.length,5)
 t.ok('history body stays bounded',JSON.stringify(reports).length<14000)
 t.ok('truncated reports point to durable full evidence',reports.every(r=>r.truncated&&r.fullReport))
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'devpanel-audit-regression-'))
 try{
  const issue=path.join(tmp,'2026-09-14-fixture');await fs.mkdir(issue)
  for(const [folder,name,content] of [['000-report','note.md','human'],['001-agent','response.md','agent'],['002-legacy-agent','response.md','old agent'],['003-note','note.txt','more human']]){
   await fs.mkdir(path.join(issue,folder));await fs.writeFile(path.join(issue,folder,name),content)
  }
  await fs.writeFile(path.join(issue,'.step-reservations.json'),JSON.stringify([{number:'001',invocationId:'agent-invocation'}]))
  const window=await captureWindow({issuePath:issue,runId:'window',workspace:{path:tmp},limits:{maxInputFiles:1,maxInputBytes:10}})
  t.eq('only human/report input copied',window.inputs.length,1)
  t.eq('known agent folder excluded',window.inputBudget.excludedAgentFolders,1)
  t.ok('aggregate cap and unclassified responses report omissions',window.inputBudget.omittedFiles>=2)
  t.eq('copied bytes come from human note',await fs.readFile(window.inputs[0].file,'utf8'),'human')
  await fs.mkdir(path.join(issue,'004-published'))
  await fs.writeFile(path.join(issue,'004-published','response.md'),'New external finding')
  await fs.writeFile(path.join(issue,'.step-reservations.json'),JSON.stringify([{number:'001',invocationId:'agent-invocation'},{number:'004',invocationId:'finding:source:hash',origin:'external-report'}]))
  const reportsWindow=await captureWindow({issuePath:issue,runId:'reports-window',workspace:{path:tmp}})
  const report=reportsWindow.inputs.find(input=>input.origin==='external-report')
  t.eq('published findings remain available as new report input',report&&await fs.readFile(report.file,'utf8'),'New external finding')
  const dir=path.join(issue,'runs','legacy');await fs.mkdir(path.join(dir,'outputs'),{recursive:true});await fs.mkdir(path.join(dir,'artifacts'))
  const run={status:'failed',blockedReason:'base policy "head" requires a clean checkout, fixture',endedAt:'2026-09-12T00:00:00Z',phase:{id:null},workspace:{path:null},steps:[],revisions:[],approvals:[],checkResults:[],participants:{coordinator:{turns:0,state:'uninitialised',session:null,pendingInvocation:null}}}
  const bytes=JSON.stringify(run);await fs.writeFile(path.join(dir,'run.json'),bytes);await fs.writeFile(path.join(dir,'resolved-playbook.json'),'{}')
  await inspectRunJournal(issue,'legacy')
  const finding=await fs.readFile(path.join(dir,'journal-recovery.json'),'utf8')
  await retireLegacyJournal(issue,'legacy','Verified failed before a workspace or agent turn existed')
  t.eq('retired legacy failure no longer blocks new runs',(await inspectRunJournal(issue,'legacy')).recoveryRequired,false)
  t.eq('original run bytes preserved',await fs.readFile(path.join(dir,'run.json'),'utf8'),bytes)
  t.eq('original journal finding preserved',await fs.readFile(path.join(dir,'journal-recovery.json'),'utf8'),finding)
  let refused=false;try{await requireCompleteEvents(issue,'legacy')}catch{refused=true}t.ok('retirement never licenses historical execution',refused)
  await fs.writeFile(path.join(dir,'outputs','001.json'),'{}')
  t.ok('changed retirement evidence blocks again',(await inspectRunJournal(issue,'legacy')).recoveryRequired)
 }finally{await fs.rm(tmp,{recursive:true,force:true})}
 t.section('deleted run receipts and explicit retirement release start slots')
 for(const proof of [true,false]){
  const state={launches:[{id:'old',status:'started',project:'p',issueId:'deleted',runId:'r'}],ownedRuns:[],limits:{},failedLaunches:{}}
  const gate=createStartGate({getState:()=>state,save:async()=>{},tools:{getRun:async()=>{throw Object.assign(new Error('deleted issue'),{status:404})},wasDeleted:async()=>proof}})
  await gate.refresh()
  t.eq(`missing run with deletion proof=${proof}`,state.launches[0].status,proof?'finished':'uncertain')
  if(!proof){await gate.reconcile({launchId:'old',retired:true,reason:'Operator confirmed stopped run was deliberately deleted'});t.eq('explicit missing-run retirement is supported',state.launches[0].status,'finished')}
 }
 const root=await sandbox(async dir=>{
  const environment=id=>({id,ssh:{hostRef:`ssh-config:${id}.invalid`,workdir:'/tmp'},projectRoot:'/tmp/fixture',files:{}})
  const target={workdir:'/tmp',ownership:'fixture',rollback:'manual',commands:Object.fromEntries(['inspect','checkpoint','verifyCheckpoint','apply','verifyRelease','restart','observe','test','restore','verifyRestore'].map(id=>[id,{run:'true',timeoutSeconds:10}]))}
  await fs.mkdir(path.join(dir,'projects'));await fs.writeFile(path.join(dir,'projects/test-project.yaml'),YAML.stringify({id:'test-project',infrastructure:{kind:'boilerplate',orientation:'Fixture',staging:environment('stage'),deployments:[environment('prod-a'),environment('prod-b')],testDrive:{commands:[{id:'test',run:'true'}]},release:{targets:{'prod-a':target,'prod-b':target}}}}))
 })
 const multiple=await resolvePlaybook('deployment',{root,projectId:'test-project',runOptions:{releaseId:'staged',environment:'production'}})
 t.ok('multiple deployments demand explicit target',multiple.resolved?.liveExecution.blockers.some(b=>b.reason.includes('explicitly')))
 const explicit=await resolvePlaybook('deployment',{root,projectId:'test-project',runOptions:{releaseId:'staged',environment:'prod-b'}})
 t.ok('explicit target resolves',explicit.ok&&!explicit.resolved.liveExecution.blockers.some(b=>!b.model))
}
