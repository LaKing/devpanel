import { archiveState } from '../issue-archive.mjs'
import { packedSummaries } from '../issue-bundle.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { constants } from 'node:fs'
import { writeJson, writeAtomic, readRegularFile } from './persistence.mjs'
import { priorRunSources, openAccumulateInput, inputFileLimit } from './prior-runs.mjs'
import { readIssueSizing } from './triage-sizing.mjs'
import { captureCycleEvidence } from './cycle-evidence.mjs'
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

export async function captureWindow ({ issuePath, runId, workspace, evidence = [], previous = null, reason = 'run start', limits = {}, accumulate = false }) {
  const startedAt=new Date().toISOString()
  const id=crypto.randomUUID()
  const dir=path.join(issuePath,'runs',runId,'evidence',id)
  const files=[]
  for(const source of evidence){
    const record={name:source.name,path:source.path,required:source.required===true,capturedAt:new Date().toISOString()}
    let handle
    try {
      handle=await fs.open(source.path,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW)
      const stat=await handle.stat()
      if(!stat.isFile())throw new Error('evidence is not a regular file')
      const limit=source.maxBytes??262144
      const bytes=Buffer.alloc(Math.min(stat.size,limit)); const read=await handle.read(bytes,0,bytes.length,Math.max(0,stat.size-bytes.length))
      const content=bytes.subarray(0,read.bytesRead)
      Object.assign(record,{bytes:content.length,totalBytes:stat.size,truncated:stat.size>content.length,modifiedAt:stat.mtime.toISOString(),sha256:hash(content),file:path.join(dir,`${source.name}.log`)})
      await writeAtomic(record.file,content)
    }catch(error){ record.error=error.message; if(source.required)throw new Error(`Required evidence ${source.name}: ${error.message}`) }
    finally{await handle?.close()}
    files.push(record)
  }
  const inputs=[]
  const inputBudget=windowBudget(limits)
  const { accumulated }=await walkWindowInputs({ issuePath, runId, budget: inputBudget, accumulate: accumulate&&!previous, human: !previous, read: true, onInput: async (input)=>{
    if(input.kind==='human'){
      const target=path.join(dir,'input',input.folder,input.file)
      await writeAtomic(target,input.bytes);inputs.push({file:target,source:input.source,sha256:hash(input.bytes),origin:input.origin})
    }else{
      const target=path.join(dir,'input','prior-runs',input.runId,input.name)
      await writeAtomic(target,input.bytes);inputs.push({file:target,source:input.source??path.join(issuePath,'runs',input.runId),sha256:hash(input.bytes),origin:'prior-run',runId:input.runId})
    }
  } })
  const issues=[]
  for(const entry of await fs.readdir(path.dirname(issuePath),{withFileTypes:true})){
    if(!entry.isDirectory()||!/^\d{4}-\d{2}-\d{2}-/.test(entry.name))continue
    const record=await fs.readFile(path.join(path.dirname(issuePath),entry.name,'issue.json'),'utf8').then(JSON.parse).catch(()=>null)
    if(record)issues.push({id:entry.name,name:record.name,status:record.status,kind:record.kind??null,archived:Boolean(await archiveState(path.join(path.dirname(issuePath),entry.name)))})
  }
  // Archived issues packed out of the project folder are still issues a report may duplicate.
  const known=new Set(issues.map(i=>i.id))
  for(const s of await packedSummaries(path.dirname(path.dirname(issuePath)),path.basename(path.dirname(issuePath)))){
    if(!known.has(s.issue.id))issues.push({id:s.issue.id,name:s.issue.name,status:s.issue.status,kind:s.issue.kind??null,archived:true})
  }
  // The issue's triage sizing as it stood when the run began (triage-sizing.mjs); a refresh keeps it.
  const sizing=previous?(previous.sizing??null):await readIssueSizing(issuePath)
  // The full verification evidence of a red issue, or of an inquiry's related one (cycle-evidence.mjs); a refresh keeps
  // the first capture. It never stops a run from starting: a failure is recorded and stated.
  let cycleEvidence=null
  if(previous)cycleEvidence=previous.cycleEvidence??null
  else try{cycleEvidence=await captureCycleEvidence({issuePath,dir,limits})}catch(e){
    // Nothing half-copied stays under the seat-readable evidence root without being listed.
    await fs.rm(path.join(dir,'cycle-evidence'),{recursive:true,force:true})
    cycleEvidence={state:'unreadable',files:[],note:`The full verification evidence could not be captured, and what was copied of it was removed: ${e.message}`}
  }
  const window={id,manifest:path.join(dir,'window.json'),sizing,inputBudget:previous?.inputBudget??inputBudget,previous:previous?.id??null,reason,startedAt,capturedAt:new Date().toISOString(),source:{path:workspace.path,baseCommit:workspace.baseCommit,base:workspace.base},files,inputs:previous?.inputs??inputs,accumulated:previous?previous.accumulated??null:accumulated,cycleEvidence,issues,coverage:'Source is the recorded snapshot; logs are bounded captures at the recorded times, not a continuous live view.'}
  await writeJson(path.join(dir,'window.json'),window)
  return window
}

