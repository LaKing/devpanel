import os from 'node:os'
import { fingerprint, escapingLinks, treeIdentity } from './fingerprint.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { runProcess } from './process.mjs'
import { stagedReleasePassed } from './run-result.mjs'
import { writeJson, writeAtomic } from './persistence.mjs'
import { withLock } from './lock.mjs'
import { hostConfigDir, HOST_CONFIG_ENV } from '../config/host-config.mjs'
import { planOf } from '../config/release-plan.mjs'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
/**
 * The project's release lock and its project-action lock, from the folder holding
 * the run: an issue, or a full verification run home (issues/<project>/.verification-<date>),
 * whose parent is the same project folder, so both exclude each other.
 */
export const releaseLockPaths=(issuePath)=>({release:path.join(path.dirname(issuePath),'.staging-deployment.lock'),actions:path.join(path.dirname(issuePath),'.actions','.lock')})
const withReleaseLock=(issuePath,fn)=>{const locks=releaseLockPaths(issuePath);return withLock(locks.release,{purpose:'release',waitMs:0},()=>withLock(locks.actions,{purpose:'release-project-exclusion',waitMs:0},fn))}
const phases=['inspect','checkpoint','verifyCheckpoint','apply','verifyRelease','restart','observe','test']

/**
 * The environment of every installed release command. It carries the run's host
 * directory as an absolute path, so a site script reads its targets from the
 * same host-config the loader uses (tools/releases/host_targets.py), at release time.
 */
export const releaseEnvironment=({hostDir,runId,archive,sha256,environment,stateDir,startedAt})=>({...process.env,[HOST_CONFIG_ENV]:hostDir,DEVPANEL_RELEASE_ID:runId,DEVPANEL_RELEASE_ARCHIVE:archive,DEVPANEL_RELEASE_SHA256:sha256,DEVPANEL_RELEASE_ENVIRONMENT:environment,DEVPANEL_RELEASE_STATE_DIR:stateDir,DEVPANEL_RELEASE_STARTED_AT:startedAt})

/**
 * A green staging release of this project, by its run id: in an issue folder, or
 * in a packed issue's bundle. A packed release's archive is extracted to
 * `extractTo` and verified against its recorded hash before it is returned, so
 * only the staged bytes are ever promoted.
 */
export async function stagedRelease (projectDir, releaseId, { extractTo = null, findPacked = defaultFindPacked } = {}) {
  if(!/^[a-zA-Z0-9-]+$/.test(releaseId??''))throw new Error('a staged releaseId is required')
  for(const entry of await fs.readdir(projectDir,{withFileTypes:true})) {
    // An issue, or a full verification run home (issues.js HOME_PATTERN) whose staging release a production run may promote.
    if(!entry.isDirectory()||!(/^\d{4}-\d{2}-\d{2}-/.test(entry.name)||/^\.verification-\d{4}-\d{2}-\d{2}$/.test(entry.name)))continue
    const dir=path.join(projectDir,entry.name,'runs',releaseId)
    let receipt
    try { receipt=JSON.parse(await fs.readFile(path.join(dir,'release.json'),'utf8')) }catch(e){if(e.code==='ENOENT')continue;throw e}
    const run=JSON.parse(await fs.readFile(path.join(dir,'run.json'),'utf8'))
    if(!stagedReleasePassed(receipt,run))throw new Error('staged release has not passed its coordinator and all verifiers')
    const archive=path.join(dir,'artifacts','release.tar')
    if(sha(await fs.readFile(archive))!==receipt.sha256)throw new Error('staged release artifact changed')
    return {...receipt,archive}
  }
  const packed=findPacked?await findPacked(path.basename(projectDir),releaseId):null
  if(packed){
    const {issue,run}=packed
    if(!stagedReleasePassed(run.release,run))throw new Error('staged release has not passed its coordinator and all verifiers')
    if(!extractTo)throw new Error('staged release is in an archived issue and no extraction file was given')
    await fs.mkdir(path.dirname(extractTo),{recursive:true})
    await extractMember(issue.location,`${issue.id}/runs/${releaseId}/artifacts/release.tar`,extractTo)
    if(sha(await fs.readFile(extractTo))!==run.release.sha256)throw new Error('staged release artifact changed')
    return {...run.release,archive:extractTo,packed:{issueId:issue.id,bundle:issue.location}}
  }
  throw new Error('staged release not found in this project')
}

// A project the issue store does not know (a fixture directory) has no packed issues.
const defaultFindPacked=async(project,releaseId)=>(await import('../release-selection.mjs')).findPackedRelease(project,releaseId).catch(()=>null)

/** One member of a packed issue's bundle, copied to a file (never through a shell). */
export async function extractMember (bundle, member, target) {
  const child = spawn('tar', ['-xzOf', bundle, member], { stdio: ['ignore', 'pipe', 'ignore'] })
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`could not extract ${member} from its issue bundle (tar exited ${code})`))))
  })
  await Promise.all([pipeline(child.stdout, createWriteStream(target)), exited])
}

/**
 * The receipt file of a stage: the first (or only) release of a run is
 * release.json; the production half of staging-then-production is its own receipt.
 */
export const receiptName = (stage) => stage === 'production-after-staging' ? 'release-production.json' : 'release.json'

/** Which stage a call names, from the run's release plan: `production` in a two-stage run is the second receipt. */
/** A command's log; the production half of a two-stage run keeps its own beside staging's. */
const releaseLog=(file,state,id)=>path.join(path.dirname(file),'evidence','release',`${state.stage==='production-after-staging'?'production-':''}${state.commands.length}-${id}.log`)

