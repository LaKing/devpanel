import os from 'node:os'
import { fingerprint, escapingLinks } from './fingerprint.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { runProcess } from './process.mjs'
import { stagedReleasePassed } from './run-result.mjs'
import { writeJson, writeAtomic } from './persistence.mjs'
import { withLock } from './lock.mjs'
import { hostConfigDir, HOST_CONFIG_ENV } from '../config/host-config.mjs'
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const withReleaseLock=(issuePath,fn)=>withLock(path.join(path.dirname(issuePath),'.staging-deployment.lock'),{purpose:'release',waitMs:0},()=>withLock(path.join(path.dirname(issuePath),'.actions','.lock'),{purpose:'release-project-exclusion',waitMs:0},fn))
const phases=['inspect','checkpoint','verifyCheckpoint','apply','verifyRelease','restart','observe','test']

/**
 * The environment of every installed release command. It carries the run's host
 * directory as an absolute path, so a site script reads its targets from the
 * same host-config the loader uses (tools/releases/host_targets.py), at release time.
 */
export const releaseEnvironment=({hostDir,runId,archive,sha256,environment,stateDir,startedAt})=>({...process.env,[HOST_CONFIG_ENV]:hostDir,DEVPANEL_RELEASE_ID:runId,DEVPANEL_RELEASE_ARCHIVE:archive,DEVPANEL_RELEASE_SHA256:sha256,DEVPANEL_RELEASE_ENVIRONMENT:environment,DEVPANEL_RELEASE_STATE_DIR:stateDir,DEVPANEL_RELEASE_STARTED_AT:startedAt})

export async function stagedRelease (projectDir, releaseId) {
  if(!/^[a-zA-Z0-9-]+$/.test(releaseId??''))throw new Error('a staged releaseId is required')
  for(const entry of await fs.readdir(projectDir,{withFileTypes:true})) {
    if(!entry.isDirectory()||!/^\d{4}-\d{2}-\d{2}-/.test(entry.name))continue
    const dir=path.join(projectDir,entry.name,'runs',releaseId)
    let receipt
    try { receipt=JSON.parse(await fs.readFile(path.join(dir,'release.json'),'utf8')) }catch(e){if(e.code==='ENOENT')continue;throw e}
    const run=JSON.parse(await fs.readFile(path.join(dir,'run.json'),'utf8'))
    if(!stagedReleasePassed(receipt,run))throw new Error('staged release has not passed its coordinator and all verifiers')
    const archive=path.join(dir,'artifacts','release.tar')
    if(sha(await fs.readFile(archive))!==receipt.sha256)throw new Error('staged release artifact changed')
    return {...receipt,archive}
  }
  throw new Error('staged release not found in this project')
}

