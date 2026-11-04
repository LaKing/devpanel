import fs from 'node:fs/promises'
import path from 'node:path'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { engineFixture, scriptFor } from './fakes/fixture.mjs'
import { timeSplit } from '../server/runtime/run-metrics.mjs'
import { wallClockElapsedMs } from '../server/runtime/wall-clock.mjs'

export default async function (t) {
  let approve=false
  let engine=null
  // The author changes a file, so the candidate tree differs from the base and a failure that
  // prints the tree is not the base's own (an unchanged candidate would fail identically: inherited).
  const script=async turn=>{
    if(turn.stepId==='implement') await fs.writeFile(path.join(engine.run.workspace.path,'source.txt'),'changed\n')
    return scriptFor({confirm:approve})(turn.stepId.startsWith('audit-implement-')?{...turn,stepId:'audit-implementation'}:turn)
  }
  const f=await engineFixture({playbook:'implementation',script})
  engine=await startRun({...f,deliveryProvider:f.delivery})
  await engine.drive()
  t.eq('missing confirmation blocks delivery',engine.run.blockedReason,'closure-conditions-unmet')
  const prior=engine.run.steps.map(s=>s.invocationId)
  const snapshot=JSON.stringify(engine.snapshot)
  // Prints the tree before failing, so the base fails differently: not inherited.
  await engine.refreshClosureChecks({kind:'local',commands:[{id:'functional',run:'find . -type f -not -path "./.git*" | LC_ALL=C sort | xargs cksum; exit 1',timeoutSeconds:10}]})
  await engine.drive()
  t.eq('failed new evidence cannot reuse an earlier pass',engine.run.blockedReason,'refreshed-checks-failed')
  t.eq('failure spends no model turn',engine.run.steps.length,prior.length)
  approve=true
  await engine.refreshClosureChecks({kind:'local',commands:[{id:'functional',run:'echo verified',timeoutSeconds:10}]})
  await engine.drive()
  t.eq('successful checks permit fresh confirmation',engine.run.status,'completed')
  t.eq('original work is preserved',engine.run.steps.slice(0,prior.length).map(s=>s.invocationId),prior)
  t.eq('only confirmation repeated',engine.run.steps.length,prior.length+1)
  t.eq('snapshot authority remains immutable',JSON.stringify(engine.snapshot),snapshot)
  t.eq('old confirmation remains in history',engine.run.supersededSteps.length,1)
  t.eq('newest check is authoritative',engine.run.checkResults.at(-1).result,'passed')
  await releaseWorkspace(engine)

  t.section('a refresh under the wall-clock rule: its stop and its check, with no seat, are free')
  {
    const MIN=60_000
    approve=false
    const g=await engineFixture({playbook:'implementation',script})
    engine=await startRun({...g,deliveryProvider:g.delivery})
    await engine.drive()
    t.eq('stopped at closure',engine.run.blockedReason,'closure-conditions-unmet')
    const before=engine.wallClockElapsed()
    g.clock.advance(60*MIN)
    await engine.refreshClosureChecks({kind:'local',commands:[{id:'functional',run:'echo verified',timeoutSeconds:10}]})
    t.eq('the stop is located',[engine.run.checkRefresh.stop.to,engine.run.checkRefreshSuspendedMs],[g.clock.iso(),60*MIN])
    t.eq('and not counted',engine.wallClockElapsed(),before)
    t.eq('nor unplaced',timeSplit(engine.run,g.clock.now()).unplacedStopsMs,0)
    // The drive takes twenty minutes of the fake clock. The refresh runs inline, with no seat.
    const during=[]
    const drive=engine.checkCandidate.bind(engine)
    engine.checkCandidate=async(args)=>{
      const began=g.clock.iso()
      g.clock.advance(20*MIN)
      during.push(engine.wallClockElapsed())
      const result=await drive(args)
      return {...result,at:began,durationMs:20*MIN}
    }
    approve=true
    // Less than the drive takes: only a clock that counted it would stop this run.
    engine.run.budgets.limits.wallClockMinutes=10
    await engine.drive()
    t.eq('a limit the drive alone would pass does not stop it, and the run completes',engine.run.status,'completed')
    t.eq('free during the drive itself',during,[before])
    t.eq('and once recorded',wallClockElapsedMs(engine.run,Date.parse(engine.run.endedAt)),before)
    t.eq('nothing still reads as a check running',engine.checkRunningSince,null)
    await releaseWorkspace(engine)
  }
}
