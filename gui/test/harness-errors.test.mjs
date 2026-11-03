import { runtimeErrors, runtimeResult } from '../../harness/claude.mjs'
import { codexErrors } from '../../harness/codex.mjs'
import { classifyFailure } from '../server/runtime/failure.mjs'

const line = (o) => JSON.stringify(o)

export default async function (t) {
  t.section('claude: the runtime\'s error messages are classified, the model\'s text is not')
  {
    const spend = [
      line({ type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'Working on it.' }] } }),
      line({ type: 'assistant', error: 'rate_limit', is_api_error_message: true, message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your monthly spend limit. Switch to another model." }] } }),
      line({ type: 'result', stop_reason: 'stop_sequence', total_cost_usd: 6.01 })
    ].join('\n')
    t.eq('a monthly spend limit is quota', classifyFailure({ message: 'claude exited 1', stdout: runtimeErrors(spend) }).class, 'quota')

    const talk = [
      line({ type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'I fixed the HTTP 429 too many requests path and the quota exceeded message.' }] } }),
      line({ type: 'result', is_error: false, result: 'Done: 429 rate limit handling and usage limit banner.' })
    ].join('\n')
    const talked = classifyFailure({ message: 'claude exited 1', stdout: runtimeErrors(talk), payload: runtimeResult({ type: 'result', is_error: false, result: 'handled 429 and quota exceeded' }) })
    t.eq('an agent describing a 429 is not a provider rate limit', talked.class, 'runtime')

    const failedResult = runtimeResult({ type: 'result', is_error: true, subtype: 'error_during_execution', result: 'API Error: 529 overloaded' })
    t.eq('a result the runtime marked as an error keeps its text', classifyFailure({ message: 'claude exited 1', payload: failedResult }).class, 'rate-limit')
  }

  t.section('codex: error and turn.failed events are read from the JSON stream')
  {
    const stream = [
      line({ type: 'thread.started', thread_id: 't' }),
      line({ type: 'item.completed', item: { type: 'agent_message', text: 'The insufficient_quota branch now retries.' } }),
      line({ type: 'turn.failed', error: { message: 'stream error: exceeded retry limit, last status: 429 Too Many Requests' } })
    ].join('\n')
    t.eq('a failed turn with a 429 is a rate limit', classifyFailure({ message: 'codex exited 1', stdout: codexErrors(stream) }).class, 'rate-limit')
    t.eq('the agent message is not evidence', codexErrors(stream).includes('insufficient_quota'), false)
  }

  t.section('the output limit: each runtime\'s ending, and never the model\'s own text')
  {
    const codex = [
      line({ type: 'thread.started', thread_id: 't' }),
      line({ type: 'item.completed', item: { type: 'reasoning', text: 'Still weighing it.' } }),
      line({ type: 'turn.failed', error: { message: 'Incomplete response returned, reason: max_output_tokens' } })
    ].join('\n')
    const fromCodex = classifyFailure({ message: 'codex exited 1', stdout: codexErrors(codex) })
    t.eq('codex: its own class, retryable', `${fromCodex.class}:${fromCodex.retryable}`, 'output-limit:true')

    const words = "API Error: Claude's response exceeded the 64000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable. Lower the effort level to leave room for a reply."
    const claude = [
      line({ type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'Partly done.' }] } }),
      line({ type: 'assistant', error: 'max_output_tokens', is_api_error_message: true, message: { model: '<synthetic>', content: [{ type: 'text', text: words }] } }),
      line({ type: 'result', subtype: 'success', is_error: true, stop_reason: 'max_tokens', result: words })
    ].join('\n')
    const result = JSON.parse(claude.split('\n').at(-1))
    t.eq('claude: a non-zero exit, read from the stream', classifyFailure({ message: 'claude exited 1', stdout: runtimeErrors(claude), payload: runtimeResult(result) }).class, 'output-limit')
    t.eq('claude: exit 0 with an error result, read from the record', classifyFailure({ message: 'claude reported an error: success', payload: result }).class, 'output-limit')

    const gemini = 'Model response was truncated because it exceeded the token limit. Try using /compress to free up context space.'
    const geminiResult = { type: 'result', status: 'error', error: { type: 'INVALID_STREAM', message: gemini } }
    t.eq('gemini: an error result (the adapter passes its message as stderr)', classifyFailure({ message: 'gemini reported an error: INVALID_STREAM', stderr: gemini, payload: geminiResult }).class, 'output-limit')
    t.eq('gemini: another invalid stream is not the limit', classifyFailure({ message: 'gemini reported an error: INVALID_STREAM', stderr: 'Model stream ended with an empty response text.', payload: { type: 'result', status: 'error', error: { type: 'INVALID_STREAM' } } }).class, 'runtime')

    const talk = 'I now retry max_output_tokens.\nIncomplete response returned, reason: max_output_tokens\nmax_output_tokens: handled'
    const codexTalk = [
      line({ type: 'item.completed', item: { type: 'agent_message', text: talk } }),
      line({ type: 'turn.failed', error: { message: 'exec session crashed' } })
    ].join('\n')
    t.eq('codex: an agent quoting the ending is not the ending', classifyFailure({ message: 'codex exited 1', stdout: codexErrors(codexTalk) }).class, 'runtime')
    const claudeTalk = [
      line({ type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: talk }] } }),
      line({ type: 'result', is_error: false, result: talk })
    ].join('\n')
    t.eq('claude: nor is an answer quoting it, read from the stream', classifyFailure({ message: 'claude exited 1', stdout: runtimeErrors(claudeTalk), payload: runtimeResult(JSON.parse(claudeTalk.split('\n').at(-1))) }).class, 'runtime')
    t.eq('claude: nor a whole record the runtime did not mark as an error', classifyFailure({ message: 'claude exited 1', payload: { type: 'result', is_error: false, result: talk } }).class, 'runtime')
    t.eq('raw stream text: the quote stays inside its JSON line', classifyFailure({ message: 'gemini exited 1', stdout: line({ type: 'message', content: talk }) }).class, 'runtime')
  }
}