// Installed configuration only. Models cannot supply command text, destinations
// or filesystem roots. Persist intent before every external operation; a crash
// requires recovery rather than replaying a possibly completed mutation.
export async function executeRelease ({issuePath,runId,workspace,snapshot,signal,execute=runProcess,verifySource=null,onUpdate=null,hostDir=hostConfigDir(),coverage:readCoverage=null}) {
  const dir=path.join(issuePath,'runs',runId),file=path.join(dir,'release.json')
  return withReleaseLock(issuePath,async()=>{
    let previous
    try{previous=JSON.parse(await fs.readFile(file,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
    if(previous){ if(previous.status==='running'){previous.status='recovery-required';await writeJson(file,previous)} return previous }
    const infra=snapshot.infrastructure,tactic=snapshot.tactic
    if(tactic==='deployment' && (infra?.deployments?.length??0)>1 && !snapshot.runOptions.environment)throw new Error('Select a deployment environment explicitly')
    const environment=snapshot.runOptions.environment??(tactic==='staging'?infra?.staging?.id:infra?.deployments?.[0]?.id)
    const allowed=tactic==='staging'?[infra?.staging?.id]:(infra?.deployments??[]).map(x=>x.id)
    const config=infra?.release?.targets?.[environment]
    if(!allowed.includes(environment)||!config)throw new Error('release target is not configured')
    for(const id of [...phases,'restore','verifyRestore'])if(!config.commands[id]?.run)throw new Error(`release command missing: ${id}`)
    if(verifySource)await verifySource()
    if((await escapingLinks(workspace.path)).length)throw new Error('release source has external symlinks; materialize them before staging')
    const sourceFingerprint=await fingerprint(workspace.path,{strict:true,excludes:['.git']})
    await fs.mkdir(path.join(dir,'artifacts'),{recursive:true})
    const archive=path.join(dir,'artifacts','release.tar')
    let sourceRelease=null
    if(tactic==='deployment'){
      const staged=await stagedRelease(path.dirname(issuePath),snapshot.runOptions.releaseId)
      await fs.copyFile(staged.archive,archive);sourceRelease=staged.runId
    }else{
      const result=await execute({command:'tar',args:['--exclude=.git','-cf',archive,'-C',workspace.path,'.'],signal,maxBuffer:1048576})
      if(result.cancelled||result.code!==0)throw new Error('could not package source snapshot')
    }
    const reconstruction=await fs.mkdtemp(path.join(os.tmpdir(),'devpanel-release-verify-'))
    try {
      const extracted=await runProcess({command:'tar',args:['-xpf',archive,'-C',reconstruction],signal,maxBuffer:1048576})
      if(extracted.code!==0||extracted.cancelled)throw new Error('release archive could not be reconstructed')
      if(tactic==='staging' && (await fingerprint(reconstruction,{strict:true,excludes:['.git']})).fingerprint!==sourceFingerprint.fingerprint)throw new Error('release archive does not reproduce the selected source snapshot')
    } finally { await fs.rm(reconstruction,{recursive:true,force:true}) }
    if(verifySource)await verifySource()
    const digest=sha(await fs.readFile(archive))
    // What this snapshot carries of the project's delivered runs (staging-coverage.mjs).
    // Read here, where the worktree is proved to be the archive. It records and never gates.
    const coverage=tactic==='staging'&&readCoverage?await readCoverage({snapshotPath:workspace.path}).catch(error=>({error:error.message})):null
    const state={runId,tactic,environment,sourceRelease,sha256:digest,archive,startedAt:new Date().toISOString(),status:'running',commands:[],checkpointVerified:false,mutated:false,ownership:config.ownership,rollback:config.rollback,...(coverage?{coverage}:{})}
    await writeJson(file,state)
    const env=releaseEnvironment({hostDir,runId,archive,sha256:digest,environment,stateDir:dir,startedAt:state.startedAt})
    const command=async(id,recovery=false)=>{
      const spec=config.commands[id]
      const record={id,status:'running',startedAt:new Date().toISOString()};state.commands.push(record);await writeJson(file,state)
      if(onUpdate)await onUpdate(state)
      try {
        if(sha(await fs.readFile(archive))!==digest)throw new Error('release archive changed during operation')
        const timeout=AbortSignal.timeout(spec.timeoutSeconds*1000)
        const result=await execute({command:'/bin/bash',args:['-e','-o','pipefail','-c',spec.run],cwd:config.workdir,env,signal:recovery?timeout:signal?AbortSignal.any([signal,timeout]):timeout,maxBuffer:1048576})
        Object.assign(record,{status:result.code===0&&!result.cancelled?'completed':'failed',code:result.code,cancelled:result.cancelled??false,stdout:result.stdout,stderr:result.stderr,truncated:result.truncated??false})
      }catch(e){record.status='failed';record.error=e.message}
      record.endedAt=new Date().toISOString()
      record.logFile=path.join(path.dirname(file),'evidence','release',`${state.commands.length}-${id}.log`)
      await writeAtomic(record.logFile,`${record.stdout??''}\n${record.stderr??''}\n${record.error??''}`)
      await writeJson(file,state)
      if(onUpdate)await onUpdate(state)
      return record.status==='completed'
    }
    for(const id of phases){
      // Checkpoint procedures may stop services to obtain consistent database state.
      // A failed/interrupted checkpoint is an external effect, not a harmless preview.
      if(id==='checkpoint'||id==='apply'){state.mutated=true;await writeJson(file,state)}
      if(!await command(id)){
        state.status='failed'
        if(state.mutated){
          if(config.rollback==='automatic'&&state.checkpointVerified){
            const restored=await command('restore',true)
            const verified=restored&&await command('verifyRestore',true)
            state.status=verified?'rolled-back':'recovery-required'
          }else state.status='recovery-required'
        }
        break
      }
      if(id==='verifyCheckpoint'){state.checkpointVerified=true;await writeJson(file,state)}
    }
    if(state.status==='running')state.status='completed'
    state.endedAt=new Date().toISOString();await writeJson(file,state)
    return state
  })
}

/** Failed post-release verification uses the same installed recovery policy. */
export async function recoverRelease ({issuePath,runId,snapshot,reason,execute=runProcess,hostDir=hostConfigDir()}) {
  const file=path.join(issuePath,'runs',runId,'release.json')
  return withReleaseLock(issuePath,async()=>{
    const state=JSON.parse(await fs.readFile(file,'utf8'))
    if(state.status!=='completed')return state
    state.status='recovery-required';state.recoveryReason=reason;await writeJson(file,state)
    const config=snapshot.infrastructure.release.targets[state.environment]
    if(config.rollback!=='automatic'||!state.checkpointVerified)return state
    const env=releaseEnvironment({hostDir,runId,archive:state.archive,sha256:state.sha256,environment:state.environment,stateDir:path.dirname(file),startedAt:state.startedAt})
    for(const id of ['restore','verifyRestore']){
      const spec=config.commands[id],record={id,status:'running',startedAt:new Date().toISOString()}
      state.commands.push(record);await writeJson(file,state)
      try{
        const result=await execute({command:'/bin/bash',args:['-e','-o','pipefail','-c',spec.run],cwd:config.workdir,env,signal:AbortSignal.timeout(spec.timeoutSeconds*1000),maxBuffer:1048576})
        Object.assign(record,{status:result.code===0&&!result.cancelled?'completed':'failed',code:result.code,stdout:result.stdout,stderr:result.stderr,truncated:result.truncated??false})
      }catch(e){record.status='failed';record.error=e.message}
      record.endedAt=new Date().toISOString()
      record.logFile=path.join(path.dirname(file),'evidence','release',`${state.commands.length}-${id}.log`)
      await writeAtomic(record.logFile,`${record.stdout??''}\n${record.stderr??''}\n${record.error??''}`)
      await writeJson(file,state)
      if(record.status!=='completed')return state
    }
    state.status='rolled-back';state.endedAt=new Date().toISOString();await writeJson(file,state);return state
  })
}
