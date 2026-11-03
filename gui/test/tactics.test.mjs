import YAML from 'yaml'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { engineFixture, scriptFor, blocking } from './fakes/fixture.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { executeRelease, stagedRelease, recoverRelease } from '../server/runtime/release.mjs'
import { runProcess } from '../server/runtime/process.mjs'
import { captureWindow } from '../server/runtime/current-window.mjs'
import { publishFindings } from '../server/runtime/tactical-issues.mjs'
import { stagingRunCoverage } from '../server/staging-coverage.mjs'
import { explainRun } from '../server/runtime/run-explanation.mjs'
const fence=o=>'```json\n'+JSON.stringify(o)+'\n```'
const revision=p=>(p.match(/Current revision: (sha256:[a-f0-9]{64})/)??[])[1]??null
const finding={key:'missing-check',kind:'bug',title:'Missing check',description:'A check is missing.',evidence:['source.txt:1'],acceptanceCriteria:['Reject invalid input']}
const start=async(f,options={})=>startRun({expectConfigHash:(await resolvePlaybook(f.playbookId,{root:f.configRoot,runOptions:options,projectId:'devpanel-project'})).resolved.configHash,playbookId:f.playbookId,issue:{...f.issue,project:'devpanel-project'},issuePath:f.issuePath,projectPath:f.projectPath,harnesses:f.harnesses,stepStore:f.stepStore,workspaceProvider:f.workspaceProvider,configRoot:f.configRoot,probe:f.probe,clock:f.clock,deliveryProvider:f.delivery,runOptions:options})
function script({seen=[],rejectFirst=false,disposition='no-findings',refresh=false}={}){
 let refreshed=false
 return turn=>{
  seen.push(turn)
  const {stepId,role,round,prompt}=turn
  if(stepId==='authorize-release')return fence({targetRole:'release-operator',prompt:'Proceed with installed operation',releaseApproved:true})
  if(stepId.startsWith('brief')){
   const windowDecision=refresh&&!refreshed?'refresh-evidence':'keep';refreshed=true
   return fence({targetRole:'worker',prompt:'Investigate every criterion.',windowDecision})
  }
  if(stepId.startsWith('investigate'))return fence({...(prompt.includes('`releaseAssessment`') ? {verdict:'approved'} : {}),summary:'Read source and logs',findings:disposition==='accepted'?[finding]:[],openQuestions:[]})
  if(stepId==='disposition')return fence({disposition,reasoning:'Read all reports',response:'Thank you for the report.',issues:disposition==='accepted'?[finding]:[]})
  if(stepId.startsWith('audit-')){
   const findings=rejectFirst&&role==='auditor-1'&&round===0?[blocking('auditor-1-failure')]:[]
   return fence({verdict:findings.length?'changes-needed':'approved',artifactRevision:stepId.includes('implement')?revision(prompt):null,findings,priorFindings:[{id:'auditor-1-failure',disposition:'addressed',reason:'fixed'}]})
  }
  if(stepId==='implement')return fence({summary:'Implemented',basedOnRevision:revision(prompt)})
  if(stepId==='confirm')return fence({satisfied:true,criteria:[{id:'AC1',met:true}],...(revision(prompt)?{revision:revision(prompt)}:{})})
  return scriptFor()(turn)
 }
}
export default async function(t){
 t.section('optional seats and every occupied auditor must agree')
 const seen=[];const f=await engineFixture({playbook:'implementation',script:script({seen,rejectFirst:true})})
 const options={participants:{'auditor-1':{model:'gpt-6-astra'},'auditor-2':{model:'gpt-6-astra'}}}
 const engine=await start(f,options);await engine.drive()
 t.eq('completed only after correction',engine.run.status,'completed')
 t.eq('two implementation rounds',seen.filter(x=>x.stepId==='implement').length,2)
 t.eq('both occupied auditors review both rounds',seen.filter(x=>x.stepId.startsWith('audit')).length,4)
 t.ok('coordinator sees first auditor concern despite second approval',seen.find(x=>x.stepId==='brief-implement'&&x.round===1)?.prompt.includes('auditor-1-failure'))
 t.eq('approval recorded for each seat',engine.run.approvals.map(x=>x.role).sort(),['auditor-1','auditor-2'])
 await releaseWorkspace(engine)
 const missing=await resolvePlaybook('implementation',{root:f.configRoot,runOptions:{participants:{implementer:null}}})
 t.ok('required seat cannot be cleared',!missing.ok)
 const none=await resolvePlaybook('implementation',{root:f.configRoot,runOptions:{participants:{'auditor-1':null}}})
 t.ok('empty optional seat resolves',none.ok)
 t.section('plan consensus precedes implementation and stale code approvals are refused')
 const ps=[];const pf=await engineFixture({playbook:'plan-and-implement',script:script({seen:ps,rejectFirst:true})})
 const pe=await start(pf,{participants:Object.fromEntries([1,2,3,4].map(i=>[`auditor-${i}`,{model:'gpt-6-astra'}]))});await pe.drive()
 t.eq('both consensus loops complete',pe.run.status,'completed')
 const firstImplementation=ps.findIndex(x=>x.stepId==='implement')
 t.eq('all four auditors approve plan before first implementation',ps.slice(0,firstImplementation).filter(x=>x.stepId.startsWith('audit-plan')).length,8)
 t.eq('all four auditors repeat implementation review after a finding',ps.filter(x=>x.stepId.startsWith('audit-implement')).length,8)
 await releaseWorkspace(pe)
 const goodScript=script();const sf=await engineFixture({playbook:'implementation',script:turn=>turn.stepId.startsWith('audit-')?fence({verdict:'approved',artifactRevision:'sha256:wrong',findings:[]}):goodScript(turn)})
 const se=await start(sf,{participants:{'auditor-1':{model:'gpt-6-astra'}}});await se.drive()
 t.eq('wrong revision never reaches closure',se.run.blockedReason,'protocol-repair-exhausted')
 await releaseWorkspace(se)
 t.section('analysis waits for all five and creates durable issues')
 const analysisSeen=[];const a=await engineFixture({playbook:'analysis',script:script({seen:analysisSeen,disposition:'accepted'})})
 const ae=await start(a,{participants:Object.fromEntries([2,3,4,5].map(i=>[`analyser-${i}`,{model:'gpt-6-astra'}]))});await ae.drive()
 t.eq('analysis completed',ae.run.status,'completed')
 t.eq('five investigators, no auditor',analysisSeen.filter(x=>x.stepId.startsWith('investigate')).length,5)
 t.ok('disposition receives fifth report',analysisSeen.find(x=>x.stepId==='disposition')?.prompt.includes('analyser-5'))
 t.eq('issue created',ae.run.reportDisposition?.issues.length,1)
 const receipt=ae.run.reportDisposition.issues[0]
 const created=JSON.parse(await fs.readFile(path.join(path.dirname(a.issuePath),receipt.issueId,'issue.json'),'utf8'))
 t.eq('new issue classified',created.kind,'bug')
 const reportWindow=await captureWindow({issuePath:path.join(path.dirname(a.issuePath),receipt.issueId),runId:'report-input-check',workspace:{path:a.projectPath}})
 t.ok('published issue retains its originating report as input',reportWindow.inputs.some(input=>input.origin==='external-report'))
 const again=await publishFindings({issuePath:a.issuePath,runId:ae.runId,project:'devpanel-project',output:{issues:[finding]}})
 t.eq('publication replay deduplicates',again[0].issueId,receipt.issueId)
 await fs.writeFile(path.join(path.dirname(a.issuePath),receipt.issueId,'.archive.json'),'{}')
 const linked=await publishFindings({issuePath:a.issuePath,runId:ae.runId,project:'devpanel-project',output:{issues:[{...finding,existingIssue:receipt.issueId}]}})
 t.eq('archived duplicate is linked without reopening it',linked[0].archived,true)
 t.eq('new evidence stays on source report for archived duplicates',linked[0].evidenceOnSourceIssue,true)
 await releaseWorkspace(ae)
 t.section('evidence refresh repeats investigation; no independent audit still completes honestly')
 const rs=[];const r=await engineFixture({playbook:'analysis',script:script({seen:rs,refresh:true,disposition:'rejected'})});const re=await start(r);await re.drive()
 t.eq('analysis completed',re.run.status,'completed')
 t.eq('rejection stored',re.run.reportDisposition?.disposition,'rejected')
 t.ok('previous evidence window retained',Boolean(re.run.currentWindow.previous))
 t.eq('coordinator re-briefs against refreshed evidence',rs.filter(x=>x.stepId==='brief').length,2)
 await releaseWorkspace(re)
 const z=await engineFixture({playbook:'plan-and-implement',auditor:null,script:script()});const ze=await start(z);await ze.drive()
 t.eq('plan and implementation without auditors can finish',ze.run.status,'completed')
 t.eq('no fabricated approvals',ze.run.approvals.length,0)
 t.eq('closure records that no independent audit occurred',ze.run.closure.independentAudit,false)
 await releaseWorkspace(ze)
 t.section('release playbook executes configured operations before verifier seats')
 const releaseSeen=[];const rf=await engineFixture({playbook:'staging',script:script({seen:releaseSeen})})
 const environment=id=>({id,ssh:{hostRef:`ssh-config:${id}.invalid`,workdir:'/tmp'},projectRoot:'/tmp/fixture',files:{}})
 const infrastructure={kind:'boilerplate',orientation:'Isolated fixture; no real hosts',staging:environment('stage'),deployments:[environment('production')],testDrive:{requirement:'optional',commands:[{id:'noop',run:'true',required:true}],notes:'Fixture only'}}
 infrastructure.release={targets:{stage:{workdir:rf.projectPath,ownership:'Fixture source only',rollback:'automatic',commands:Object.fromEntries(['inspect','checkpoint','verifyCheckpoint','apply','verifyRelease','restart','observe','test','restore','verifyRestore'].map(id=>[id,{run:'printf verified',timeoutSeconds:10}]))}}}
 await fs.mkdir(path.join(rf.configRoot,'projects'))
 await fs.writeFile(path.join(rf.configRoot,'projects/devpanel-project.yaml'),YAML.stringify({id:'devpanel-project',evidence:[],infrastructure}))
 const rse=await start(rf,{participants:{'verifier-1':{model:'gpt-6-astra'}}})
 // A run delivered before this one: its patch left the bytes the snapshot holds (the fixture's source.txt).
 const carried=await fs.mkdtemp(path.join(os.tmpdir(),'devpanel-carried-'))
 await fs.mkdir(path.join(carried,'runs/delivered/artifacts'),{recursive:true})
 const blob=text=>crypto.createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex')
 await fs.writeFile(path.join(carried,'runs/delivered/artifacts/x.patch'),`diff --git a/source.txt b/source.txt\nindex ${blob('old\n')}..${blob('original\n')} 100644\n--- a/source.txt\n+++ b/source.txt\n@@ -1 +1 @@\n`)
 const deliveredRun={runId:'delivered',status:'completed',outcome:'resolved',startedAt:'2026-11-03T00:00:00.000Z',revisions:[{fingerprint:'rev'}],delivery:{action:'apply-to-source',revision:'rev',completedAt:'2026-11-03T00:00:00.000Z',artifactRef:'artifacts/x.patch',application:{verified:true}}}
 const carriedIssue={id:'carried-issue',project:'devpanel-project',path:carried}
 // The engine's clock here is a fixture's, older than the coverage baseline: the snapshot time is stated.
 rse.releaseCoverage=args=>stagingRunCoverage({...args,snapshotAt:'2026-11-03T01:00:00.000Z',project:'devpanel-project',projectPath:rf.projectPath,listIssues:async(_,{archived=false}={})=>archived?[]:[carriedIssue],readRuns:async()=>[deliveredRun],readOperations:async()=>[]})
 await rse.drive()
 t.eq('configured staging playbook completes',rse.run.status,'completed')
 t.eq('a Staging run records the delivered run its snapshot carries',rse.run.release.coverage.covered,[{issueId:'carried-issue',runId:'delivered'}])
 t.eq('with none indeterminate',rse.run.release.coverage.indeterminate,[])
 t.eq('its explanation names it',explainRun(rse.run).releaseCoverage.covered,[{issueId:'carried-issue',runId:'delivered'}])
 t.ok('in words',explainRun(rse.run).detail.includes('delivered (carried-issue)'))
 await fs.rm(carried,{recursive:true,force:true})
 t.eq('all release stages recorded',rse.run.release.commands.filter(c=>c.status==='completed').length,8)
 t.ok('operator preparation precedes mutation',!releaseSeen.find(x=>x.stepId==='investigate-release-plan')?.prompt.includes('checkpointVerified'))
 t.ok('operator receives execution evidence afterwards',releaseSeen.find(x=>x.stepId==='investigate-release-operator')?.prompt.includes('checkpointVerified'))
 t.eq('release closure records occupied independent verifiers',rse.run.closure.independentAudit,true)
 t.ok('verifier sees operation evidence',releaseSeen.find(x=>x.role==='verifier-1')?.prompt.includes('checkpointVerified'))
 t.ok('command logs are durable files',await fs.access(rse.run.release.commands[0].logFile).then(()=>true,()=>false))
 await releaseWorkspace(rse)
 t.section('release checkpoints, recovery and promotion identity')
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'devpanel-release-test-'))
 try{
  const issuePath=path.join(tmp,'2026-09-13-report');const workspace={path:path.join(tmp,'source')}
  await fs.mkdir(workspace.path,{recursive:true});await fs.mkdir(issuePath);await fs.writeFile(path.join(workspace.path,'app.txt'),'release one')
  const commandIds=['inspect','checkpoint','verifyCheckpoint','apply','verifyRelease','restart','observe','test','restore','verifyRestore']
  const config={workdir:tmp,ownership:'Own app.txt; preserve state.',rollback:'automatic',commands:Object.fromEntries(commandIds.map(id=>[id,{run:id,timeoutSeconds:10}]))}
  const snapshot={tactic:'staging',runOptions:{},infrastructure:{staging:{id:'stage'},deployments:[{id:'prod'}],release:{targets:{stage:config,prod:config}}}}
  let calls=[]
  const execute=async args=>{if(args.command==='tar')return runProcess(args);calls.push(args.args.at(-1));return {code:args.args.at(-1)==='test'?1:0,stdout:'observed',stderr:''}}
  const coldFailure=await executeRelease({issuePath,runId:'cold-checkpoint-failure',workspace,snapshot,execute:async args=>{
   if(args.command==='tar')return runProcess(args)
   return {code:args.args.at(-1)==='verifyCheckpoint'?1:0,stdout:'',stderr:''}
  }})
  t.eq('failed cold checkpoint verification requires recovery',coldFailure.status,'recovery-required')
  t.ok('failed checkpoint never reaches apply',!coldFailure.commands.some(c=>c.id==='apply'))
  const failed=await executeRelease({issuePath,runId:'failed',workspace,snapshot,execute})
  t.eq('test failure restores verified checkpoint',failed.status,'rolled-back')
  t.eq('restore verified',calls.slice(-2),['restore','verifyRestore'])
  const replay=await executeRelease({issuePath,runId:'failed',workspace,snapshot,execute});t.eq('failed operations never automatically repeat',replay.status,'rolled-back');t.eq('one apply',calls.filter(x=>x==='apply').length,1)
  calls=[]
  const goodExecute=async args=>{if(args.command==='tar')return runProcess(args);calls.push(args.args.at(-1));return {code:0,stdout:'ok',stderr:''}}
  const good=await executeRelease({issuePath,runId:'good',workspace,snapshot,execute:goodExecute})
  await fs.writeFile(path.join(issuePath,'runs/good/run.json'),JSON.stringify({status:'completed',outcome:'resolved'}))
  t.eq('success performed all required stages',calls,commandIds.slice(0,8))
  const staged=await stagedRelease(tmp,'good');t.eq('receipt binds artifact',staged.sha256,good.sha256)
  await fs.writeFile(path.join(workspace.path,'app.txt'),'newer untested changes')
  const promoted=await executeRelease({issuePath,runId:'production',workspace,snapshot:{...snapshot,tactic:'deployment',runOptions:{releaseId:'good'}},execute:goodExecute})
  t.eq('production promotes exact tested bytes',promoted.sha256,good.sha256)
  await fs.appendFile(staged.archive,'tamper')
  let refused=false;try{await stagedRelease(tmp,'good')}catch{refused=true}t.ok('tampered staged archive refused',refused)
  const recovered=await recoverRelease({issuePath,runId:'production',snapshot:{...snapshot,tactic:'deployment'},reason:'Verifier found a regression',execute:goodExecute})
  t.eq('verifier rejection also restores',recovered.status,'rolled-back')
  await fs.writeFile(path.join(tmp,'instance.txt'),'previous instance')
  const realCommands={inspect:'test -f instance.txt',checkpoint:'cp instance.txt checkpoint.txt',verifyCheckpoint:'cmp instance.txt checkpoint.txt',apply:'printf new > instance.txt',verifyRelease:'test "$(cat instance.txt)" = new',restart:'true',observe:'cat instance.txt',test:'false',restore:'cp checkpoint.txt instance.txt',verifyRestore:'cmp checkpoint.txt instance.txt'}
  const realSnapshot={...snapshot,infrastructure:{...snapshot.infrastructure,release:{targets:{stage:{...config,commands:Object.fromEntries(Object.entries(realCommands).map(([id,run])=>[id,{run,timeoutSeconds:10}]))}}}}}
  const real=await executeRelease({issuePath,runId:'real-rollback',workspace,snapshot:realSnapshot})
  t.eq('real shell test failure rolls back',real.status,'rolled-back')
  t.eq('previous instance bytes restored',await fs.readFile(path.join(tmp,'instance.txt'),'utf8'),'previous instance')
  const interruptedFile=path.join(issuePath,'runs/interrupted/release.json');await fs.mkdir(path.dirname(interruptedFile),{recursive:true});await fs.writeFile(interruptedFile,JSON.stringify({status:'running',commands:[{id:'apply',status:'running'}]}))
  const interrupted=await executeRelease({issuePath,runId:'interrupted',workspace,snapshot,execute:()=>{throw new Error('must not replay')}})
  t.eq('interrupted operation requires recovery',interrupted.status,'recovery-required')
  const log=path.join(tmp,'service.log');await fs.writeFile(log,'earlier\nnewest\n')
  const window=await captureWindow({issuePath,runId:'window',workspace,evidence:[{name:'service',path:log,maxBytes:7}]})
  t.eq('bounded log capture is explicit',window.files[0].truncated,true)
  await fs.writeFile(log,'later');t.eq('captured bytes do not change with live log',await fs.readFile(window.files[0].file,'utf8'),'newest\n')
 }finally{await fs.rm(tmp,{recursive:true,force:true})}
}
