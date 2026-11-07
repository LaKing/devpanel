import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { engineFixture } from './fakes/fixture.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { runResult } from '../server/runtime/run-result.mjs'
import { decideAutoStart } from '../server/auto-start.mjs'
import { startStage } from './browser/stage.mjs'
import { openBrowser } from './browser/harness.mjs'

const start = f => startRun({ playbookId:f.playbookId, issue:{...f.issue,project:'devpanel-project'}, issuePath:f.issuePath, projectPath:f.projectPath, harnesses:f.harnesses, stepStore:f.stepStore, workspaceProvider:f.workspaceProvider, configRoot:f.configRoot, probe:f.probe, clock:f.clock, deliveryProvider:f.delivery })
const brief = {targetRole:'investigator',prompt:'Verify the reported write and cite the source evidence.'}
const withBrief = fn => turn => turn.role === 'coordinator' ? JSON.stringify(brief) : fn(turn)
// Every seat also sizes the issue and gives an autonomy verdict: autonomous only
// for an accepted report, needs-owner-input with one question for anything else.
const autonomyFor = disposition => disposition === 'accepted'
  ? {verdict:'autonomous',reason:'Only technical choices remain.'}
  : {verdict:'needs-owner-input',reason:'Nothing a run can do without the owner.',questions:[{id:'Q1',question:'Close this issue?',category:'missing-information',recommendation:'Close it.'}]}
const acceptedIssue = {key:'reported-write',kind:'bug',title:'Missing mode',description:'The key write has no mode.',evidence:['source.txt:1'],acceptanceCriteria:['Write keys with restricted permissions']}
const response = (disposition, sizing = {}) => ({disposition,reasoning:'Source establishes the claim.',response:disposition === 'needs-information' ? 'Which source revision contains the reported write?' : 'Checked the reported write at source.txt:1.',issues:disposition === 'accepted' ? [acceptedIssue] : [],
  size:sizing.size ?? 'minor',sizeReason:sizing.reason ?? 'One file changes.',affectedModules:sizing.modules ?? [],autonomy:sizing.autonomy ?? autonomyFor(disposition)})
const investigators = ['investigator','investigator-2']

