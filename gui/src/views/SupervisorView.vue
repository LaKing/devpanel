<script setup>
import { formatHms, formatMTokens, supervisorCost, supervisorUsage } from '@/format'
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { api } from '@/api'
import { socket, connection } from '@/socket'
import MarkdownText from '@/components/MarkdownText.vue'
import StructuredBody from '@/components/StructuredBody.vue'
import LiveOutput from '@/components/LiveOutput.vue'
import SupervisorQuestion from '@/components/SupervisorQuestion.vue'
import SupervisorCampaign from '@/components/SupervisorCampaign.vue'
const state=ref(null), models=ref([]), projects=ref([]), error=ref(''), refreshError=ref(''), busy=ref(false), text=ref('')
// Technical details are drawn when opened: a tree per message, built up front,
// would cost every long conversation for detail nobody looked at.
const technicalOpen=ref(new Set())
const onTechnical=(id,e)=>{const next=new Set(technicalOpen.value);if(e.target.open)next.add(id);else next.delete(id);technicalOpen.value=next}
const model=ref('opus-5'), selected=ref([]), mission=ref(''), allowArchive=ref(false)
const maxCalls=ref(2000), maxRuns=ref(200), maxConcurrent=ref(3), maxStartsPerIssue=ref(20)
const selectedModel=computed(()=>models.value.find(m=>m.id===model.value))
const modelOptions=computed(()=>models.value.map(m=>({...m,title:m.launchReady===true?m.title:`${m.title} (unverified)`})))
const active=computed(()=>['active','working','stopping'].includes(state.value?.status))
const chatArea=ref(null), activationPanel=ref(null), following=ref(true)
async function configure(){following.value=false;await nextTick();if(activationPanel.value)activationPanel.value.open=true;if(chatArea.value)chatArea.value.scrollTop=0}
const hasMessages=computed(()=>Boolean(state.value?.messages?.length))
function trackScroll(){const el=chatArea.value;if(el)following.value=el.scrollHeight-el.scrollTop-el.clientHeight<80}
async function latest(){following.value=true;await nextTick();const el=chatArea.value;if(el)el.scrollTop=hasMessages.value?el.scrollHeight:0}
watch(()=>[state.value?.messages?.length,state.value?.messages?.at(-1)?.text,state.value?.status],async()=>{if(following.value)await latest()},{flush:'post'})
function readable(m){
 if(m.protocol?.valid===false)return 'Reply could not be used. See technical details for the original response.'
 if(m.role!=='assistant')return m.text
 try{const value=JSON.parse(m.text);if(typeof value.message==='string')return value.message}catch{}
 const start=m.text.indexOf('{'),end=m.text.lastIndexOf('}')
 if(start>=0 && end>start){try{const value=JSON.parse(m.text.slice(start,end+1));if(typeof value.message==='string')return value.message}catch{}}
 if(/^\s*(?:```(?:json)?\s*)?[{[]/.test(m.text))return 'Structured reply received. See technical details.'
 return m.text
}
const actionTitles={list_issues:'Listed issues',get_issue:'Read issue',get_run:'Read run',preview:'Previewed playbook',start_run:'Started run',stop_run:'Stopped run',add_note:'Added note',create_issue:'Created issue',archive_issue:'Archived issue'}
function actionSummary(m){
 let result;try{result=JSON.parse(m.text)}catch{return 'Response recorded'}
 if(result?.error)return `Failed: ${result.error}`
 if(Array.isArray(result))return `${result.length} items returned`
 if(result?.status)return `Status: ${result.status}`
 return 'Response recorded'
}
let timer, sequence=0
async function refresh(){const seq=++sequence;try{const next=await api.supervisor();if(seq===sequence){state.value=next;refreshError.value=''}}catch(e){if(seq===sequence)refreshError.value=e.message}}
async function run(fn){busy.value=true;error.value='';try{await fn();await refresh()}catch(e){error.value=e.message}finally{busy.value=false}}
const start=()=>run(()=>api.startSupervisor({model:model.value,focus:selected.value,message:mission.value,allowArchive:allowArchive.value,limits:{maxCalls:Number(maxCalls.value),maxRuns:Number(maxRuns.value),maxConcurrent:Number(maxConcurrent.value),maxStartsPerIssue:Number(maxStartsPerIssue.value)}}))
const canReset=computed(()=>['stopped','recovery-required'].includes(state.value?.status)&&(hasMessages.value||!!state.value?.session||!!state.value?.pending))
const reset=()=>run(async()=>{await api.resetSupervisor();following.value=true})
// Instruct: into the session it works from (queued during a turn). Ask: a copy of
// that session answers, and nothing the supervisor does follows from it.
const send=()=>{if(!text.value.trim()||busy.value||!active.value)return;return run(async()=>{await api.chatSupervisor(text.value);text.value='';following.value=true})}
const ask=()=>{if(!text.value.trim()||busy.value||!canAsk.value)return;return run(async()=>{await api.askSupervisor(text.value);text.value='';following.value=true})}
const canAsk=computed(()=>Boolean(state.value?.session?.id)&&!state.value?.asking)
const openQuestions=computed(()=>(state.value?.questions??[]).filter(q=>!q.answer))
const reasoningOpen=ref(new Set())
const toggleReasoning=(id)=>{const next=new Set(reasoningOpen.value);if(next.has(id))next.delete(id);else next.add(id);reasoningOpen.value=next}
const workingCall=computed(()=>state.value?.status==='working'&&state.value?.pending?.kind==='model'?state.value.pending.invocationId:null)
const who=(m)=>m.side==='question'?'You · side question':m.side==='answer'?'Supervisor · answered from a copy of its session':m.role==='assistant'?'Supervisor':m.role==='user'?'You':m.role==='tool'?'Engine action':'System'
onMounted(async()=>{await run(async()=>{[models.value,projects.value]=await Promise.all([api.supervisorModels(),api.listProjects()]);await refresh();if(state.value?.model){model.value=state.value.model.id;selected.value=state.value.focus??[];mission.value=state.value.mission??state.value.messages.filter(m=>m.role==='user').at(-1)?.text??'Continue managing the panel.';allowArchive.value=state.value.allowArchive===true;if(state.value.limits){maxCalls.value=state.value.limits.maxCalls;maxRuns.value=state.value.limits.maxRuns;maxConcurrent.value=state.value.limits.maxConcurrent;if(state.value.limits.maxStartsPerIssue)maxStartsPerIssue.value=state.value.limits.maxStartsPerIssue}}});socket.on('supervisor:changed',refresh);socket.on('connect',refresh);timer=setInterval(refresh,5000)})
onUnmounted(()=>{clearInterval(timer);socket.off('supervisor:changed',refresh);socket.off('connect',refresh)})
// The session's model calls, as cost is reported: time and tokens.
const callUsage=computed(()=>supervisorUsage(state.value?.messages??[]))
const callCost=computed(()=>supervisorCost(state.value?.cost))
const saveCampaign=(scope)=>run(()=>api.setSupervisorCampaign(scope))
</script>
<template>
 <section class="supervisor">
  <header class="status-header">
   <div class="status-heading"><h1>Supervisor</h1><span v-if="state" class="status-label" role="status">{{state.status}}</span><v-spacer />
    <v-btn v-if="state?.status==='stopped' && hasMessages" size="small" variant="tonal" @click="configure">Continue</v-btn>
    <v-btn v-if="canReset" size="small" :disabled="busy" variant="tonal" title="Archive the conversation and native session and begin fresh session limits; the next Start begins with no memory" @click="reset">New session</v-btn>
    <v-btn v-if="active && !state.finishing" size="small" :disabled="busy || state.status==='stopping'" variant="tonal" title="Finish after current work: no further starts; owned runs complete; then the activation stops" @click="run(()=>api.finishSupervisor())">Finish</v-btn>
    <span v-else-if="active && state.finishing" class="status-label" role="status">finishing</span>
    <v-btn v-if="active" size="small" :disabled="busy || state.status==='stopping'" color="warning" @click="run(()=>api.stopSupervisor())">{{state.status==='stopping'?'Stopping…':'Stop supervisor'}}</v-btn>
   </div>
   <div v-if="state" class="status-meta">{{state.model?.id??'No model selected'}} · {{state.calls}} model-call attempts this session · {{state.starts}} run-start attempts this session<span v-if="state.history?.sessions"> · {{state.history.starts}} in {{state.history.sessions}} earlier session{{state.history.sessions===1?'':'s'}}</span> · {{formatHms(callUsage.durationMs)}} · {{formatMTokens(callUsage.tokens)}}<span v-if="callUsage.untimed"> · {{callUsage.untimed}} earlier calls untimed</span><span v-for="part in callCost" :key="part"> · {{part}}</span></div>
   <details v-if="state" class="status-details"><summary>Status details<span v-if="state.reason"> · {{state.reason}}</span></summary>
    <p>Issue-run costs appear in their run details.</p><p v-if="state.spawnFailures">{{state.spawnFailures}} launch attempts failed before a process started; no model cost.</p>
    <p>Start and a server restart resume this session's allowances. New session begins fresh ones and keeps ownership of open runs and unresolved launch reservations.<span v-if="state.spending?.active"> Spending totals continue across sessions and are reporting only by default.</span></p>
    <p v-for="(used, issue) in state.startsByIssue ?? {}" :key="issue">{{issue}}: {{used}} / {{state.limits?.maxStartsPerIssue}} start attempts this session</p>
    <p v-for="a in (state.launches ?? []).filter(a => ['reserved','uncertain'].includes(a.status))" :key="a.id">Unresolved launch {{a.id}} for {{a.project}}/{{a.issueId}} occupies a concurrent slot and requires reconciliation.</p>
    <p v-if="state.deferred?.some(d=>!d.outside)">{{state.deferred.filter(d=>!d.outside).length}} routine event(s) held by the wake filter since {{state.deferred.find(d=>!d.outside).at}}; they reach the supervisor with its next wake.</p>
    <p v-if="state.deferred?.some(d=>d.outside)">Issue changes outside the campaign held for {{state.deferred.filter(d=>d.outside).map(d=>d.event.project).join(', ')}}; they wake nothing and reach the supervisor with its next wake.</p>
    <SupervisorCampaign v-if="state.status!=='stopped'" :campaign="state.campaign" :projects="projects" :busy="busy" @save="saveCampaign" />
    <p v-if="state.reason">{{state.reason}}</p><p v-if="state.session">Session: <code>{{state.session.id}}</code></p>
   </details>
   <v-alert v-if="error || refreshError" type="error" variant="tonal" density="compact">{{error || refreshError}}</v-alert>
   <v-alert v-if="connection.status!=='online'" type="warning" variant="tonal" density="compact">Connection lost. This view may be stale; it refreshes on reconnect.</v-alert>
  </header>
  <div ref="chatArea" class="chat-scroll" @scroll="trackScroll" tabindex="0" aria-label="Chat history">
  <details ref="activationPanel" v-if="state?.status==='stopped'" class="activation" :open="!hasMessages || !state.session">
   <summary class="activation-heading">
    <span class="activation-icon"><v-icon icon="$brand" size="26" /></span>
    <span class="activation-title"><span class="activation-eyebrow">Your workspace, coordinated</span><h2>{{state.session?'Continue supervisor':'Start supervisor'}}</h2><span class="activation-subtitle">Set a direction. Choose a model. Keep work within your limits.</span></span>
    <v-icon class="activation-chevron" icon="$chevronRight" size="22" />
   </summary>
   <div class="activation-body">
    <div class="mission-field">
     <v-textarea v-model="mission" label="What should the supervisor work on?" placeholder="Review the issue queue and prioritize the next steps…" rows="3" auto-grow variant="outlined" hide-details />
    </div>
    <div class="settings activation-selection">
     <v-select v-model="model" :items="modelOptions" item-title="title" item-value="id" label="Model" variant="outlined" density="comfortable" :hint="selectedModel?.blockedReason ?? ''" :persistent-hint="selectedModel?.launchReady !== true" />
     <!-- Focus orders attention; every project remains visible. -->
     <v-select v-model="selected" :items="projects" item-title="label" item-value="id" label="Focus (optional)" variant="outlined" density="comfortable"
               hint="Prioritize these projects. All projects remain visible."
               persistent-hint multiple chips clearable />
    </div>
    <SupervisorCampaign :campaign="state.campaign" :projects="projects" :busy="busy" @save="saveCampaign" />
    <section class="activation-limits" aria-labelledby="supervisor-limits-title">
     <div class="limits-heading"><v-icon icon="$clock" size="18" /><h3 id="supervisor-limits-title">Session limits</h3><span>You set the pace</span></div>
     <div class="settings limits-grid">
      <v-text-field v-model="maxCalls" type="number" label="Model calls (runaway guard)" variant="outlined" density="compact" hint="Includes action-result and repair turns." persistent-hint min="1" max="2000" />
      <v-text-field v-model="maxStartsPerIssue" type="number" label="Run starts per issue" variant="outlined" density="compact" hint="Failed launch attempts count too." persistent-hint min="1" max="20" />
      <v-text-field v-model="maxRuns" type="number" label="Run starts in total" variant="outlined" density="compact" hint="Across all issues in this session." persistent-hint min="1" max="200" />
      <v-text-field v-model="maxConcurrent" type="number" label="Concurrent issue runs" variant="outlined" density="compact" hint="Includes pending launches; several issues of one project may run at once." persistent-hint min="1" max="10" />
     </div>
     <v-checkbox class="archive-option" v-model="allowArchive" label="Allow the supervisor to archive issues" color="primary" density="compact" hide-details />
    </section>
    <div class="activation-footer">
     <div class="activation-notice"><v-icon icon="$alertCircle" size="18" /><div><strong>Starting invokes real agents and incurs costs.</strong><details class="activation-explanation"><summary>How limits and stopping work</summary><p>These limits are per session: Start resumes them, New session begins fresh ones, and changing a cap grants or withdraws allowance without touching what was used. Estimated spending does not stop work. Confirmed provider quota exhaustion triggers a compatible model substitution when available. There is no activation time limit. Stop also stops owned issue runs.</p></details></div></div>
     <v-btn class="activation-start" color="primary" size="large" variant="flat" prepend-icon="$play" :loading="busy" :disabled="!mission.trim() || selectedModel?.launchReady !== true" @click="start">Start supervisor</v-btn>
    </div>
   </div>
  </details>
  <v-alert v-if="state?.status==='recovery-required'" type="warning" variant="tonal">The previous operation needs reconciliation. It will not be replayed automatically. Chat history and pending operation are retained. Investigate what it may have started, then use New session to begin afresh.<details v-if="state.pending"><summary>Pending operation</summary><pre>{{JSON.stringify(state.pending,null,2)}}</pre></details></v-alert>
  <section aria-label="Supervisor conversation" class="conversation">
   <article v-for="m in state?.messages??[]" :key="m.id" :class="['message',m.role]">
    <div class="message__head"><strong>{{who(m)}}</strong><time>{{new Date(m.at).toLocaleString()}}</time></div>
    <template v-if="m.role==='tool'">
     <div class="action-summary"><strong>{{actionTitles[m.action?.type]??'Engine action'}}</strong><span v-if="m.action?.issueId"> · {{m.action.issueId}}</span><span v-else-if="m.action?.project"> · {{m.action.project}}</span><p>{{actionSummary(m)}}</p></div>
    </template>
    <MarkdownText v-else :text="readable(m)" compact />
    <button v-if="m.role==='assistant'&&m.invocationId" type="button" class="reasoning-toggle" @click="toggleReasoning(m.invocationId)">{{reasoningOpen.has(m.invocationId)?'Hide reasoning':'Reasoning'}}</button>
    <LiveOutput v-if="m.role==='assistant'&&m.invocationId&&reasoningOpen.has(m.invocationId)" supervisor :invocation-id="m.invocationId" role="supervisor" />
    <details v-if="m.role==='tool'||m.rawResponse||m.protocol?.valid===false" class="technical" @toggle="onTechnical(m.id,$event)"><summary>Technical details</summary><div v-if="technicalOpen.has(m.id)" class="technical__body"><StructuredBody :text="m.rawResponse??m.text" /></div><details class="technical__raw"><summary>Exact text</summary><pre>{{m.rawResponse??m.text}}</pre></details></details>
   </article>
   <div v-if="workingCall" class="working"><p>Supervisor is working. Its reasoning so far:</p><LiveOutput :key="workingCall" supervisor live :invocation-id="workingCall" role="supervisor" /></div>
   <p v-else-if="state?.status==='working'">Supervisor is working on an action.</p>
   <div v-if="state?.asking" class="working"><p>Answering your side question from a copy of its session:</p><LiveOutput :key="state.asking.invocationId" supervisor live :invocation-id="state.asking.invocationId" role="supervisor (copy)" /></div>
  </section>
  <details v-if="state?.ownedRuns.length" class="owned-runs"><summary>Issue runs · {{state.ownedRuns.length}}</summary><p v-for="r in state.ownedRuns" :key="r.runId"><router-link :to="{path:`/projects/${r.project}/${r.issueId}`,query:{run:r.runId}}">{{r.issueId}}</router-link> · {{r.status}}</p></details>
  </div>
  <button v-if="!following" class="latest" @click="latest">Jump to latest ↓</button>
  <section v-if="openQuestions.length" class="questions" aria-label="Questions for you">
   <SupervisorQuestion v-for="q in openQuestions" :key="q.id" :question="q" @answered="refresh" />
  </section>
  <form v-if="active || state?.session" @submit.prevent="send" class="composer">
   <v-textarea v-model="text" label="Message the supervisor" rows="1" max-rows="4" auto-grow hide-details density="compact" :disabled="state.status==='stopping'" @keydown.enter.exact.prevent="active ? send() : ask()" @keydown.ctrl.enter.prevent="ask" />
   <v-btn variant="tonal" :loading="busy && !!state.asking" :disabled="!text.trim() || !canAsk" :title="canAsk ? 'Answered by a copy of its session; nothing it does follows from it' : 'Needs a session, and one side question at a time'" @click="ask">Ask</v-btn>
   <v-btn type="submit" color="primary" :loading="busy" :disabled="!text.trim() || !active || state.status==='stopping'" :title="active ? 'Into the session it works from; queued during a turn' : 'Start the supervisor to instruct it'">Instruct</v-btn>
   <small><strong>Instruct</strong> (Enter) goes into the session it works from and is queued during a turn · <strong>Ask</strong> (Ctrl+Enter) is answered by a copy of its session and changes nothing.</small>
  </form>
 </section>
</template>
<style scoped>
.supervisor{height:calc(100dvh - 60px);display:flex;flex-direction:column;min-height:0;position:relative;padding:0 20px}
.status-header{flex:none;padding:12px 0 10px;border-bottom:1px solid rgba(var(--v-theme-on-surface),.12);background:rgb(var(--v-theme-background));z-index:1}
.status-heading{flex-wrap:wrap;display:flex;align-items:center;gap:12px}.status-heading h1{font-size:1.2rem}.status-label{font-size:.8rem;background:rgba(var(--v-theme-primary),.12);border-radius:20px;padding:3px 9px}
.status-meta{font-size:.78rem;opacity:.75;margin-top:5px;overflow-wrap:anywhere}.status-details{font-size:.78rem;margin-top:5px}.status-details summary{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.status-details[open]{max-height:25dvh;overflow:auto}
.chat-scroll{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:12px 4px;overflow-wrap:anywhere;scrollbar-gutter:stable}
.activation{border:1px solid rgba(var(--v-theme-primary),.22);border-radius:18px;margin:4px 0 20px;background:rgb(var(--v-theme-surface));box-shadow:0 6px 24px rgba(0,0,0,.04);overflow:hidden}
.activation-heading{display:flex;align-items:center;gap:16px;padding:24px;list-style:none;background:linear-gradient(115deg,rgba(var(--v-theme-primary),.09),rgba(var(--v-theme-primary),.015));cursor:pointer}
.activation-heading::-webkit-details-marker{display:none}.activation-heading:focus-visible{outline:2px solid rgb(var(--v-theme-primary));outline-offset:-4px;border-radius:16px}
.activation-icon{display:grid;place-items:center;flex:none;width:50px;height:50px;border-radius:14px;background:rgba(var(--v-theme-primary),.12);color:rgb(var(--v-theme-primary))}
.activation-title{flex:1;min-width:0}.activation-eyebrow{display:block;font-size:.65rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:rgb(var(--v-theme-primary));margin-bottom:4px}.activation-title h2{font-size:1.3rem;font-weight:650;line-height:1.3;letter-spacing:-.02em}.activation-subtitle{display:block;font-size:.8rem;opacity:.7;margin-top:5px;line-height:1.5}
.activation-chevron{flex:none;opacity:.6;transition:transform .18s ease}.activation[open] .activation-chevron{transform:rotate(90deg)}
.activation-body{padding:24px}.mission-field{margin-bottom:22px}.settings{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.settings>*{min-width:0}.activation-selection{margin-bottom:20px}
.activation-limits{padding:18px 18px 8px;border:1px solid rgba(var(--v-theme-on-surface),.09);border-radius:12px;background:rgba(var(--v-theme-on-surface),.025)}.limits-heading{display:flex;align-items:center;gap:8px;margin-bottom:20px}.limits-heading>.v-icon{opacity:.65}.limits-heading h3{font-size:.85rem;font-weight:650}.limits-heading>span{margin-left:auto;font-size:.72rem;opacity:.6}.limits-grid{gap:16px 20px}.archive-option{margin-top:6px}
.activation-footer{display:flex;align-items:center;gap:20px;margin-top:24px;padding-top:20px;border-top:1px solid rgba(var(--v-theme-on-surface),.09)}.activation-notice{display:flex;align-items:flex-start;gap:9px;flex:1;font-size:.74rem;line-height:1.5;color:rgba(var(--v-theme-on-surface),.72)}.activation-notice>.v-icon{margin-top:2px;flex:none}.activation-notice strong{font-weight:500}.activation-explanation{margin-top:4px}.activation-explanation summary{text-decoration:underline;text-underline-offset:3px}.activation-start{flex:none;border-radius:10px;text-transform:none;letter-spacing:0;font-weight:600}
.supervisor p{margin:6px 0;line-height:1.5}
@media(prefers-reduced-motion:reduce){.activation-chevron{transition:none}}
@media(max-width:600px){.activation-heading{padding:18px;gap:12px}.activation-icon{width:40px;height:40px;border-radius:11px}.activation-title h2{font-size:1.15rem}.activation-eyebrow{font-size:.58rem}.activation-subtitle{font-size:.75rem}.activation-body{padding:18px}.settings{grid-template-columns:minmax(0,1fr);gap:14px}.activation-limits{padding:16px 12px 6px}.limits-heading>span{display:none}.activation-footer{flex-direction:column;align-items:stretch;gap:16px}.activation-start{width:100%}}
.message{border-radius:10px;padding:10px 12px;margin:8px 0;overflow-wrap:anywhere;max-width:92%}.message.user{background:rgba(var(--v-theme-primary),.09);margin-left:auto;max-width:85%;width:fit-content}.message.assistant{background:rgb(var(--v-theme-surface))}.message.tool,.message.system{border-left:2px solid rgba(var(--v-theme-on-surface),.18);border-radius:0;font-size:.85rem}
.message__head{display:flex;gap:12px;align-items:center;margin-bottom:4px;font-size:.8rem}time{opacity:.6;font-size:.7rem}.technical{margin-top:5px;font-size:.75rem}.technical>summary{opacity:.8}.technical__body{margin:6px 0;padding:8px 10px;border-radius:6px;max-height:420px;overflow:auto;background:rgba(var(--v-theme-on-surface),.04);font-size:.8125rem}.technical__raw{margin-top:4px;opacity:.8}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.75rem;max-height:320px;overflow:auto}code{overflow-wrap:anywhere}
.composer{flex:none;display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center;padding:10px 0;border-top:1px solid rgba(var(--v-theme-on-surface),.12)}.composer small{grid-column:1/-1;font-size:.7rem;opacity:.65}.latest{position:absolute;bottom:115px;align-self:center;background:rgb(var(--v-theme-surface));border:1px solid rgba(var(--v-theme-on-surface),.2);border-radius:20px;padding:6px 14px;box-shadow:0 2px 8px #0002;font-size:.8rem}.owned-runs{font-size:.85rem;padding:10px}
@media(max-width:600px){.supervisor{padding:0 10px}.status-heading{gap:8px}.status-meta{font-size:.7rem}.message{max-width:100%;padding:8px}.message.user{max-width:92%}.message__head{gap:8px}}
.working{display:flex;flex-direction:column;gap:6px;margin:8px 0}.reasoning-toggle{font-size:.75rem;opacity:.7;text-decoration:underline;margin-top:4px}.questions{display:flex;flex-direction:column;gap:8px;padding:8px 0}
</style>
