import { readCheckLog } from './runtime/check-log.mjs'
import * as store from './runtime/store.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { acquire } from './runtime/lock.mjs'
import { createTopSupervisor } from './top-supervisor.mjs'
import { CONFIG_ROOT, loadConfig, resolvePlaybook } from './config/load.mjs'
import { getRun, listPlaybooks, listRuns, preview, readStepResponse } from './runs-api.mjs'
import { resolveWithRelease, selectStagedRelease } from './release-selection.mjs'
import { summariseIssue, summarisePackedRun, summarisePreview, summariseRun, summariseStep } from './supervisor-summary.mjs'
import { projectInfrastructure, inspectEnvironment } from './infrastructure.mjs'
import { inspectLaunchState } from './supervisor-launch-state.mjs'
import { buildOverview } from './supervisor-overview.mjs'
import { setIssueDependencies, openDependencies } from './issue-dependencies.mjs'
import { readReporters, reportStartLevel } from './reporters.mjs'
import { startAdmission } from './start-admission.mjs'
import { launchReadiness } from './supervisor-readiness.mjs'
import { conflictsWith, readWaits } from './runtime/module-locks.mjs'
import { projectPath } from './project-path.mjs'
import { performanceForModel } from './model-performance.mjs'
import { createAvailabilityStore } from './runtime/failure.mjs'
import { deployStaging, deploymentReport } from './staging-deployment.mjs'
import { deploymentCoverage, stagingPendingReport, writeDeploymentNotes } from './staging-coverage.mjs'