function stageOf (plan, stage) {
  if (plan.mode === 'staging-then-production') return stage === 'production' ? 'production-after-staging' : 'staging'
  return plan.mode === 'production' ? 'production' : 'staging'
}

/** What a release's bytes are, comparable with a checkout read through the same projection (release-selection.mjs). */
export async function contentIdentity (dir) {
  return identityOf(await fingerprint(dir, { strict: true, excludes: RELEASE_EXCLUDES }))
}

/** Packaging leaves out `.git` only, so the identity of a release does too (node_modules included). */
export const RELEASE_EXCLUDES = ['.git']
const identityOf = (read) => ({ identity: treeIdentity(read.entries), rule: read.rule })

// Installed configuration only. Models cannot supply command text, destinations
// or filesystem roots. Persist intent before every external operation; a crash
// requires recovery rather than replaying a possibly completed mutation.
export async function executeRelease ({issuePath,runId,workspace,snapshot,signal,execute=runProcess,verifySource=null,onUpdate=null,hostDir=hostConfigDir(),coverage:readCoverage=null,stage:requested=null,findPacked=undefined}) {
  const plan=planOf(snapshot),stage=stageOf(plan,requested)
  const dir=path.join(issuePath,'runs',runId),file=path.join(dir,receiptName(stage))
  return withReleaseLock(issuePath,async()=>{
    let previous
    try{previous=JSON.parse(await fs.readFile(file,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
    if(previous){ if(previous.status==='running'){previous.status='recovery-required';await writeJson(file,previous)} return previous }
    const infra=snapshot.infrastructure
    // A staging stage releases to the staging environment only, a production stage to a declared deployment only.
    const kind=stage==='staging'?'staging':'deployment'
    const environment=kind==='staging'?plan.staging:plan.production
    const allowed=kind==='staging'?[infra?.staging?.id]:(infra?.deployments??[]).map(x=>x.id)
    const config=infra?.release?.targets?.[environment]
    if(!environment||!allowed.includes(environment)||!config)throw new Error('release target is not configured')
    for(const id of [...phases,'restore','verifyRestore'])if(!config.commands[id]?.run)throw new Error(`release command missing: ${id}`)
    if(verifySource)await verifySource()
    if((await escapingLinks(workspace.path)).length)throw new Error('release source has external symlinks; materialize them before staging')
    const sourceFingerprint=await fingerprint(workspace.path,{strict:true,excludes:RELEASE_EXCLUDES})
    await fs.mkdir(path.join(dir,'artifacts'),{recursive:true})
    let archive=path.join(dir,'artifacts','release.tar')
    let sourceRelease=null
    if(stage==='production-after-staging'){
      // This run's own staging archive, the bytes its staging release and assessments passed.
      const staged=JSON.parse(await fs.readFile(path.join(dir,receiptName('staging')),'utf8'))
      if(staged.status!=='completed')throw new Error('the staging release of this run has not completed')
      if(sha(await fs.readFile(staged.archive))!==staged.sha256)throw new Error('staged release artifact changed')
      archive=staged.archive;sourceRelease=runId
    }else if(kind==='deployment'){
      const staged=await stagedRelease(path.dirname(issuePath),plan.releaseId,{extractTo:path.join(dir,'artifacts','staged-source.tar'),findPacked})
      if(staged.archive!==archive)await fs.copyFile(staged.archive,archive)
      sourceRelease=staged.runId
    }else{
      const result=await execute({command:'tar',args:['--exclude=.git','-cf',archive,'-C',workspace.path,'.'],signal,maxBuffer:1048576})
      if(result.cancelled||result.code!==0)throw new Error('could not package source snapshot')
    }
    const reconstruction=await fs.mkdtemp(path.join(os.tmpdir(),'devpanel-release-verify-'))
    try {
      const extracted=await runProcess({command:'tar',args:['-xpf',archive,'-C',reconstruction],signal,maxBuffer:1048576})
      if(extracted.code!==0||extracted.cancelled)throw new Error('release archive could not be reconstructed')
      if(kind==='staging' && (await fingerprint(reconstruction,{strict:true,excludes:['.git']})).fingerprint!==sourceFingerprint.fingerprint)throw new Error('release archive does not reproduce the selected source snapshot')
    } finally { await fs.rm(reconstruction,{recursive:true,force:true}) }
    if(verifySource)await verifySource()
    const digest=sha(await fs.readFile(archive))
    // What this snapshot carries of the project's delivered runs (staging-coverage.mjs).
    // Read here, where the worktree is proved to be the archive. It records and never gates.
    const coverage=kind==='staging'&&readCoverage?await readCoverage({snapshotPath:workspace.path}).catch(error=>({error:error.message})):null
    // What a staging release carries, so a later production start can match it to a checkout's content.
    const content=kind==='staging'?identityOf(sourceFingerprint):null
    const state={runId,tactic:kind,stage,environment,sourceRelease,sha256:digest,archive,startedAt:new Date().toISOString(),status:'running',commands:[],checkpointVerified:false,mutated:false,ownership:config.ownership,rollback:config.rollback,...(coverage?{coverage}:{}),...(content?{content}:{})}
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
      record.logFile=releaseLog(file,state,id)
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
export async function recoverRelease ({issuePath,runId,snapshot,reason,execute=runProcess,hostDir=hostConfigDir(),stage=null}) {
  const file=path.join(issuePath,'runs',runId,receiptName(stageOf(planOf(snapshot),stage)))
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
      record.logFile=releaseLog(file,state,id)
      await writeAtomic(record.logFile,`${record.stdout??''}\n${record.stderr??''}\n${record.error??''}`)
      await writeJson(file,state)
      if(record.status!=='completed')return state
    }
    state.status='rolled-back';state.endedAt=new Date().toISOString();await writeJson(file,state);return state
  })
}
