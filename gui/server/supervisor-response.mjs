import { acceptRisksError } from './runtime/residual-risks.mjs'

const fields = {
  get_check_log: ['project','issueId','runId','check','command'],
  refresh_checks_run: ['project','issueId','runId'],
  reconcile_delivery_run: ['project','issueId','runId'],
  continue_run: ['project','issueId','runId','instruction'],
  retry_input_run: ['project','issueId','runId'],
  recover_run: ['project','issueId','runId'],
  answer_run: ['project','issueId','runId','answer','pauseId'],
  deploy_staging: ['project','issueId'],
  inspect_environment: ['project','environment','resource'],
  list_issues: ['project'], get_result: ['resultId'], get_issue: ['project','issueId'], get_run: ['project','issueId','runId'],
  get_step: ['project','issueId','runId','step'], get_file: ['project','issueId','step','name'],
  preview: ['project','issueId','playbook'], start_run: ['project','issueId','previewId'],
  stop_run: ['project','issueId','runId'], add_note: ['project','issueId','text'],
  create_issue: ['project','input'], archive_issue: ['project','issueId'],
  // Inquiries (Phase 4): a technical question answered by an analysis run that
  // publishes nothing, without opening a full issue ticket.
  inquire: ['project','question'], get_inquiry: ['project','inquiryId'],
  close_inquiry: ['project','inquiryId','runId','reason'], acknowledge_inquiry: ['project','inquiryId','runId'],
  reopen_inquiry: ['project','inquiryId','reason'],
  set_disposition: ['project','issueId','value','evidence'], create_followups: ['project','issueId','runId'],
  // A person's claim that a run's work was landed by hand, with its evidence.
  mark_landed: ['project','issueId','runId','applied','handChanges'],
  // The management plane's own reads and decisions: one panel-wide reading, and
  // the execution order of the backlog.
  overview: [], set_priority: ['project','issueId','priority','reason'], set_dependencies: ['project','issueId'],
  // Read-only: reserves nothing, spends no allowance.
  readiness: ['project'],
  // A question for the operator, shown in Needs attention; answered later as an event.
  ask_operator: ['question'],
  finish: []
}
function validate (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.message !== 'string' || !Object.hasOwn(value,'action') ||
      Object.keys(value).some(k=>!['message','action'].includes(k))) throw Error('Expected one object with message (string) and action (object or null)')
  const action=value.action
  if (action !== null) {
    if (!action || typeof action !== 'object' || Array.isArray(action) || !Object.hasOwn(fields,action.type)) throw Error('Unknown or malformed supervisor action')
    for (const field of fields[action.type]) if (typeof action[field]!=='string' || !action[field].trim()) throw Error(`Action ${action.type} requires ${field}`)
    if(action.type==='set_disposition'&&action.runId!==undefined&&(typeof action.runId!=='string'||!action.runId.trim()))throw Error('runId must be a string')
    if(action.type==='set_disposition'&&action.related!==undefined&&(!Array.isArray(action.related)||action.related.some(r=>typeof r!=='string'||!r.trim())))throw Error('related must be a list of issue ids')
    if(action.type==='set_disposition'&&action.acceptRisks!==undefined){const bad=action.acceptRisks===null?'acceptRisks must be a list of {id or text, reason}':acceptRisksError(action.acceptRisks);if(bad)throw Error(bad)}
    if(action.type==='set_dependencies'&&(!Array.isArray(action.dependsOn)||action.dependsOn.some(r=>typeof r!=='string'||!r.trim())))throw Error('dependsOn must be a list of issue ids')
    if(action.type==='inquire'&&action.relatedIssue!==undefined&&(typeof action.relatedIssue!=='string'||!action.relatedIssue.trim()))throw Error('relatedIssue must be an issue id')
    if(action.type==='create_issue'&&action.fromInquiry!==undefined&&(!action.fromInquiry||typeof action.fromInquiry!=='object'||Array.isArray(action.fromInquiry)||['inquiryId','runId','key'].some(k=>typeof action.fromInquiry[k]!=='string'||!action.fromInquiry[k].trim())||Object.keys(action.fromInquiry).some(k=>!['inquiryId','runId','key'].includes(k))))throw Error('fromInquiry must be {inquiryId, runId, key}')
    if(action.type==='mark_landed'){
      for(const k of ['commit','checkout','landedAt'])if(action[k]!==undefined&&(typeof action[k]!=='string'||!action[k].trim()))throw Error(`${k} must be a non-empty string`)
      if(action.commit===undefined&&action.checkout===undefined)throw Error('mark_landed needs commit or checkout')
    }
    if(action.type==='ask_operator'){
      for(const k of ['project','issueId'])if(action[k]!==undefined&&(typeof action[k]!=='string'||!action[k].trim()))throw Error(`${k} must be a non-empty string`)
      if(action.issueId!==undefined&&action.project===undefined)throw Error('issueId needs its project')
      if(action.options!==undefined&&(!Array.isArray(action.options)||!action.options.length||action.options.length>6||action.options.some(o=>typeof o!=='string'||!o.trim()||o.length>200)))throw Error('options must be 1 to 6 short strings')
    }
    const allowed=['type',...fields[action.type],...(action.type==='ask_operator'?['project','issueId','options']:[]),...(['preview','inquire'].includes(action.type)?['runOptions']:[]),...(action.type==='inquire'?['relatedIssue']:[]),...(action.type==='create_issue'?['fromInquiry']:[]),...(action.type==='set_disposition'?['runId','related','acceptRisks']:[]),...(action.type==='readiness'?['issueId','playbook','runOptions']:[]),...(action.type==='set_dependencies'?['dependsOn','reason']:[]),...(action.type==='mark_landed'?['commit','checkout','landedAt']:[]),...(['list_issues','get_result'].includes(action.type)?['offset','limit']:[]),...(action.type==='overview'?['stats']:[])]
    if(Object.keys(action).some(k=>!allowed.includes(k)))throw Error('Unexpected action argument')
    for(const k of ['offset','limit'])if(action[k]!==undefined&&(!Number.isSafeInteger(action[k])||action[k]<0))throw Error(`${k} must be a non-negative integer`)
    if(action.stats!==undefined&&action.stats!==true&&action.stats!==false&&(!Array.isArray(action.stats)||action.stats.some(x=>!['byPlaybook','bySeat'].includes(x))))throw Error('stats must be true, false or a list of byPlaybook, bySeat')
    if(action.runOptions!==undefined && (!action.runOptions || typeof action.runOptions!=='object' || Array.isArray(action.runOptions)))throw Error('runOptions must be an object')
  }
  return value
}

export function parseSupervisorResponse (text) {
  if (typeof text!=='string') throw Error('Response is not text')
  let whole, parsed=false
  try { whole=JSON.parse(text); parsed=true } catch { /* inspect surrounding prose */ }
  if(parsed)return validate(whole)
  const candidates=[]
  let start=-1, stack=[], quoted=false, escaped=false
  for(let i=0;i<text.length;i++){
    const char=text[i]
    if(!stack.length){if(char==='{'||char==='['){start=i;stack.push(char)}continue}
    if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue}
    if(char==='"'){quoted=true;continue}
    if(char==='{'||char==='[')stack.push(char)
    else if(char==='}'||char===']'){
      if(stack.pop()!==(char==='}'?'{':'['))throw Error('Mismatched JSON delimiters')
      if(!stack.length){
        const block=text.slice(start,i+1)
        try { candidates.push(JSON.parse(block)) } catch {
          if(/"(?:message|action)"\s*:/.test(block))throw Error('Malformed supervisor JSON object')
        }
      }
    }
  }
  if(stack.length)throw Error('Incomplete JSON object')
  if(candidates.length!==1)throw Error(candidates.length?'Multiple JSON values; action is ambiguous':'No JSON response object found')
  return validate(candidates[0])
}
