import path from 'node:path'

import * as store from './runtime/store.mjs'
import { acquire } from './runtime/lock.mjs'
import { resolvePlaybook } from './config/load.mjs'
import { setIssueDependencies } from './issue-dependencies.mjs'

/*
 * The owner's answer to a triage that would not start work (run.ownerInput).
 *
 * Triage judged that one run could not finish the issue without its owner, so
 * the run ended after that one turn instead of pausing, with its issue's one live
 * run held for a person. Answering it is three things, in this order:
 *
 *   1. the answer is recorded on the run, under the run lock, exactly once;
 *   2. it becomes material the next run reads: a human note on the issue with
 *      each question and its answer (runtime/current-window.mjs captures notes
 *      as human input), or, for an accepted split, new issues and the `split`
 *      disposition naming them, each part after the first waiting for the one
 *      before it (triage lists the parts "in the order they should be done");
 *   3. the same playbook starts again with the same run options, unless the
 *      split was accepted. The configuration must still be the one the asking
 *      run resolved (same configHash): a playbook edited since is something
 *      nobody previewed, and that start is left to the operator.
 *
 * A refused start leaves 1 and 2 in place and reports the refusal: the answer
 * is not lost, and starting again is an ordinary start.
 */

const fail = (status, message) => Object.assign(new Error(message), { status })
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export function createOwnerInput ({ issues, supervisor, configRoot }) {
  async function answer ({ project, issueId, runId, actor, answers = null, split = null, note = null, host = undefined }) {
    if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) throw fail(400, 'invalid run id')
    const by = clean(actor, 120)
    if (!by) throw fail(400, 'say who is answering (actor)')
    const issue = await issues.getIssue(project, issueId)
    if (issue.packed) throw fail(409, 'the issue is archived; restore it first')
    const issuePath = issue.path

    const lock = await acquire(path.join(issuePath, '.run.lock'), { purpose: 'owner-input', runId }).catch((error) => { throw Object.assign(error, { status: 409 }) })
    let run, record
    try {
      run = await store.readRun(issuePath, runId)
      const asked = run.ownerInput
      if (!asked || run.status !== 'completed') throw fail(409, 'this run did not end with questions for the owner')
      if (asked.answer) throw fail(409, `already answered by ${asked.answer.by} at ${asked.answer.at}`)
      const extra = clean(note, 4000)

      if (asked.verdict === 'too-large') {
        if (!['accept', 'decline'].includes(split)) throw fail(400, 'answer the proposed split with accept or decline')
        record = { at: new Date().toISOString(), by, split, note: extra || null, createdIssues: [], noteStep: null }
      } else {
        const given = {}
        for (const q of asked.questions ?? []) {
          const a = clean(answers?.[q.id], 2000)
          if (!a) throw fail(400, `${q.id} has no answer`)
          given[q.id] = a
        }
        record = { at: new Date().toISOString(), by, answers: given, note: extra || null, noteStep: null }
      }

      // The answer is on the run before anything is made from it: a crash
      // after this point leaves an answered run, never a second answer.
      run.ownerInput = { ...asked, answer: record }
      await store.writeRun(issuePath, runId, run)
      await store.appendEvent(issuePath, runId, { type: 'owner-input-answered', by, split: record.split ?? null })
    } finally {
      await lock.release()
    }

    const asked = run.ownerInput
    if (record.split === 'accept') {
      for (const part of asked.split) {
        const created = await issues.createIssue(project, {
          openedBy: { user: by, host, from: { project, issueId, runId, via: 'split' } },
          input: `# ${part.title}\n\n${part.scope}\n\nSplit from ${issueId}: triage of run ${runId} judged the whole too large for one run, and the owner accepted this split.${record.note ? `\n\n${record.note}` : ''}\n`
        })
        record.createdIssues.push(created.id)
      }
      // A chain rather than per-part order: the split contract states only an order. It runs the parts one after
      // another even though a project may run several issues at once; people and the supervisor may loosen it with set_dependencies.
      for (let i = 1; i < record.createdIssues.length; i++) {
        await setIssueDependencies(project, record.createdIssues[i], {
          dependsOn: [record.createdIssues[i - 1]], by: 'operator',
          reason: `Split from ${issueId}: part ${i + 1} of ${record.createdIssues.length}, after part ${i}.`
        }, { getIssue: issues.getIssue })
      }
      await issues.setIssueDisposition(project, issueId, {
        value: 'split', by: 'operator', runId, related: record.createdIssues,
        evidence: `Triage of run ${runId} judged the issue too large for one run; ${by} accepted the proposed split into ${record.createdIssues.length} issues.`
      })
    } else {
      // The consult panel answers through this same path (consult/owner-questions.mjs); the note says who did.
      const lines = [by.startsWith('consult panel') ? '# Answers from the consult panel' : '# Answers from the owner', '', `Triage of run \`${runId}\` asked before starting work; ${by} answered.`, '']
      if (record.split === 'decline') {
        lines.push('The owner **declined** the proposed split: do the issue as one run. Do not propose the split again.', '')
      } else {
        for (const q of asked.questions) lines.push(`**${q.id}. ${q.question}**`, '', record.answers[q.id], '')
      }
      if (record.note) lines.push(record.note, '')
      const step = await issues.createStep(project, issueId, { name: 'owner-answers', text: lines.join('\n') })
      record.noteStep = step.id
    }
    const outcome = record.split === 'accept' ? { started: null, startError: null } : await restart({ project, issueId, issuePath, run })
    record.startedRun = outcome.started?.runId ?? null
    record.startError = outcome.startError?.message ?? null
    // What was made from the answer, recorded next to it. The answer itself is
    // already on the run; failing to add these references loses no decision,
    // so it is reported rather than thrown after the work was done.
    let recordError = null
    try {
      const again = await acquire(path.join(issuePath, '.run.lock'), { purpose: 'owner-input', runId })
      try {
        const fresh = await store.readRun(issuePath, runId)
        fresh.ownerInput = { ...fresh.ownerInput, answer: record }
        await store.writeRun(issuePath, runId, fresh)
      } finally { await again.release() }
    } catch (error) { recordError = error.message }

    return { answer: record, recordError, ...outcome }
  }

  async function restart ({ project, issueId, issuePath, run }) {
    try {
      const snapshot = await store.readSnapshot(issuePath, run.runId)
      const runOptions = snapshot.runOptions ?? {}
      const resolution = await resolvePlaybook(run.playbook.id, { root: configRoot, runOptions, projectId: project })
      if (!resolution.ok) throw fail(422, resolution.errors.map((e) => e.message).join('; '))
      const asked = run.playbook.configHash ?? snapshot.configHash ?? null
      if (asked && resolution.resolved.configHash !== asked) {
        throw fail(409, 'the playbook changed since the run that asked; preview and start it from the issue page')
      }
      const started = await supervisor.start({ project, issueId, playbookId: run.playbook.id, runOptions, expectConfigHash: resolution.resolved.configHash, configRoot })
      return { started, startError: null }
    } catch (error) {
      return { started: null, startError: { message: error.message, status: error.status ?? 500, code: error.code ?? null } }
    }
  }

  return { answer }
}
