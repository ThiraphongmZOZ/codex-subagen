export function createState() {
  return { connected:false, account:null, models:[], runs:[], agents:{}, events:[], approvals:[], error:null };
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
export function ensureAgent(state,id,extra={}) {
  if (!id) return null;
  state.agents[id] ??= {id,name:'Agent',parentId:null,runId:null,status:'unknown',task:'',activity:'',output:'',turnId:null,updatedAt:new Date().toISOString()};
  return Object.assign(state.agents[id],extra,{updatedAt:new Date().toISOString()});
}
export function reduceEvent(state,method,p={}) {
  const thread=p.thread;
  if (method==='thread/started' && thread) {
    const parent=state.agents[thread.parentThreadId];
    // Only monitor threads belonging to runs started by this dashboard.
    if (!state.agents[thread.id] && !parent) return;
    ensureAgent(state,thread.id,{name:thread.agentNickname||thread.agentRole||(parent?'Subagent':'Coordinator'),parentId:thread.parentThreadId||null,runId:parent?.runId||state.agents[thread.id]?.runId,model:thread.model||state.agents[thread.id]?.model||null,reasoningEffort:thread.reasoningEffort||state.agents[thread.id]?.reasoningEffort||null,task:thread.preview||state.agents[thread.id]?.task||''});
  }
  const a=state.agents[p.threadId];
  if (!a) return;
  a.updatedAt=new Date().toISOString();
  if(method==='turn/started') {
    a.status='running';if(a.turnId!==p.turn.id)a.output='';a.turnId=p.turn.id;
    const run=state.runs.find(r=>r.threadId===a.id);if(run){run.status='running';delete run.finishedAt;}
  }
  if(method==='error') {a.activity=p.error?.message||p.message||'Codex error';record(state,method,a.activity,a.id);}
  if(method==='turn/completed') {
    a.status=p.turn.status==='failed'?'error':p.turn.status==='interrupted'?'interrupted':'completed';
    a.activity=p.turn.error?.message||'Turn '+p.turn.status;
    const run=state.runs.find(r=>r.id===a.runId);
    if(run?.threadId===a.id) {run.status=a.status;run.finishedAt=new Date().toISOString();}
  }
  if(method==='thread/status/changed') {
    const type=p.status?.type;
    if(type==='active') a.status=p.status.activeFlags?.includes('waitingOnApproval')?'waiting':'running';
    else if(type==='systemError') a.status='error';
    else if(type==='notLoaded' && ['running','waiting'].includes(a.status)) a.status='unknown';
  }
  if(method==='item/agentMessage/delta') a.output=(a.output+(p.delta||'')).slice(-40000);
  if(method==='turn/plan/updated') a.plan=p.plan;
  if(method==='thread/tokenUsage/updated') a.tokenUsage=p.tokenUsage;
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
      const child=ensureAgent(state,item.agentThreadId,{name:item.agentPath,parentId:a.id,runId:a.runId});
      if(item.kind==='started'||item.kind==='interacted') child.status='running';
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
          child.status=({errored:'error',shutdown:'closed',pendingInit:'queued',notFound:'unknown'})[s.status]||s.status;
          if(s.message) child.output=s.message;
        } else if(/spawn/i.test(item.tool||'')) child.status='running';
      }
    }
    record(state,method,item.command||item.text||item.prompt||item.type,a.id);
  } else if(!/delta$/.test(method)) record(state,method,p.turn?.error?.message||p.turn?.status||p.status?.type||method,a.id);
}