export default async function(t) {
  t.section('coordinate once, then both investigator seats at once, and return the result directly')
  let f
  const seen=[]
  // Each investigator waits until the other has started: the run completes only
  // when both turns are in flight at the same time.
  const started=new Set()
  const overlapped={}
  let bothStarted
  const together=new Promise(resolve=>{bothStarted=resolve})
  f=await engineFixture({playbook:'triage',script:async turn=>{
    seen.push(turn)
    if (turn.role === 'coordinator') return JSON.stringify(brief)
    started.add(turn.role)
    if (started.size===2) bothStarted()
    // Run one after the other, the first seat would wait out the timer alone.
    overlapped[turn.role]=await Promise.race([together.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),3000))])
    const sizing=turn.role==='investigator'?{size:'minor',reason:'One write in one module.',modules:['modules/login','framework/session']}:{size:'major',reason:'It reaches two collections.',modules:['framework/session','modules/audit']}
    return JSON.stringify({...response('accepted',sizing),issues:[{key:'reported-write',kind:'bug',title:'Missing mode',description:'The key write has no mode.',evidence:['source.txt:1'],acceptanceCriteria:['Write keys with restricted permissions'],existingIssue:f.issue.id}]})
  }})
  const invoked=[]
  const invoke=f.harnesses.fake.invoke
  f.harnesses.fake.invoke=options=>{invoked.push(options);return invoke(options)}
  const e=await start(f)
  await e.drive()
  t.eq('one handoff, then both investigations',seen.map(s=>[s.role,s.stepId]).sort(),[['coordinator','brief'],['investigator','investigate'],['investigator-2','investigate-2']])
  t.eq('both investigator turns were in flight at once',[overlapped.investigator,overlapped['investigator-2']],[true,true])
  const events=(await fs.readFile(path.join(f.issuePath,'runs',e.runId,'events.jsonl'),'utf8')).split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean)
  t.ok('recorded as concurrent steps',events.some(ev=>(ev.type ?? ev.event?.type)==='concurrent-steps'))
  const turns=investigators.map(role=>e.run.steps.find(s=>s.role===role))
  t.ok('both outputs are recorded and valid',turns.every(s=>s && e.outputs[s.number]?.valid===true && e.outputs[s.number].contract==='triageDisposition'))
  t.eq('coordinator tools disabled through adapter mode',invoked[0].supervisorOnly,true)
  t.eq('coordinator starts outside source',invoked[0].cwd,path.join(e.run.workspace.scratchPath,'coordinator'))
  t.eq('coordinator receives no source tooling policy',invoked[0].tooling,null)
  t.ok('both investigators retain tools',invoked.slice(1).length===2 && invoked.slice(1).every(o=>o.supervisorOnly===false))
  t.ok('both investigators receive the handoff',seen.filter(s=>s.role!=='coordinator').every(s=>s.prompt.includes(brief.prompt)))
  t.ok('both prompts ask for an order-of-magnitude sizing, not a design',seen.filter(s=>s.role!=='coordinator').every(s=>s.prompt.includes('order-of-magnitude sizing, not a design') && s.prompt.includes('"Minor issue" or a "Major issue"') && s.prompt.includes('<collection>/<module>')))
  const sizing=e.run.reportDisposition.sizing
  t.eq('the seats disagree, so the decision is major',sizing.size,'major')
  t.eq('the modules are the union of both lists, the primary seat first',sizing.affectedModules,['modules/login','framework/session','modules/audit'])
  t.eq('a Major issue recommends plan-and-implement',sizing.recommendedPlaybook,'plan-and-implement')
  t.eq('each seat\'s sentence is kept',sizing.seats.map(s=>[s.role,s.size,s.reason]),[['investigator','minor','One write in one module.'],['investigator-2','major','It reaches two collections.']])
  t.eq('both seats were autonomous',sizing.autonomy.verdict,'autonomous')
  t.eq('the disposition is the primary seat\'s',e.run.reportDisposition.byStep,turns[0].number)
  const meta=JSON.parse(await fs.readFile(path.join(f.issuePath,'issue.json'),'utf8'))
  t.eq('the sizing is persisted on the issue, keyed by the run',[meta.sizing?.runId,meta.sizing?.size,meta.sizing?.affectedModules],[e.runId,'major',['modules/login','framework/session','modules/audit']])
  t.eq('the issue API reads it',(await f.issues.getIssue('devpanel-project',f.issue.id)).sizing?.recommendedPlaybook,'plan-and-implement')
  t.eq('coordinator does not receive scratch or infrastructure work instructions',seen[0].prompt.includes('Scratch directory for temporary files'),false)
  t.eq('coordinator is not instructed to read the manifest',seen[0].prompt.includes('Read window.json'),false)
  t.eq('run completes without implementing acceptance criteria',e.run.status,'completed')
  t.eq('recorded disposition satisfies closure',e.run.closure.conditions,{reportDispositionRecorded:true,deliveryCompleted:true})
  t.eq('no code candidate',e.run.revisions,[])
  t.eq('no closing candidate fingerprint',e.run.closure.revision,null)
  t.eq('no delivery calls',f.delivery.calls.length,0)
  t.eq('report links original issue',e.run.reportDisposition.issues[0].issueId,f.issue.id)
  t.eq('issue stays open',(await f.issues.getIssue('devpanel-project',f.issue.id)).status,'open')
  t.eq('human result',runResult(e.run,e.outputs).resultLabel,'Confirmed — ready for implementation')
  t.ok('prompt exposes output limits',seen[1].prompt.includes('at most 800 characters'))
  t.eq('default run guard is five minutes',e.run.budgets.limits.wallClockMinutes,5)
  // Effects replay must not append the same finding again.
  const before=(await fs.readdir(f.issuePath)).length
  await e.applyCoordinatorEffects()
  t.eq('publication is replay safe',(await fs.readdir(f.issuePath)).length,before)
  t.eq('the second seat published nothing of its own',e.run.reportDisposition.issues.length,1)
  t.eq('the issue sizing is not rewritten on replay',JSON.parse(await fs.readFile(path.join(f.issuePath,'issue.json'),'utf8')).sizing.at,meta.sizing.at)
  const legacy={...e.run,status:'blocked',outcome:'unresolved',blockedReason:'closure-conditions-unmet',closure:{conditions:{coordinatorConfirmation:false}}}
  t.eq('historical failure is explained without rewriting outcome',runResult(legacy,e.outputs).resultReason,'triage-completion-mismatch')
  t.eq('historical run reads incomplete',runResult(legacy,e.outputs).result,'incomplete')
  t.eq('runtime failures never become accepted',runResult({...legacy,blockedReason:'recovery-required'},e.outputs).result,'incomplete')
  await releaseWorkspace(e)

  t.section('the browser leads with a short result and collapses technical detail')
  const stage=await startStage()
  const copied=path.join(stage.issuesDir,stage.project,f.issue.id)
  await fs.cp(f.issuePath,copied,{recursive:true})
  let browser=await openBrowser(`${stage.origin}/projects/${stage.project}/${f.issue.id}`,{token:stage.token})
  try {
    await browser.until(()=>browser.has('Confirmed — ready for implementation'))
    t.ok('result includes evidence',browser.all('.status')[0]?.textContent.includes('source.txt:1'))
    t.ok('the issue page shows the size',browser.has('Major issue'))
    t.ok('each seat\'s sentence',browser.has('One write in one module.') && browser.has('It reaches two collections.'))
    t.ok('the modules',browser.has('modules/audit'))
    t.ok('and offers the recommended playbook',browser.has('Start Plan and implement'))
    t.eq('technical details start collapsed',browser.all('.tech')[0]?.open,false)
    t.ok('the timeline is on screen without expanding anything',browser.all('.turn').length>0)
    t.eq('no client errors',browser.problems,[])
  } finally { browser.close() }
  const old={...legacy,workspace:{...e.run.workspace,state:'retained',retainedReason:'unsuccessful tactical run retained for recovery'}}
  await fs.writeFile(path.join(copied,'runs',e.runId,'run.json'),JSON.stringify(old))
  browser=await openBrowser(`${stage.origin}/projects/${stage.project}/${f.issue.id}`,{token:stage.token})
  try {
    await browser.until(()=>browser.has('Confirmed — triage completion blocked'))
    t.ok('old closure bug is explained',browser.all('.status')[0]?.textContent.includes('implementation criteria'))
    browser.all('.tech')[0].open=true
    t.ok('retained snapshot is not called a candidate',browser.has('No code candidate was produced.'))
    t.eq('no false candidate claim',browser.has('The candidate this run produced'),false)
  } finally { browser.close();await stage.stop() }

  t.section('unanswered questions and invalid reports end without more agents')
  for (const disposition of ['needs-information','rejected','no-findings']) {
    const f=await engineFixture({playbook:'triage',script:withBrief(()=>JSON.stringify(response(disposition)))})
    const e=await start(f);await e.drive()
    t.eq(`${disposition} completes without coordinator re-review`,e.run.steps.length,3)
    t.eq(`${disposition} is not autonomous`,e.run.reportDisposition.sizing.autonomy.verdict,'needs-owner-input')
    t.eq(`${disposition} is a completed assessment`,e.run.status,'completed')
    t.eq(`${disposition} creates no issues`,e.run.reportDisposition.issues,[])
    t.eq(`${disposition} is preserved in the result`,runResult(e.run,e.outputs).result,disposition)
    await releaseWorkspace(e)
  }

  t.section('verbosity is bounded and repair cannot loop')
  const bad={...response('no-findings'),response:'x'.repeat(801)}
  const b=await engineFixture({playbook:'triage',script:withBrief(()=>JSON.stringify(bad))})
  const be=await start(b);await be.drive()
  t.eq('one handoff and at most one repair per investigator seat',be.run.steps.length,5)
  t.eq('exhausted repair is a real failure',be.run.blockedReason,'protocol-repair-exhausted')
  t.eq('invalid output publishes nothing',be.run.reportDisposition,undefined)
  await releaseWorkspace(be)
  let calls=0
  const r=await engineFixture({playbook:'triage',script:withBrief(()=>++calls===1?'invalid':JSON.stringify(response('no-findings')))})
  const re=await start(r);await re.drive()
  t.eq('valid investigator repair completes',re.run.status,'completed')
  t.eq('no extra confirmation invocation: two seats and one repair',calls,3)
  await releaseWorkspace(re)

  t.section('both seats can repair once without an extra confirmation')
  const repaired=await engineFixture({playbook:'triage',script:turn=>turn.attempt===1?'invalid':JSON.stringify(turn.role==='coordinator'?brief:response('no-findings'))})
  const repairedEngine=await start(repaired);await repairedEngine.drive()
  t.eq('six turns, including three repairs',repairedEngine.run.steps.length,6)
  t.eq('final answer at the turn cap completes',repairedEngine.run.status,'completed')
  await releaseWorkspace(repairedEngine)

  t.section('both seats minor reads minor and recommends prompt; one seat alone sizes alone')
  {
    const m=await engineFixture({playbook:'triage',script:withBrief(turn=>JSON.stringify(response('accepted',{size:'minor',reason:`${turn.role} sees one write`,modules:turn.role==='investigator'?['modules/a']:['modules/a','modules/b']})))})
    const me=await start(m);await me.drive()
    t.eq('minor only when both say minor',me.run.reportDisposition.sizing.size,'minor')
    t.eq('a Minor issue recommends prompt',me.run.reportDisposition.sizing.recommendedPlaybook,'prompt')
    t.eq('union without repeats',me.run.reportDisposition.sizing.affectedModules,['modules/a','modules/b'])
    await releaseWorkspace(me)
    const one=await engineFixture({playbook:'triage',script:withBrief(()=>JSON.stringify(response('accepted',{size:'minor',modules:['modules/a']})))})
    const oe=await startRun({ playbookId:one.playbookId, issue:{...one.issue,project:'devpanel-project'}, issuePath:one.issuePath, projectPath:one.projectPath, harnesses:one.harnesses, stepStore:one.stepStore, workspaceProvider:one.workspaceProvider, configRoot:one.configRoot, probe:one.probe, clock:one.clock, deliveryProvider:one.delivery, runOptions:{participants:{'investigator-2':null}}, expectConfigHash:(await resolvePlaybook('triage',{root:one.configRoot,runOptions:{participants:{'investigator-2':null}}})).resolved.configHash })
    await oe.drive()
    t.eq('without the second seat, two turns',oe.run.steps.map(s=>s.role),['coordinator','investigator'])
    t.eq('and the single seat sizes the issue',[oe.run.reportDisposition.sizing.size,oe.run.reportDisposition.sizing.seats.length],['minor',1])
    await releaseWorkspace(oe)
  }

  t.section('a seat in repair holds the disposition until both are valid')
  {
    let second=0
    const h=await engineFixture({playbook:'triage',script:withBrief(turn=>turn.role==='investigator-2'&&++second===1?'invalid':JSON.stringify(response('accepted',{size:turn.role==='investigator'?'minor':'major'})))})
    const he=await start(h);await he.drive()
    t.eq('the repaired second seat counts',[he.run.status,he.run.reportDisposition.sizing.size],['completed','major'])
    t.eq('three investigator turns',he.run.steps.filter(s=>s.role!=='coordinator').length,3)
    await releaseWorkspace(he)
  }

  t.section('a repaired second seat replaces its first answer in the size, the modules, the verdict and autoStart')
  {
    let second=0
    const ownerQuestion={verdict:'needs-owner-input',reason:'The owner must choose.',questions:[{id:'Q1',question:'Which collection owns this?',category:'missing-information',recommendation:'c.'}]}
    const r=await engineFixture({playbook:'triage',script:withBrief(turn=>{
      if (turn.role==='investigator') return JSON.stringify(response('accepted',{size:'minor',modules:['c/primary'],autonomy:{verdict:'autonomous',reason:'technical only'}}))
      // First answer: schema-valid but contradicts itself (autonomous on a rejected report).
      if (++second===1) return JSON.stringify(response('rejected',{size:'minor',modules:['c/initial'],autonomy:{verdict:'autonomous',reason:'nothing to ask'}}))
      return JSON.stringify(response('accepted',{size:'major',modules:['c/repaired'],autonomy:ownerQuestion}))
    })})
    const re=await startRun({ playbookId:r.playbookId, issue:{...r.issue,project:'devpanel-project'}, issuePath:r.issuePath, projectPath:r.projectPath, harnesses:r.harnesses, stepStore:r.stepStore, workspaceProvider:r.workspaceProvider, configRoot:r.configRoot, probe:r.probe, clock:r.clock, deliveryProvider:r.delivery, runOptions:{autoStart:true}, expectConfigHash:(await resolvePlaybook('triage',{root:r.configRoot,runOptions:{autoStart:true}})).resolved.configHash })
    await re.drive()
    const sizing=re.run.reportDisposition?.sizing
    t.eq('the second seat was asked to repair',second,2)
    t.eq('the repaired answer counts: major, plan-and-implement, needs-owner-input',[sizing?.size,sizing?.recommendedPlaybook,sizing?.autonomy?.verdict],['major','plan-and-implement','needs-owner-input'])
    t.eq('the modules are the union with the repaired list, not the first one',sizing?.affectedModules,['c/primary','c/repaired'])
    t.eq('the seat record points at the repair',sizing?.seats?.find(s=>s.role==='investigator-2')?.step,re.run.steps.filter(s=>s.role==='investigator-2').at(-1).number)
    const meta=JSON.parse(await fs.readFile(path.join(r.issuePath,'issue.json'),'utf8'))
    t.eq('issue.json holds the repaired decision',[meta.sizing?.size,meta.sizing?.affectedModules],['major',['c/primary','c/repaired']])
    t.eq('and no automatic start follows',decideAutoStart(re.snapshot,re.run).start,false)
    await releaseWorkspace(re)
  }

  t.section('autonomous on a disposition other than accepted contradicts itself')
  {
    let tries=0
    const c=await engineFixture({playbook:'triage',script:withBrief(turn=>JSON.stringify(response('rejected',turn.role==='investigator'&&++tries===1?{autonomy:{verdict:'autonomous',reason:'nothing to ask'}}:{})))})
    const ce=await start(c);await ce.drive()
    const repair=ce.run.steps.find(s=>s.role==='investigator'&&s.attempt===2)
    t.ok('it goes to protocol repair',Boolean(repair))
    t.eq('the repaired verdict is recorded',ce.run.reportDisposition.sizing.autonomy.verdict,'needs-owner-input')
    await releaseWorkspace(ce)
  }

  t.section('disposition-only completion cannot authorize code delivery')
  const configFile=path.join(f.configRoot,'playbooks/triage.yaml')
  const config=YAML.parse(await fs.readFile(configFile,'utf8'));config.delivery={action:'commit'}
  await fs.writeFile(configFile,YAML.stringify(config))
  t.eq('code delivery override rejected',(await resolvePlaybook('triage',{root:f.configRoot})).ok,false)
}
