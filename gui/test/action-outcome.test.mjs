import { waitingNotice } from '../src/action-outcome.js'

export const name = 'action outcome — an action accepted to wait for a full verification is a notice, never an error'

export default async function (t) {
  t.section('a waiting answer reads as accepted work in progress, naming the cycle and what it waits to do')
  t.eq('finalize / delivery', waitingNotice({ status: 'waiting', cycleId: '2026-11-25.1', waitingFor: 'delivery' }), 'Accepted: waiting for full verification 2026-11-25.1 before delivering. It goes on by itself when the cycle ends.')
  t.eq('reconcile', waitingNotice({ status: 'waiting', cycleId: '2026-11-25.1', waitingFor: 'reconcile' }), 'Accepted: waiting for full verification 2026-11-25.1 before reconciling. It goes on by itself when the cycle ends.')
  t.eq('integrate', waitingNotice({ status: 'waiting', cycleId: '2026-11-25.1', waitingFor: 'integrate' }), 'Accepted: waiting for full verification 2026-11-25.1 before merging. It goes on by itself when the cycle ends.')
  t.eq('integration recovery', waitingNotice({ status: 'waiting', cycleId: 'c', waitingFor: 'integration-reconcile' }), 'Accepted: waiting for full verification c before merging. It goes on by itself when the cycle ends.')
  t.eq('no cycle id: no double space', waitingNotice({ status: 'waiting' }), 'Accepted: waiting for full verification before delivering. It goes on by itself when the cycle ends.')

  t.section('anything else is not a waiting notice')
  t.eq('completed', waitingNotice({ status: 'completed' }), null)
  t.eq('blocked', waitingNotice({ status: 'blocked', blockedReason: 'delivery-failed' }), null)
  t.eq('nothing', waitingNotice(undefined), null)
}
