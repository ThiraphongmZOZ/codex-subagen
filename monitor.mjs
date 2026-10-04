export function createState() {
  return { connected:false, account:null, models:[], runs:[], agents:{}, events:[], approvals:[], pendingEvents:[], error:null };
}
export function record(state, method, detail, threadId=null) {
  state.events.unshift({time:new Date().toISOString(),method,detail:String(detail).slice(0,1200),threadId});
  state.events.length=Math.min(state.events.length,250);
}
function timestamp(value) {
  const numeric=typeof value==='number'?value:typeof value==='string'&&value.trim()?Number(value):NaN;
  if(Number.isFinite(numeric))return numeric<1e12?numeric*1000:numeric;
  const parsed=typeof value==='string'?Date.parse(value):NaN;
  return Number.isFinite(parsed)?parsed:0;
}
export function compareThreadRecency(a,b) {return timestamp(b.updatedAt)-timestamp(a.updatedAt);}
const usageFields=['totalTokens','inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens'];
const tokenCount=value=>{const number=Number(value);return Number.isFinite(number)&&number>0?number:0;};
export function sumTokenUsage(agents) {
  const total=Object.fromEntries(usageFields.map(field=>[field,0]));
  for(const agent of agents)for(const field of usageFields)total[field]+=tokenCount(agent.tokenUsage?.total?.[field]);
  return total;
}
export function estimateTokenCost(usage,rates) {
  if(!usage||!rates)return null;
  const input=tokenCount(usage.inputTokens),cached=Math.min(input,tokenCount(usage.cachedInputTokens)),written=Math.min(input-cached,tokenCount(usage.cacheWriteInputTokens));
  const parts=[[input-cached-written,rates.input],[cached,rates.cachedInput],[written,rates.cacheWrite],[tokenCount(usage.outputTokens),rates.output]];
  if(parts.some(([tokens,rate])=>tokens>0&&(!Number.isFinite(rate)||rate<0)))return null;
  const cost=parts.reduce((sum,[tokens,rate])=>sum+tokens*(Number.isFinite(rate)&&rate>=0?rate:0),0)/1_000_000;
  return Number.isFinite(cost)?cost:null;
}
export function solTokenUsage(agents) {return agents.reduce((total,agent)=>typeof agent.model==='string'&&agent.model.toLowerCase().includes('sol')?total+tokenCount(agent.tokenUsage?.total?.totalTokens):total,0);}
export function solTokenWarningExceeded(agents,limit) {return Number.isInteger(limit)&&limit>0&&solTokenUsage(agents)>limit;}
export function delegationReason(prompt) {return String(prompt||'').match(/^\s*(?:escalation\s+)?reason\s*:\s*([^\r\n]+)/im)?.[1]?.trim().slice(0,500)||null;}
export function delegationReasonLabel(value) {return typeof value==='string'&&value.trim()?value.trim():'ไม่ได้ระบุ';}
export function agentsForRun(agents,runId) {return agents.filter(agent=>agent.runId===runId);}
export const maxConcurrentRuns=5;
export function activeDashboardRunCount(runs) {return runs.filter(run=>!run.external&&['starting','running','unknown'].includes(run.status)).length;}
const terminalStatuses=new Set(['completed','error','interrupted','closed']);
function mergedTokenUsage(previous,next){
  if(!next||typeof next!=='object')return previous;
  if(!previous||typeof previous!=='object')return next;
  const fields=['totalTokens','inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens'];
  const total={...previous.total,...next.total};
  for(const field of fields)total[field]=Math.max(tokenCount(previous.total?.[field]),tokenCount(next.total?.[field]));
  return {...previous,...next,total};
}
function queuePendingEvent(state,method,p){
  state.pendingEvents??=[];
  state.pendingEvents.push({threadId:p.threadId||p.thread?.id||null,parentThreadId:p.thread?.parentThreadId||null,method,params:p});
  if(state.pendingEvents.length>300)state.pendingEvents.splice(0,state.pendingEvents.length-300);
}
export function ensureAgent(state,id,extra={}) {
  if (!id) return null;
  const created=!state.agents[id];
  state.agents[id] ??= {id,name:'Agent',parentId:null,runId:null,status:'unknown',task:'',activity:'',output:'',turnId:null,updatedAt:new Date().toISOString()};
  const agent=Object.assign(state.agents[id],extra,{updatedAt:new Date().toISOString()});
  if(created&&state.pendingEvents?.length){
    const pending=state.pendingEvents.filter(event=>event.threadId===id||event.parentThreadId===id);
    state.pendingEvents=state.pendingEvents.filter(event=>event.threadId!==id&&event.parentThreadId!==id);
    for(const event of pending)reduceEvent(state,event.method,event.params);
  }
  return agent;
}
export function reconcileThreadSnapshot(state,thread){
  const agent=state.agents[thread?.id];if(!agent)return null;
  const parent=state.agents[thread.parentThreadId];
  if(thread.parentThreadId||agent.parentId)agent.parentId=thread.parentThreadId||agent.parentId;
  if(parent?.runId)agent.runId=parent.runId;
  if(thread.model)agent.model=thread.model;
  if(thread.reasoningEffort)agent.reasoningEffort=thread.reasoningEffort;
  if(thread.agentNickname||thread.agentRole)agent.name=thread.agentNickname||thread.agentRole;
  if(thread.preview)agent.task=thread.preview;
  if(thread.tokenUsage)agent.tokenUsage=mergedTokenUsage(agent.tokenUsage,thread.tokenUsage);
  const inProgress=[...(thread.turns||[])].reverse().find(turn=>turn.status==='inProgress');
  const lastTurn=[...(thread.turns||[])].at(-1);
  if(inProgress){agent.turnId=inProgress.id;agent.status=thread.status?.activeFlags?.includes('waitingOnApproval')?'waiting':'running';}
  else if(thread.status?.type==='systemError'||lastTurn?.status==='failed')agent.status='error';
  else if(lastTurn?.status==='interrupted')agent.status='interrupted';
  else if(lastTurn?.status==='completed')agent.status='completed';
  const run=state.runs.find(item=>item.threadId===agent.id);
  if(run){
    if(agent.status==='running'||agent.status==='waiting'){run.status='running';delete run.finishedAt;}
    else if(terminalStatuses.has(agent.status)){run.status=agent.status;run.finishedAt??=new Date().toISOString();}
  }
  const message=lastTurn?.items?.findLast(item=>item.type==='agentMessage'&&item.text);
  if(message)agent.output=message.text.slice(-40000);
  return agent;
}
export function reduceEvent(state,method,p={}) {
  const thread=p.thread;
  if (method==='thread/started' && thread) {
    const parent=state.agents[thread.parentThreadId];
    // Only monitor threads belonging to runs started by this dashboard.
    if (!state.agents[thread.id] && !parent) {queuePendingEvent(state,method,p);return;}
    const existing=state.agents[thread.id];
    ensureAgent(state,thread.id,{name:thread.agentNickname||thread.agentRole||existing?.name||(parent?'Subagent':'Coordinator'),parentId:thread.parentThreadId||existing?.parentId||null,runId:parent?.runId||existing?.runId,model:thread.model||existing?.model||null,reasoningEffort:thread.reasoningEffort||existing?.reasoningEffort||null,task:thread.preview||existing?.task||''});
  }
  const a=state.agents[p.threadId];
  if (!a) {if(p.threadId)queuePendingEvent(state,method,p);return;}
  a.updatedAt=new Date().toISOString();
  if(method==='turn/started') {
    if(a.turnId===p.turn?.id&&terminalStatuses.has(a.status))return;
    a.status='running';if(a.turnId!==p.turn?.id)a.output='';a.turnId=p.turn?.id||a.turnId;
    const run=state.runs.find(r=>r.threadId===a.id);if(run){run.status='running';delete run.finishedAt;}
  }
  if(method==='error') {a.activity=p.error?.message||p.message||'Codex error';record(state,method,a.activity,a.id);}
  if(method==='turn/completed') {
    if(a.turnId&&p.turn?.id&&a.turnId!==p.turn.id)return;
    if(!a.turnId&&p.turn?.id)a.turnId=p.turn.id;
    a.status=p.turn.status==='failed'?'error':p.turn.status==='interrupted'?'interrupted':'completed';
    a.activity=p.turn.error?.message||'Turn '+p.turn.status;
    const run=state.runs.find(r=>r.id===a.runId);
    if(run?.threadId===a.id) {run.status=a.status;run.finishedAt=new Date().toISOString();}
  }
  if(method==='thread/status/changed') {
    const type=p.status?.type;
    if(type==='active'&&!terminalStatuses.has(a.status)) a.status=p.status.activeFlags?.includes('waitingOnApproval')?'waiting':'running';
    else if(type==='systemError') a.status='error';
    else if(type==='notLoaded' && ['running','waiting'].includes(a.status)) a.status='unknown';
  }
  if(method==='item/agentMessage/delta') a.output=(a.output+(p.delta||'')).slice(-40000);
  if(method==='turn/plan/updated') a.plan=p.plan;
  if(method==='thread/tokenUsage/updated') a.tokenUsage=mergedTokenUsage(a.tokenUsage,p.tokenUsage);
  const item=p.item;
  if(item) {
    a.activity=item.command||item.query||item.tool||item.type;
    if(item.type==='agentMessage' && method==='item/completed') {
      a.output=(item.text||a.output).slice(-40000);
      const task=item.text?.match(/^(?:งาน|Task):\s*([^\n]+)/i);
      if(a.parentId && task) a.task=task[1].slice(0,1000);
    }
    if(item.type==='userMessage' && a.parentId) a.task=(item.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n').slice(0,20000)||a.task;
    if(item.type==='subAgentActivity') {
      const child=ensureAgent(state,item.agentThreadId,{name:item.agentPath||state.agents[item.agentThreadId]?.name||'Subagent',parentId:a.id,runId:a.runId});
      if((item.kind==='started'||item.kind==='interacted')&&!terminalStatuses.has(child.status)) child.status='running';
      if(item.kind==='completed' && !['error','interrupted'].includes(child.status)) child.status='completed';
      if(item.kind==='interrupted') child.status='interrupted';
    }
    if(item.type==='collabAgentToolCall'||item.type==='collabToolCall') {
      const ids=item.receiverThreadIds||[item.newThreadId||item.receiverThreadId].filter(Boolean);
      for(const id of ids) {
        const old=state.agents[id];
        const child=ensureAgent(state,id,{parentId:old?.parentId||a.id,runId:a.runId});
        if(item.prompt) child.task=item.prompt;
        child.escalationReason=(typeof item.reason==='string'&&item.reason.trim()?item.reason.trim().slice(0,500):null)||delegationReason(item.prompt)||child.escalationReason||null;
        const s=item.agentsStates?.[id]||item.agentStatus;
        if(s) {
          const nextStatus=({errored:'error',shutdown:'closed',pendingInit:'queued',notFound:'unknown'})[s.status]||s.status;
          if(terminalStatuses.has(nextStatus)||!terminalStatuses.has(child.status))child.status=nextStatus;
          if(s.message) child.output=s.message;
        } else if(/spawn/i.test(item.tool||'')) child.status='running';
      }
    }
    record(state,method,item.command||item.text||item.prompt||item.type,a.id);
  } else if(!/delta$/.test(method)) record(state,method,p.turn?.error?.message||p.turn?.status||p.status?.type||method,a.id);
}