/** A capture's input budget from the resolved windowLimits; the per-file limit is prior-runs.mjs inputFileLimit, which the start preview reads too. */
export const windowBudget=(limits={})=>({maxFiles:limits.maxInputFiles??100,maxBytes:limits.maxInputBytes??26214400,maxFileBytes:inputFileLimit(limits),bytes:0,files:0,omittedFiles:0,excludedAgentFolders:0})

/**
 * The inputs a capture takes, in its order and under its budget: the human input (report, newest
 * notes; earlier agent responses excluded by provenance), then, with `accumulate`, earlier runs'
 * products (prior-runs.mjs) charged the bytes the window would hold (the generated steps.md its
 * rendered length). `read: true` reads each file and hands it to onInput (captureWindow writes it);
 * `read: false` charges the size on the open handle and reads nothing, so the start preview
 * (retained-work.mjs) learns what this launch would include without writing anything.
 * Returns { accumulated, prior: [{ runId, name, source, state, size }] } where state is included,
 * files-budget-spent, bytes-budget-spent or the opener's skip.
 */
export async function walkWindowInputs({ issuePath, runId, budget, accumulate=false, human=true, read=true, onInput=async()=>{}, readRun }){
  const inputBudget=budget
  const agentNumbers=new Set(), reportNumbers=new Set()
  let reservations=[]
  try { reservations=JSON.parse(await readRegularFile(path.join(issuePath,'.step-reservations.json'),'utf8')) } catch(e){if(e.code!=='ENOENT')throw e}
  for(const r of reservations) {
    const number=String(r.number).padStart(3,'0')
    // Published findings and operation receipts are new report inputs, not
    // the source issue's old agent conversation. Recognize older receipts too.
    if(r.origin==='external-report' || /^(finding|staging-deployment|staging-coverage):/.test(r.invocationId??'')) reportNumbers.add(number)
    else if(r.invocationId || r.origin==='agent-turn') agentNumbers.add(number)
  }
  // Dry (read: false), an input error that would stop capture stops the walk here too: nothing
  // after it is said to be included (`stopped`; the later prior-run items read capture-fails).
  let stopped=null
  const runs=await fs.readdir(path.join(issuePath,'runs'),{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e})
  for(const r of runs.filter(r=>r.isDirectory()&&!r.name.startsWith('worktree-')&&!r.name.startsWith('workspace-'))){
    // Dry, a run record capture would choke on is where capture stops: the walk says so and goes on to list
    // what it can (every prior-run item then reads capture-fails), so readable findings stay visible.
    try { const state=JSON.parse(await readRegularFile(path.join(issuePath,'runs',r.name,'run.json'),'utf8'));for(const step of state.steps??[])if(step.role!=='operator')agentNumbers.add(String(step.number).padStart(3,'0')) }catch(e){if(e.code!=='ENOENT'){if(read)throw e;stopped??=Object.assign(e,{code:e.code??'unreadable-run-record'})}}
  }
  // Keep the initial report, then the newest notes when capture limits apply.
  // Old agent responses are still excluded by provenance below.
  if(human&&!stopped)humanInputs:for(const folder of (await fs.readdir(issuePath,{withFileTypes:true})).sort((a,b)=>(a.name==='000-report'?-1:b.name==='000-report'?1:b.name.localeCompare(a.name)))) {
    if(!folder.isDirectory()||!/^\d{3}-/.test(folder.name))continue
    if(agentNumbers.has(folder.name.slice(0,3))){inputBudget.excludedAgentFolders++;continue}
    const inputRank=file=>/^(note\.(md|txt)|response\.md)$/.test(file)?0:1
    for(const file of (await fs.readdir(path.join(issuePath,folder.name))).sort((a,b)=>inputRank(a)-inputRank(b)||a.localeCompare(b))) {
      if(file==='response.md'&&folder.name!=='000-report'&&!reportNumbers.has(folder.name.slice(0,3))){inputBudget.omittedFiles++;continue}
      const src=path.join(issuePath,folder.name,file)
      if(inputBudget.files>=inputBudget.maxFiles){inputBudget.omittedFiles++;continue}
      let handle
      try {
        handle=await fs.open(src,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW)
        const st=await handle.stat()
        if(!st.isFile()||st.size>inputBudget.maxFileBytes||st.size>inputBudget.maxBytes-inputBudget.bytes){inputBudget.omittedFiles++;continue}
        let bytes=null
        if(read){
          bytes=Buffer.alloc(st.size)
          let got=0
          while(got<bytes.length){const result=await handle.read(bytes,got,bytes.length-got,got);if(!result.bytesRead)break;got+=result.bytesRead}
          if(got!==st.size||(await handle.stat()).size!==st.size){inputBudget.omittedFiles++;continue}
        }
        await onInput({kind:'human',folder:folder.name,file,source:src,bytes,size:st.size,origin:reportNumbers.has(folder.name.slice(0,3))?'external-report':'human-input'})
        inputBudget.bytes+=st.size;inputBudget.files++
      }catch(e){if(['ELOOP','EISDIR','ENOENT'].includes(e.code)){inputBudget.omittedFiles++;continue}if(read)throw e;stopped=e;break humanInputs}
      finally{await handle?.close()}
    }
  }
  // runOptions.accumulate: earlier runs' products (prior-runs.mjs), after the human
  // input so a large patch cannot crowd out the report or a note under the budget.
  let accumulated=null
  const prior=[]
  if(accumulate){
    accumulated={runs:[],omitted:0}
    for(const item of await priorRunSources(issuePath,runId,reservations,{readRun})){
      if(stopped){prior.push({runId:item.runId,name:item.name,source:item.source??null,state:`capture-fails:${stopped.code??'error'}`,size:item.bytes?.length??null});continue}
      let bytes=item.bytes, size=item.bytes?.length??null
      if(!bytes){
        const opened=await openAccumulateInput(item.source,{maxFileBytes:inputBudget.maxFileBytes,read})
        if(opened.state==='error'){if(read)throw opened.error;stopped=opened.error;prior.push({runId:item.runId,name:item.name,source:item.source,state:`capture-fails:${opened.error.code??'error'}`,size:null});continue}
        if(opened.state!=='accepted'){prior.push({runId:item.runId,name:item.name,source:item.source,state:opened.state,size:opened.size});continue}
        bytes=opened.bytes??null; size=bytes?bytes.length:opened.size
      }
      if(inputBudget.files>=inputBudget.maxFiles||size>inputBudget.maxBytes-inputBudget.bytes){
        inputBudget.omittedFiles++;accumulated.omitted++
        prior.push({runId:item.runId,name:item.name,source:item.source??null,state:inputBudget.files>=inputBudget.maxFiles?'files-budget-spent':'bytes-budget-spent',size});continue
      }
      await onInput({kind:'prior-run',runId:item.runId,name:item.name,source:item.source,bytes,size})
      inputBudget.bytes+=size;inputBudget.files++
      prior.push({runId:item.runId,name:item.name,source:item.source??null,state:'included',size})
      if(!accumulated.runs.includes(item.runId))accumulated.runs.push(item.runId)
    }
  }
  return { accumulated, prior, stopped: stopped ? { code: stopped.code ?? null, message: stopped.message } : null }
}