export async function topSupervisorService ({ issues, supervisor, modelPerformance = null, emit, changed, decisions = null, consult = null }) {
 const configRoot=process.env.DEVPANEL_CONFIG_ROOT ?? CONFIG_ROOT
 const models=async()=>[...(await loadConfig({root:configRoot})).roster.values()].filter(m=>['claude','codex'].includes(m.harness))
 // Which models a run's SEATS may be filled with — a different question from
 // which model the supervisor itself runs on. Without this the supervisor sees
 // only each playbook's defaults and concludes, wrongly, that they are the only
 // choices; runOptions.participants accepts any verified roster id.
 /*
  * The seat catalogue: every model a run's seats may be filled with, with the
  * evidence behind each claim rather than a bare id.
  *
  * Verified and available are deliberately different questions. Verified is a
  * standing fact about whether runtime access was ever proven, and carries when
  * and how it was proven so its freshness can be judged; available is about now,
  * and comes from the host-wide record of models seen exhausted. A model can be
  * verified and unavailable, and reading either as the other wastes a start.
  *
  * What is NOT here stays absent rather than guessed: the roster records no
  * price; the performance field carries an explicit hello-world measurement.
  * Observed cost and duration per seat are real
  * measurements that live in the overview, keyed by role and model.
  */
 const availability=createAvailabilityStore(path.join(issues.ISSUES_DIR ?? process.env.DEVPANEL_ISSUES_DIR ?? '.','.availability.json'))
 const seatModels=async()=>Promise.all([...(await loadConfig({root:configRoot})).roster.values()].map(async m=>{
  const cooling=await availability.check(m.id).catch(()=>null)
  return {
   id:m.id,title:m.title??m.id,harness:m.harness,profile:m.profile??'default',account:m.account??null,
   contextWindow:m.contextWindow??null,efforts:m.efforts??null,defaultEffort:m.defaultEffort??null,
   verified:m.verification?.status==='verified',
   verification:{status:m.verification?.status??'unknown',at:m.verification?.verifiedAt??null,method:m.verification?.method??null},
   available:!cooling,
   performance:performanceForModel(modelPerformance?.snapshot(),m),
   unavailable:cooling?{until:cooling.exhaustedUntil,assumed:Boolean(cooling.assumed),reason:cooling.reason??null}:null,
   // The roster's own prose: what it is, how it is reached, and what about it is
   // unmeasured. Choosing a seat well needs that, not just an id.
   notes:typeof m.notes==='string'?m.notes.trim().slice(0,800):null
  }
 }))
 const harnessDir=process.env.DEVPANEL_HARNESS_DIR ?? path.join(configRoot,'harness')
 // Import only at invocation: scratch servers can never fall back to a real adapter.
 const adapter={invoke:async args=>{
  if (!['claude','codex'].includes(args.harness)) throw new Error('Unsupported supervisor harness')
  return (await import(pathToFileURL(path.join(harnessDir,`${args.harness}.mjs`)).href)).invoke(args)
 }}
 const full=async(project,issueId,runId)=>{
  const issue=await issues.getIssue(project,issueId)
  return getRun(issue.path,runId,{issues,project,issueId,isActive:supervisor.isActive(project,issueId),liveCheckSince:supervisor.liveCheckSince(project,issueId,runId)})
 }
 // The supervisor sees summaries; the panel's full view stays behind get_step.
 // A packed issue (archived, or an answered inquiry that packed itself) has no run folders, but its bundle keeps every
 // run record: monitoring and the start gate read the ending and the cost from there, so packing between two polls
 // is an ordinary ending and not a vanished run. Steps stay in the bundle; restore the issue to read them.
 const detail=async(project,issueId,runId)=>{
  const issue=await issues.getIssue(project,issueId)
  if(!issue.packed)return summariseRun(await full(project,issueId,runId))
  const record=await issues.readRunRecord(project,issueId,runId)
  if(!record)throw Object.assign(new Error('no such run'),{status:404})
  return summarisePackedRun({runId,project,issueId,record})
 }
 const mutate=async fn=>{const value=await fn();changed();return value}
 const dir=process.env.DEVPANEL_SUPERVISOR_DIR ?? path.join(issues.ISSUES_DIR,'.supervisor')
 const lock=await acquire(path.join(dir,'.owner.lock'),{purpose:'top-level-supervisor'})
 let service
 try { service=await createTopSupervisor({dir,models,adapter,emit,decisions,
  tools:{
   // The consult panel for the supervisor's own questions (consult/consult.mjs): it reads the project, the
   // issue's folder and, when a run is named, that run's worktree; recorded under the supervisor's directory.
   ...(consult?{consult:async({project,issueId=null,runId=null,...request})=>{
    let issueDir=null,worktree=null
    if(issueId){
     const issue=await issues.getIssue(project,issueId)
     if(!issue.packed){
      issueDir=issue.path
      const run=runId?await store.readRun(issue.path,runId).catch(()=>null):null
      if(run?.workspace?.path&&run.workspace.state!=='removed'&&run.workspace.isolation!=='in-place')worktree=run.workspace.path
     }
    }
    return consult.consult({...request,askedBy:{role:'supervisor'},project,issueDir,worktree},{callerDir:dir})
   }}:{}),
   retryInput:a=>supervisor.retryInput(a), recover:a=>supervisor.recover(a), refreshChecks:a=>supervisor.refreshChecks(a), acceptCheckResult:a=>supervisor.acceptCheckResult(a), reconcileDelivery:a=>supervisor.reconcileDelivery(a), continueRun:a=>supervisor.continueRun(a),
   availability:supervisor.availability,recordExhausted:a=>supervisor.availability.recordExhausted(a),
   projects:()=>issues.listProjects(),playbooks:()=>listPlaybooks({root:configRoot}),seatModels,
   // Every project on the panel, never a selection: a management reading that
   // omits a project is how the supervisor came to report work as non-existent.
   overview:async({focus=[]}={})=>{let config=null;return buildOverview({projects:(await issues.listProjects()).map(p=>p.id),focus,listIssues:(p,o)=>issues.listIssues(p,o),openDependencies,
     stagingPending:(project,lists)=>stagingPendingReport({project,projectPath:projectPath(project),root:configRoot,lists,config:config??=loadConfig({root:configRoot}),listIssues:(p,o)=>issues.listIssues(p,o)})})},
   setPriority:a=>mutate(()=>issues.setIssuePriority(a.project,a.issueId,{value:a.priority,reason:a.reason,by:a.by??'supervisor'})),
   setDependencies:a=>mutate(()=>setIssueDependencies(a.project,a.issueId,{dependsOn:a.dependsOn,reason:a.reason,by:'supervisor'})),
   startAdmission:async a=>startAdmission({issue:await issues.getIssue(a.project,a.issueId),playbook:a.playbook}),
   // What the ready queue cannot read off the listings: which live run holds each project's checkout, by the test a start is refused on, and how far a report's trust reaches.
   readyQueueFacts:async issuesByProject=>{
    const holders={},reportLevels={},moduleConflicts={},moduleWaits={}
    let reporters=null
    // One configuration read per queue reading, shared by every project's pool reading.
    const config=await loadConfig({root:configRoot}).catch(()=>null)
    for(const [project,rows] of Object.entries(issuesByProject)){
     holders[project]=await supervisor.checkoutHolder(project,rows)
     for(const issue of rows)if(issue.report){reporters??=await readReporters();reportLevels[`${project}/${issue.id}`]=await reportStartLevel(issue,{reporters})}
     // Module locks of the project's pool (module-locks.mjs): what each issue's triage named that another live run holds, and live runs waiting for a module.
     const locks=config&&supervisor.moduleLockReading?await supervisor.moduleLockReading({project,config}).catch(()=>null):null
     if(!locks)continue
     for(const issue of rows){
      const conflicts=conflictsWith(locks.held,issue.sizing?.affectedModules??[],{project,issueId:issue.id})
      if(conflicts.length)moduleConflicts[`${project}/${issue.id}`]=conflicts
     }
     for(const wait of await readWaits(locks.pool))if(wait.project===project&&wait.issueId)moduleWaits[`${project}/${wait.issueId}`]=wait
    }
    return {holders,reportLevels,moduleConflicts,moduleWaits}
   },
   readiness:async a=>{
    const issue=a.issueId?await issues.getIssue(a.project,a.issueId).catch(()=>null):null
    return launchReadiness({...a,projectPath:projectPath(a.project),
     resolve:(id,opts)=>resolvePlaybook(id,{...opts,root:configRoot}),inspectLaunch:inspectLaunchState,
     pathOverlap:args=>supervisor.pathOverlap({project:a.project,projectPath:projectPath(a.project),issuePath:issue?.path??null,...args}),
     moduleLocks:()=>supervisor.moduleLockReading({project:a.project,issueId:a.issueId??null})})
   },
   infrastructure:project=>projectInfrastructure(project,{root:configRoot}),
   inspectEnvironment:a=>inspectEnvironment(a,{root:configRoot}),
   deployStaging:async(a,{signal}={})=>{
    const issue=await issues.getIssue(a.project,a.issueId)
    if(issue.archived)throw Object.assign(new Error('Cannot deploy for an archived issue'),{status:409})
    if(supervisor.isActive(a.project,a.issueId))throw Object.assign(new Error('Stop the active issue run before a shared staging deployment'),{status:409})
    const result=await deployStaging({project:a.project,issuePath:issue.path,root:configRoot,signal,coverage:deploymentCoverage({project:a.project,projectPath:projectPath(a.project),listIssues:(p,o)=>issues.listIssues(p,o)})})
    await mutate(()=>issues.createStep(a.project,a.issueId,{name:'staging-deployment',text:deploymentReport(result),format:'md',invocationId:`staging-deployment:${result.id}`}))
    // After the report step, which the notes name; on a replay too, so a note a crash lost is written.
    await mutate(()=>writeDeploymentNotes({project:a.project,issue,operation:result,issues}))
    return result
   },
   listIssues:project=>issues.listIssues(project),
   getIssue:async(project,issueId)=>{
    const issue=await issues.getIssue(project,issueId)
    const reports=[]
    for(const step of issue.steps)for(const f of step.files??[])if(/\.(md|txt)$/i.test(f.name)){
      const data=await issues.readStepFile(project,issueId,step.number,f.name)
      reports.push({step:step.number,name:f.name,text:data.bytes?.toString('utf8')??null})
    }
    return summariseIssue({issue,reports,runs:await listRuns(issue.path)})
   },getRun:detail,
   wasDeleted:async a=>{
    const file=path.join(issues.ISSUES_DIR,a.project,'.deleted-issues',a.issueId+'.json')
    try { const record=JSON.parse(await fs.readFile(file,'utf8'));return record.project===a.project&&record.id===a.issueId&&record.runIds?.includes(a.runId) } catch(e){if(e.code==='ENOENT')return false;throw e}
   },
   getCheckLog:async a=>readCheckLog({...a,issuePath:(await issues.getIssue(a.project,a.issueId)).path}),
   getStep:async a=>{
    const d=await full(a.project,a.issueId,a.runId)
    const response=await readStepResponse(issues,a.project,a.issueId,a.step).catch(()=>null)
    const step=summariseStep(d,a.step,response)
    if(!step)throw Object.assign(new Error(`no step ${a.step} in run ${a.runId}`),{status:404})
    return step
   },
   getFile:async a=>{
    const data=await issues.readStepFile(a.project,a.issueId,a.step,a.name)
    const text=data.bytes?.toString('utf8')??null
    if(text&&text.length>200000)throw Object.assign(new Error('file exceeds 200000 characters; read it on the panel'),{status:413})
    return {step:a.step,name:a.name,text}
   },
   preview:async a=>{
    const issue=await issues.getIssue(a.project,a.issueId)
    return summarisePreview(await preview(a.playbook,{configRoot,issue,project:{id:a.project,path:projectPath(a.project)},runOptions:a.runOptions??{},deliveryActions:supervisor.deliveryActions,
     selectRelease:()=>selectStagedRelease({project:a.project,projectPath:projectPath(a.project),listIssues:(p,o)=>issues.listIssues(p,o)}),
     pathOverlap:args=>supervisor.pathOverlap({project:a.project,projectPath:projectPath(a.project),issuePath:issue.path,...args}),
     moduleLocks:()=>supervisor.moduleLockReading({project:a.project,issueId:a.issueId})}))
   },
   launchState:async p=>{
    const resolved=await resolveWithRelease(p.playbook,{root:configRoot,runOptions:p.runOptions,projectId:p.project},()=>selectStagedRelease({project:p.project,projectPath:projectPath(p.project),listIssues:(q,o)=>issues.listIssues(q,o)}))
    if(!resolved.ok)return {blockedReason:resolved.errors.map(e=>e.message).join('; ')}
    if(resolved.resolved.configHash!==p.configHash)return {blockedReason:'Configuration changed since preview; preview again before starting'}
    return inspectLaunchState({projectPath:projectPath(p.project),workspace:resolved.resolved.workspace,configHash:p.configHash})
   },
   start:async p=>{
    try {return await supervisor.start({project:p.project,issueId:p.issueId,playbookId:p.playbook,expectConfigHash:p.configHash,runOptions:p.runOptions,configRoot,supervisorLaunchId:p.launchId})}
    catch(error){if([400,404,409,422].includes(error.status))error.started=false;throw error}
   },
   stop:a=>supervisor.stop(a),
   answer:a=>supervisor.answer(a),
   addNote:a=>mutate(()=>issues.createStep(a.project,a.issueId,{name:'supervisor-note',text:a.text,format:'md'})),
   createIssue:a=>mutate(()=>issues.createIssue(a.project,{input:a.input,openedBy:{user:'supervisor'},...(a.fromInquiry?{fromInquiry:a.fromInquiry}:{})})),
   // Inquiries (Phase 4): created here, previewed as analysis with the inquiry
   // flag; a preview that fails leaves a draft (an inquiry with no run).
   inquire:async a=>{
    const inquiry=await mutate(()=>issues.createInquiry(a.project,{question:a.question,relatedIssue:a.relatedIssue,createdBy:'supervisor'}))
    const summary=summarisePreview(await preview('analysis',{configRoot,issue:inquiry,project:{id:a.project,path:projectPath(a.project)},runOptions:a.runOptions??{},deliveryActions:supervisor.deliveryActions}))
    return {...summary,inquiryId:inquiry.id}
   },
   inquiryStatus:a=>supervisor.inquiryStatus(a),
   closeInquiry:a=>mutate(()=>supervisor.closeInquiry(a)),
   reopenInquiry:a=>mutate(()=>supervisor.reopenInquiry(a)),
   archive:a=>mutate(()=>issues.setIssueArchived(a.project,a.issueId,true)),
   setDisposition:a=>mutate(()=>issues.setIssueDisposition(a.project,a.issueId,{value:a.value,evidence:a.evidence,runId:a.runId??null,related:a.related??null,acceptRisks:a.acceptRisks??null,by:'supervisor'})),
   createFollowUps:a=>mutate(()=>issues.createFollowUps(a.project,a.issueId,a.runId,{by:{user:'supervisor'}})),
   markLanded:a=>mutate(()=>supervisor.markLanded(a))
  }}) } catch(e) { await lock.release();throw e }
 // A triage this supervisor started that closes autonomous starts its recommended
 // playbook through the supervisor's own start gate (auto-start.mjs).
 supervisor.setAutoStartGate?.(a=>service.autoStart(a))
 const shutdown=service.shutdown
 service.shutdown=async()=>{try {supervisor.setAutoStartGate?.(null);await shutdown()}finally{await lock.release()}}
 return service
}
