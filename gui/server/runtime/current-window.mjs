import { archiveState } from '../issue-archive.mjs'
import { packedSummaries } from '../issue-bundle.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { constants } from 'node:fs'
import { writeJson, writeAtomic } from './persistence.mjs'
import { priorRunSources } from './prior-runs.mjs'
import { readIssueSizing } from './triage-sizing.mjs'
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
  const inputBudget={maxFiles:limits.maxInputFiles??100,maxBytes:limits.maxInputBytes??26214400,maxFileBytes:limits.maxInputFileBytes??26214400,bytes:0,files:0,omittedFiles:0,excludedAgentFolders:0}
  const agentNumbers=new Set(), reportNumbers=new Set()
  let reservations=[]
  try { reservations=JSON.parse(await fs.readFile(path.join(issuePath,'.step-reservations.json'),'utf8')) } catch(e){if(e.code!=='ENOENT')throw e}
  for(const r of reservations) {
    const number=String(r.number).padStart(3,'0')
    // Published findings and operation receipts are new report inputs, not
    // the source issue's old agent conversation. Recognize older receipts too.
    if(r.origin==='external-report' || /^(finding|staging-deployment|staging-coverage):/.test(r.invocationId??'')) reportNumbers.add(number)
    else if(r.invocationId || r.origin==='agent-turn') agentNumbers.add(number)
  }
  const runs=await fs.readdir(path.join(issuePath,'runs'),{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e})
  for(const r of runs.filter(r=>r.isDirectory()&&!r.name.startsWith('worktree-')&&!r.name.startsWith('workspace-'))){
    try { const state=JSON.parse(await fs.readFile(path.join(issuePath,'runs',r.name,'run.json'),'utf8'));for(const step of state.steps??[])if(step.role!=='operator')agentNumbers.add(String(step.number).padStart(3,'0')) }catch(e){if(e.code!=='ENOENT')throw e}
  }
  // Keep the initial report, then the newest notes when capture limits apply.
  // Old agent responses are still excluded by provenance below.
  if(!previous)for(const folder of (await fs.readdir(issuePath,{withFileTypes:true})).sort((a,b)=>(a.name==='000-report'?-1:b.name==='000-report'?1:b.name.localeCompare(a.name)))) {
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
        const bytes=Buffer.alloc(st.size)
        let read=0
        while(read<bytes.length){const result=await handle.read(bytes,read,bytes.length-read,read);if(!result.bytesRead)break;read+=result.bytesRead}
        if(read!==st.size||(await handle.stat()).size!==st.size){inputBudget.omittedFiles++;continue}
        const target=path.join(dir,'input',folder.name,file)
        await writeAtomic(target,bytes);inputs.push({file:target,source:src,sha256:hash(bytes),origin:reportNumbers.has(folder.name.slice(0,3))?'external-report':'human-input'})
        inputBudget.bytes+=bytes.length;inputBudget.files++
      }catch(e){if(['ELOOP','EISDIR','ENOENT'].includes(e.code)){inputBudget.omittedFiles++;continue}throw e}
      finally{await handle?.close()}
    }
  }
  // runOptions.accumulate: earlier runs' products (prior-runs.mjs), after the human
  // input so a large patch cannot crowd out the report or a note under the budget.
  let accumulated=null
  if(accumulate&&!previous){
    accumulated={runs:[],omitted:0}
    for(const item of await priorRunSources(issuePath,runId,reservations)){
      let bytes=item.bytes
      if(!bytes){
        let handle
        try{handle=await fs.open(item.source,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);const st=await handle.stat();if(st.isFile()&&st.size<=inputBudget.maxFileBytes)bytes=await handle.readFile()}
        catch(e){if(!['ELOOP','EISDIR','ENOENT'].includes(e.code))throw e}
        finally{await handle?.close()}
        if(!bytes)continue
      }
      if(inputBudget.files>=inputBudget.maxFiles||bytes.length>inputBudget.maxBytes-inputBudget.bytes){inputBudget.omittedFiles++;accumulated.omitted++;continue}
      const target=path.join(dir,'input','prior-runs',item.runId,item.name)
      await writeAtomic(target,bytes);inputs.push({file:target,source:item.source??path.join(issuePath,'runs',item.runId),sha256:hash(bytes),origin:'prior-run',runId:item.runId})
      inputBudget.bytes+=bytes.length;inputBudget.files++
      if(!accumulated.runs.includes(item.runId))accumulated.runs.push(item.runId)
    }
  }
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
  const window={id,manifest:path.join(dir,'window.json'),sizing,inputBudget:previous?.inputBudget??inputBudget,previous:previous?.id??null,reason,startedAt,capturedAt:new Date().toISOString(),source:{path:workspace.path,baseCommit:workspace.baseCommit,base:workspace.base},files,inputs:previous?.inputs??inputs,accumulated:previous?previous.accumulated??null:accumulated,issues,coverage:'Source is the recorded snapshot; logs are bounded captures at the recorded times, not a continuous live view.'}
  await writeJson(path.join(dir,'window.json'),window)
  return window
}
