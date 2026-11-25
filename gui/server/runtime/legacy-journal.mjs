import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { withIssueLock } from '../issue-locks.mjs'
import { writeJson, readRegularFile } from './persistence.mjs'
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const dispositionName = 'legacy-journal-disposition.json'

async function evidence (dir) {
  const names = (await fs.readdir(dir)).filter(n => n !== dispositionName).sort()
  if (names.some(n => !['run.json','resolved-playbook.json','journal-recovery.json','outputs','artifacts'].includes(n))) throw new Error('Unexpected execution evidence; legacy retirement refused')
  const hashes = {}
  for (const name of names) {
    const file = path.join(dir,name), stat = await fs.lstat(file)
    if (['outputs','artifacts'].includes(name)) {
      if (!stat.isDirectory() || (await fs.readdir(file)).length) throw new Error('Run has execution artifacts')
      hashes[name] = 'empty-directory'
    } else {
      if (!stat.isFile()) throw new Error('Run evidence must be regular files')
      hashes[name] = digest(await fs.readFile(file))
    }
  }
  const run = JSON.parse(await fs.readFile(path.join(dir,'run.json'),'utf8'))
  if (run.status !== 'failed' || !/^base policy "head" requires a clean checkout,/.test(run.blockedReason ?? '') ||
      !run.endedAt || run.phase?.id || run.workspace?.path || run.workspace?.baseCommit ||
      run.delivery || run.closure || run.release || run.integrity || run.currentWindow || run.recovery?.required ||
      ['steps','revisions','approvals','checkResults'].some(k => !Array.isArray(run[k]) || run[k].length) ||
      !Object.keys(run.participants ?? {}).length || Object.values(run.participants).some(p => p.turns !== 0 || p.session || p.pendingInvocation || p.state !== 'uninitialised')) throw new Error('Run is not a proven legacy pre-workspace base-policy failure')
  if (names.includes('journal-recovery.json')) {
    const finding = JSON.parse(await fs.readFile(path.join(dir,'journal-recovery.json'),'utf8'))
    if (finding.status !== 'missing') throw new Error('Only missing pre-execution journals can be retired')
  }
  return hashes
}

export async function legacyJournalDisposition (issuePath, runId) {
  const dir=path.join(issuePath,'runs',runId)
  let record
  try { record=JSON.parse(await readRegularFile(path.join(dir,dispositionName),'utf8')) } catch(e) { if(e.code==='ENOENT')return null; throw e }
  if (record.kind !== 'retired-pre-execution-failure' || !record.reason || JSON.stringify(await evidence(dir)) !== JSON.stringify(record.hashes)) throw new Error('Legacy retirement evidence changed; recovery required')
  return record
}

export async function retireLegacyJournal (issuePath, runId, reason) {
  if (!/^[a-zA-Z0-9-]+$/.test(runId) || !reason?.trim()) throw new Error('Run ID and forensic reason are required')
  return withIssueLock(path.join(issuePath,'.run.lock'), {purpose:'legacy-journal-retirement',waitMs:0}, async()=>{
    const existing=await legacyJournalDisposition(issuePath,runId)
    if(existing)return existing
    const record={kind:'retired-pre-execution-failure',at:new Date().toISOString(),reason,hashes:await evidence(path.join(issuePath,'runs',runId))}
    await writeJson(path.join(issuePath,'runs',runId,dispositionName),record)
    return record
  })
}
