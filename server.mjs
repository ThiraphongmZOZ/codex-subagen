import http from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFileSync,writeFileSync,mkdirSync,existsSync,statSync,renameSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {createState,record,ensureAgent,reduceEvent,reconcileThreadSnapshot,compareThreadRecency,activeDashboardRunCount,maxConcurrentRuns} from './monitor.mjs';
import {roleDefaults,writeAgentDefinitions,recoverAgentDefinitions} from './agent-config.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const port=Number(process.env.PORT||4310), origin=`http://127.0.0.1:${port}`;
const dataDir=path.join(root,'data');mkdirSync(dataDir,{recursive:true});
const configFile=path.join(dataDir,'config.json'), historyFile=path.join(dataDir,'history.json'),agentTransactionFile=path.join(dataDir,'agent-transaction.json');
const defaultCoordinatorInstructions='You are the coordinator and implementation owner. Start by assessing scope. Handle small, clear tasks directly or delegate one focused implementation task to worker; do not spawn agents just because slots are available. Use explorer for targeted read-only investigation when context is unclear. Escalate to planner only for uncertain root causes, cross-service/data-flow bugs, migrations, architecture, high-risk logic, repeated failed fixes, or several tightly related files. Give planner only concise relevant evidence, then return to worker for implementation. Use reviewer for ordinary changes and senior_reviewer only for high-risk work. Wait for every delegated result before proceeding or summarizing. Prefer Luna for exploration, implementation, and routine checks; use Sol for planning and high-risk review. Avoid sending the whole repository to Sol and avoid concurrent edits to the same files. Every subagent should start with a brief visible commentary line beginning with \"งาน: \".';
const defaults={version:2,workspace:root,model:'gpt-6-luna',reasoningEffort:'medium',maxAgents:5,maxSolAgents:2,solTokenWarning:50000,workflowPreset:'custom',tokenRates:{},approvalPolicy:'on-request',sandboxMode:'workspace-write',coordinatorInstructions:defaultCoordinatorInstructions,roles:roleDefaults};
const legacyInstructions={explorer:'Inspect the project and gather evidence. Return concise findings.',worker:'Implement the assigned change and verify it.',reviewer:'Review correctness and risks. Return actionable findings.'};
function normalizeConfig(value) {
  if(!value||typeof value!=='object')return defaults;
  const legacy=value.version!==2, savedRoles=Array.isArray(value.roles)?value.roles:[];
  const roles=savedRoles.map(saved=>{
    const preset=roleDefaults.find(role=>role.name===saved.name);
    if(!preset)return {name:saved.name,description:'Custom agent role',model:'',reasoningEffort:'',sandboxMode:'',enabled:true,...saved};
    const role={...preset,...saved,description:saved.description||preset.description,model:saved.model===undefined?preset.model:saved.model,reasoningEffort:saved.reasoningEffort===undefined?preset.reasoningEffort:saved.reasoningEffort,sandboxMode:saved.sandboxMode===undefined?preset.sandboxMode:saved.sandboxMode,enabled:saved.enabled!==false};
    if(legacy&&legacyInstructions[saved.name]===saved.instructions)role.instructions=preset.instructions;
    return role;
  });
  if(legacy)for(const role of roleDefaults)if(!roles.some(item=>item.name===role.name))roles.push({...role});
  return {...defaults,...value,version:2,coordinatorInstructions:value.coordinatorInstructions||defaultCoordinatorInstructions,roles};
}
let config=normalizeConfig(existsSync(configFile)?JSON.parse(readFileSync(configFile,'utf8')):defaults);
recoverAgentDefinitions(agentTransactionFile);
const state=createState(), clients=new Set(), pending=new Map(), token=randomBytes(24).toString('hex');
let codexThreads=[],historyBusy=false,historyTask=Promise.resolve();
if(existsSync(historyFile)) {
  const old=JSON.parse(readFileSync(historyFile,'utf8'));
  state.runs=old.runs||[];state.agents=old.agents||{};state.events=old.events||[];
  for(const a of Object.values(state.agents)) if(['running','waiting','queued'].includes(a.status)) a.status='unknown';
  for(const r of state.runs) if(['running','starting'].includes(r.status)) r.status='unknown';
}
let proc, readyPromise, seq=0, starting=false, saveTimer;
const hydrated=new Set();
const snapshot=()=>({...state,config});
function persist() {const temp=historyFile+'.tmp';writeFileSync(temp,JSON.stringify({runs:state.runs,agents:state.agents,events:state.events},null,2));renameSync(temp,historyFile);}
function publish() {
  const payload=`data: ${JSON.stringify(snapshot())}\n\n`;
  for(const c of clients) {if(c.writableLength>2e6) {c.destroy();clients.delete(c);} else c.write(payload);}
  clearTimeout(saveTimer);saveTimer=setTimeout(()=>{try{persist();}catch(e){console.error('Cannot save history:',e.message);}},500);
}
function send(message) {if(!proc||proc.killed) throw Error('Codex disconnected');proc.stdin.write(JSON.stringify(message)+'\n');}
function rpc(method,params={}) {
  return new Promise((resolve,reject)=>{
    const id=++seq, timer=setTimeout(()=>{pending.delete(id);reject(Error(`${method}: timeout`));},45000);
    pending.set(id,{resolve,reject,timer});
    try{send({id,method,params});}catch(e){clearTimeout(timer);pending.delete(id);reject(e);}
  });
}
function disconnected(message) {
  state.connected=false;state.error=message;readyPromise=null;
  for(const p of pending.values()) {clearTimeout(p.timer);p.reject(Error(message));} pending.clear();
  state.approvals=[];
  for(const a of Object.values(state.agents)) if(['running','waiting','queued'].includes(a.status)) a.status='unknown';
  for(const r of state.runs) if(['running','starting'].includes(r.status)) r.status='unknown';
  hydrated.clear();
  publish();
}
function onMessage(msg) {
  if(msg.id!==undefined && !msg.method) {
    const p=pending.get(msg.id);if(!p)return;
    clearTimeout(p.timer);pending.delete(msg.id);
    msg.error?p.reject(Error(msg.error.message)):p.resolve(msg.result);return;
  }
  if(msg.id!==undefined && msg.method) {
    if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(msg.method)) {
      state.approvals.push({id:msg.id,method:msg.method,params:msg.params});
      const a=state.agents[msg.params?.threadId];if(a)a.status='waiting';
      record(state,'approval/requested',msg.params?.command||msg.params?.reason||msg.method,msg.params?.threadId);publish();return;
    }
    // Unsupported interactive requests fail explicitly rather than hanging a run.
    send({id:msg.id,error:{code:-32601,message:'This dashboard does not support '+msg.method}});
    record(state,'request/unsupported',msg.method,msg.params?.threadId);publish();return;
  }
  reduceEvent(state,msg.method,msg.params);
  const item=msg.params?.item;
  const childIds=item?.type==='subAgentActivity'?[item.agentThreadId]:['collabAgentToolCall','collabToolCall'].includes(item?.type)?(item.receiverThreadIds||[item.newThreadId||item.receiverThreadId]):[];
  for(const childId of childIds) if(childId&&!hydrated.has(childId)&&state.agents[childId]) {
    hydrated.add(childId);
    rpc('thread/read',{threadId:childId,includeTurns:false}).then(({thread})=>{
      const a=state.agents[childId];if(a){a.task=thread.preview||a.task;a.model=thread.model||a.model;a.reasoningEffort=thread.reasoningEffort||a.reasoningEffort||null;a.name=thread.agentNickname||thread.agentRole||a.name;publish();}
    }).catch(()=>{hydrated.delete(childId);});
  }
  if(msg.method==='serverRequest/resolved') state.approvals=state.approvals.filter(x=>x.id!==msg.params?.requestId);
  publish();
}
async function connect() {
  if(readyPromise) return readyPromise;
  readyPromise=(async()=>{
    proc=spawn(process.env.CODEX_BIN||'codex',['app-server','--stdio'],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
    proc.on('error',e=>disconnected(e.message));proc.on('exit',(code)=>disconnected('Codex App Server stopped ('+code+')'));
    proc.stdin.on('error',()=>{});proc.stderr.on('data',()=>{});
    createInterface({input:proc.stdout}).on('line',line=>{try{onMessage(JSON.parse(line));}catch(e){console.error('Protocol error:',e.message);}});
    await rpc('initialize',{clientInfo:{name:'acode_dashboard',title:'Acode Agent Dashboard',version:'0.1.0'},capabilities:{experimentalApi:true}});
    send({method:'initialized',params:{}});
    const account=await rpc('account/read',{refreshToken:false});
    state.account=account.account?{type:account.account.type,planType:account.account.planType||null}:null;
    await refreshModels();
    state.connected=true;state.error=null;publish();
    await Promise.allSettled(Object.values(state.agents).filter(a=>!a.model||!a.reasoningEffort||a.name==='Agent').map(async a=>{
      const {thread}=await rpc('thread/read',{threadId:a.id,includeTurns:false});
      a.model=thread.model||null;
      a.reasoningEffort=thread.reasoningEffort||a.reasoningEffort||null;
      a.name=thread.agentNickname||thread.agentRole||a.name;
    }));
    await reconcileDashboardRuns();publish();
  })().catch(e=>{state.error=e.message;publish();readyPromise=null;throw e;});
  return readyPromise;
}
let reconcilingRuns=false;
async function reconcileDashboardRuns(){
  if(reconcilingRuns||!state.connected)return;
  reconcilingRuns=true;
  let changed=false;
  try{
    const runs=state.runs.filter(run=>!run.external&&run.threadId&&['starting','running','unknown'].includes(run.status));
    const runIds=new Set(runs.map(run=>run.id));
    const agents=Object.values(state.agents).filter(agent=>runIds.has(agent.runId));
    await Promise.allSettled(agents.map(async agent=>{
      const observedAt=agent.updatedAt;
      const before=JSON.stringify(agent);
      const {thread}=await rpc('thread/read',{threadId:agent.id,includeTurns:true});
      if(state.agents[agent.id]?.updatedAt===observedAt){reconcileThreadSnapshot(state,thread);if(before!==JSON.stringify(agent))changed=true;}
    }));
    return changed;
  }finally{reconcilingRuns=false;}
}
async function refreshModels() {
  const models=[];let cursor=null;
  do {
    const page=await rpc('model/list',{includeHidden:true,limit:100,cursor});
    models.push(...(page.data||[]));cursor=page.nextCursor;
  } while(cursor);
  state.models=models.map(m=>({id:m.id,model:m.model,displayName:m.displayName,isDefault:m.isDefault,hidden:!!m.hidden,defaultReasoningEffort:m.defaultReasoningEffort,supportedReasoningEfforts:m.supportedReasoningEfforts||[]}));
}
function briefThread(t){const source=typeof t.source==='string'?t.source:t.source?.kind||t.source?.type||'Codex';return {id:t.id,name:t.name||'',preview:t.preview||'',model:t.model||null,cwd:t.cwd||'',source,updatedAt:t.updatedAt,archived:t._archived??!!t.archived,status:t.status?.type||'unknown'};}
async function syncCodexHistory(full=false){
  if(historyBusy){if(!full)return {count:codexThreads.length};await historyTask.catch(()=>{});return syncCodexHistory(full);}
  historyBusy=true;
  historyTask=(async()=>{try{
    const pages=[];
    for(const archived of (full?[false,true]:[false])){
      let cursor=null;
      do{
        const page=await rpc('thread/list',{limit:full?100:50,cursor,sortKey:'recency_at',sourceKinds:['cli','vscode'],archived});
        pages.push(...(page.data||[]).filter(t=>!t.ephemeral).map(t=>({...t,_archived:archived})));cursor=full?page.nextCursor:null;
      }while(cursor);
    }
    const merged=new Map((full?[]:codexThreads).map(t=>[t.id,t]));for(const t of pages)merged.set(t.id,briefThread(t));
    codexThreads=[...merged.values()].sort(compareThreadRecency);
    state.historySync={at:new Date().toISOString(),count:codexThreads.length,error:null};publish();
    return {count:codexThreads.length};
  }catch(e){state.historySync={...state.historySync,error:e.message};publish();throw e;}
  })().finally(()=>{historyBusy=false;});
  return historyTask;
}
async function readCodexThread(threadId){
  if(typeof threadId!=='string'||threadId.length>100)throw Error('Invalid Codex thread id');
  const {thread}=await rpc('thread/read',{threadId,includeTurns:true});
  const messages=[];
  for(const turn of thread.turns||[])for(const item of turn.items||[]){
    if(item.type==='userMessage'){
      const text=(item.content||[]).map(c=>c.type==='text'?c.text:c.type==='image'?'[ภาพ]':'').filter(Boolean).join('\n');if(text)messages.push({role:'user',text,at:turn.startedAt});
    }else if(item.type==='agentMessage'&&item.text)messages.push({role:'assistant',text:item.text,at:turn.startedAt});
  }
  const meta={...briefThread(thread),archived:codexThreads.find(t=>t.id===thread.id)?.archived||false},id='codex-history:'+thread.id;
  const existing=state.runs.find(r=>r.threadId===thread.id);
  if(existing){existing.model=thread.model||existing.model;existing.reasoningEffort=thread.reasoningEffort||existing.reasoningEffort||null;existing.archived=meta.archived;}
  else state.runs.push({id,prompt:meta.name||meta.preview||'Codex chat',status:'completed',startedAt:new Date(thread.createdAt*1000).toISOString(),finishedAt:new Date((thread.updatedAt||thread.createdAt)*1000).toISOString(),threadId:thread.id,workspace:thread.cwd,model:thread.model||null,reasoningEffort:thread.reasoningEffort||null,source:meta.source,archived:meta.archived,external:true});
  ensureAgent(state,thread.id,{name:'Coordinator',runId:existing?.id||id,model:thread.model||null,reasoningEffort:thread.reasoningEffort||existing?.reasoningEffort||null,task:meta.preview||meta.name||'',status:thread.status?.type==='active'?'running':'completed',output:messages.filter(m=>m.role==='assistant').at(-1)?.text||''});
  publish();return {thread:meta,messages,runId:existing?.id||id};
}
const sandboxModes=['read-only','workspace-write','danger-full-access'],approvalPolicies=['untrusted','on-request','never'];
function validateEffort(modelId,effort,label) {
  const model=state.models.find(m=>(m.model||m.id)===(modelId||state.models.find(x=>x.isDefault)?.model));
  if(typeof effort!=='string'||(effort&&!model?.supportedReasoningEfforts.some(e=>e.reasoningEffort===effort)))throw Error(label+' reasoning level is not supported by the selected model');
}
function validateConfig(value) {
  if(!value||typeof value.workspace!=='string'||!path.isAbsolute(value.workspace)||!existsSync(value.workspace)||!statSync(value.workspace).isDirectory())throw Error('Workspace must be an existing absolute directory');
  if(!Number.isInteger(value.maxAgents)||value.maxAgents<1||value.maxAgents>8)throw Error('Max agents must be between 1 and 8');
  const maxSolAgents=value.maxSolAgents??defaults.maxSolAgents;
  if(!Number.isInteger(maxSolAgents)||maxSolAgents<0||maxSolAgents>8)throw Error('Max Sol agents must be between 0 and 8');
  const solTokenWarning=value.solTokenWarning??defaults.solTokenWarning;
  if(!Number.isInteger(solTokenWarning)||solTokenWarning<0||solTokenWarning>10_000_000)throw Error('Sol token warning must be between 0 and 10,000,000');
  const workflowPreset=value.workflowPreset??'custom';
  if(!['custom','fast','balanced','safe'].includes(workflowPreset))throw Error('Choose a supported workflow preset');
  const tokenRates=value.tokenRates??{};
  if(!tokenRates||typeof tokenRates!=='object'||Array.isArray(tokenRates)||Object.keys(tokenRates).length>100)throw Error('Invalid token price table');
  for(const [model,rates] of Object.entries(tokenRates)){
    if(!model||model.length>100||!rates||typeof rates!=='object'||Array.isArray(rates))throw Error('Invalid token price for '+model);
    for(const key of ['input','cachedInput','cacheWrite','output'])if(rates[key]!==undefined&&(!Number.isFinite(rates[key])||rates[key]<0||rates[key]>1_000_000))throw Error('Token prices must be non-negative numbers');
  }
  if(typeof value.model!=='string'||value.model.length>100)throw Error('Invalid coordinator model');
  const reasoningEffort=value.reasoningEffort??'';
  validateEffort(value.model,reasoningEffort,'Coordinator');
  const approvalPolicy=value.approvalPolicy||'on-request',sandboxMode=value.sandboxMode||'workspace-write';
  if(!approvalPolicies.includes(approvalPolicy))throw Error('Choose a supported approval mode');
  if(!sandboxModes.includes(sandboxMode))throw Error('Choose a supported sandbox mode');
  if(typeof value.coordinatorInstructions!=='string'||!value.coordinatorInstructions.trim()||value.coordinatorInstructions.length>8000)throw Error('Coordinator instructions must be 1–8,000 characters');
  if(!Array.isArray(value.roles)||value.roles.length<1||value.roles.length>8)throw Error('Provide 1–8 roles');
  const roles=value.roles.map(role=>{
    if(!role||!/^[a-z][a-z0-9_-]{0,39}$/.test(role.name)||typeof role.enabled!=='boolean')throw Error('Role names must use lowercase letters, digits, _ or -');
    if(typeof role.description!=='string'||!role.description.trim()||role.description.length>500)throw Error('Role description must be 1–500 characters');
    if(typeof role.model!=='string'||role.model.length>100)throw Error('Invalid model for '+role.name);
    if(typeof role.reasoningEffort!=='string')throw Error('Invalid reasoning level for '+role.name);
    validateEffort(role.model||value.model,role.reasoningEffort,role.name);
    if(!['',...sandboxModes].includes(role.sandboxMode))throw Error('Choose a supported permission mode for '+role.name);
    if(typeof role.instructions!=='string'||!role.instructions.trim()||role.instructions.length>4000)throw Error('Instructions for '+role.name+' must be 1–4,000 characters');
    return {name:role.name,description:role.description,model:role.model,reasoningEffort:role.reasoningEffort,sandboxMode:role.sandboxMode,enabled:role.enabled,instructions:role.instructions};
  });
  if(new Set(roles.map(r=>r.name)).size!==roles.length)throw Error('Role names must be unique');
  return {version:2,workspace:path.resolve(value.workspace),model:value.model,reasoningEffort,maxAgents:value.maxAgents,maxSolAgents,solTokenWarning,workflowPreset,tokenRates,approvalPolicy,sandboxMode,coordinatorInstructions:value.coordinatorInstructions,roles};
}
function saveConfig(value) {
  const next=validateConfig(value);
  writeAgentDefinitions(next,config,{transactionFile:agentTransactionFile});
  const temp=configFile+'.tmp';writeFileSync(temp,JSON.stringify(next,null,2));renameSync(temp,configFile);
  config=next;publish();
}
async function startRun(input) {
  if(starting)throw Error('Another start or resume request is being prepared. Try again in a moment.');
  if(activeDashboardRunCount(state.runs)>=maxConcurrentRuns)throw Error('Dashboard supports up to '+maxConcurrentRuns+' active runs at once. Wait for one to finish.');
  if(typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>20000) throw Error('Enter a task (up to 20,000 characters)');
  const cfg=validateConfig(config);writeAgentDefinitions(cfg,cfg,{transactionFile:agentTransactionFile});starting=true;
  const run={id:randomUUID(),prompt:input.prompt.trim(),status:'starting',startedAt:new Date().toISOString(),threadId:null,workspace:cfg.workspace,workflowPreset:cfg.workflowPreset};
  try {
    await connect();if(!state.account) throw Error('Sign in to Codex first: run codex login in your terminal');
    const roles=cfg.roles.filter(role=>role.enabled);
    const instructions=cfg.coordinatorInstructions+'\n\nConfigured custom agent roles (delegate using these exact names only):\n'+roles.map(role=>'- '+role.name+' ('+role.model+', '+(role.reasoningEffort||'model default')+'): '+role.description).join('\n')+'\n\nDo not create more than '+cfg.maxAgents+' subagents at once. Use no more than '+cfg.maxSolAgents+' Sol-model subagents across this run, including sequential replacements; once the limit is reached, use a Luna role or do the task yourself. This Sol limit is a coordinator instruction, not an enforced server-side gate. Whenever delegating to a Sol role, start its delegation prompt with "Reason: <short, concrete escalation reason>". Wait for delegated results before dependent work or the final summary. If no role matches, handle the task yourself.';
    const chosenModel=cfg.model||(state.models.find(m=>m.isDefault)?.model);
    if(!chosenModel) throw Error('No available default model. Choose a model in Configuration.');
    const params={model:chosenModel,cwd:cfg.workspace,approvalPolicy:cfg.approvalPolicy,sandbox:cfg.sandboxMode,developerInstructions:instructions,config:{'agents.enabled':roles.length>0,'agents.max_concurrent_threads_per_session':cfg.maxAgents,'agents.default_subagent_model':chosenModel}};
    const effort=cfg.reasoningEffort||state.models.find(m=>m.model===chosenModel)?.defaultReasoningEffort;
    if(effort){params.config.model_reasoning_effort=effort;params.config['agents.default_subagent_reasoning_effort']=effort;}
    run.model=chosenModel;
    const result=await rpc('thread/start',params);
    run.reasoningEffort=result.reasoningEffort||result.thread.reasoningEffort||effort||null;
    run.threadId=result.thread.id;state.runs.unshift(run);
    ensureAgent(state,run.threadId,{name:'Coordinator',runId:run.id,model:result.model||result.thread.model||chosenModel,reasoningEffort:run.reasoningEffort,task:run.prompt,status:'queued'});publish();
    const reply=await rpc('turn/start',{threadId:run.threadId,input:[{type:'text',text:run.prompt,text_elements:[]}]});
    const a=state.agents[run.threadId];a.turnId=reply.turn.id;
    // A very short turn may finish before the start response arrives.
    if(run.status==='starting') run.status='running';
    if(a.status==='queued') a.status='running';
    record(state,'run/started',run.prompt,run.threadId);publish();return {runId:run.id};
  } catch(e) {if(run.threadId){run.status='error';ensureAgent(state,run.threadId,{status:'error',activity:e.message});publish();}throw e;} finally {starting=false;}
}
const busyThreadMessage='thread นี้ถูก Codex/VS Code อีก instance ล็อกไว้ จึงสั่งต่อใน thread เดิมจาก Dashboard ไม่ได้ ให้ปิด thread ต้นทางใน Codex/VS Code เพื่อปล่อย lock แล้วลองอีกครั้ง หรือเลือก “แยก branch แล้วสั่งต่อ” เพื่อทำงานต่อจากประวัติที่บันทึกไว้';
async function steerActiveThread(run,a,prompt) {
  let thread;
  try {({thread}=await rpc('thread/read',{threadId:run.threadId,includeTurns:true}));}
  catch {return null;}
  if(thread.status?.type!=='active')return null;
  if(thread.status.activeFlags?.includes('waitingOnApproval'))throw Error('thread นี้กำลังรออนุมัติคำสั่งใน Codex อีกหน้าต่าง กรุณาอนุมัติหรือปฏิเสธคำขอนั้นก่อน');
  const turn=[...(thread.turns||[])].reverse().find(item=>item.status==='inProgress');
  if(!turn||thread.canAcceptDirectInput===false)throw Error(busyThreadMessage);
  try {
    const reply=await rpc('turn/steer',{threadId:run.threadId,expectedTurnId:turn.id,input:[{type:'text',text:prompt,text_elements:[]}]});
    a.turnId=reply.turnId||turn.id;a.model=thread.model||a.model;a.reasoningEffort=thread.reasoningEffort||a.reasoningEffort||null;run.reasoningEffort=a.reasoningEffort;a.status='running';run.status='running';delete run.finishedAt;
    record(state,'run/continued',prompt,run.threadId);publish();return {runId:run.id,steered:true};
  } catch {throw Error(busyThreadMessage);}
}
async function forkAndContinue(sourceRun,prompt) {
  if(!sourceRun.external)throw Error('แยก branch ได้จาก thread ที่นำเข้าจาก Codex/VS Code เท่านั้น');
  starting=true;
  let run;
  try {
    await connect();if(!state.account)throw Error('Sign in to Codex first: run codex login in your terminal');
    const fork=await rpc('thread/fork',{threadId:sourceRun.threadId,excludeTurns:true});
    const thread=fork.thread;
    run={id:randomUUID(),prompt:'Branch: '+sourceRun.prompt,status:'starting',startedAt:new Date().toISOString(),threadId:thread.id,workspace:thread.cwd||sourceRun.workspace,model:fork.model||thread.model||sourceRun.model||null,reasoningEffort:fork.reasoningEffort||thread.reasoningEffort||sourceRun.reasoningEffort||null,workflowPreset:sourceRun.workflowPreset||config.workflowPreset,source:sourceRun.source,archived:false,external:false,forkedFromId:sourceRun.threadId,lastInput:prompt};
    state.runs.unshift(run);
    const agent=ensureAgent(state,thread.id,{name:'Coordinator',runId:run.id,model:run.model,reasoningEffort:run.reasoningEffort,task:prompt,status:'queued'});publish();
    const reply=await rpc('turn/start',{threadId:thread.id,input:[{type:'text',text:prompt,text_elements:[]}]});
    agent.turnId=reply.turn.id;if(run.status==='starting')run.status='running';if(agent.status==='queued')agent.status='running';
    record(state,'run/started',prompt,thread.id);publish();return {runId:run.id,forked:true};
  } catch(e) {
    if(run){run.status='error';run.finishedAt=new Date().toISOString();const a=state.agents[run.threadId];if(a){a.status='error';a.activity=e.message;}publish();}
    if(/active writer/i.test(e.message))throw Error('Codex ยังล็อกประวัติต้นทางอยู่ จึงสร้าง branch ไม่สำเร็จ ให้ปิด thread ต้นทางใน Codex/VS Code แล้วลองอีกครั้ง');
    throw e;
  } finally {starting=false;}
}
async function continueRun(input) {
  if(typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>20000) throw Error('Enter a follow-up (up to 20,000 characters)');
  const run=state.runs.find(r=>r.id===input.runId);
  if(!run?.threadId) throw Error('Choose a conversation started from this dashboard');
  const a=state.agents[run.threadId];if(!a) throw Error('Coordinator thread was not found');
  const external=!!run.external;
  const targetActive=external&&(['running','waiting'].includes(run.status)||['running','waiting'].includes(a.status));
  if(starting)throw Error('Another start or resume request is being prepared. Try again in a moment.');
  if(!['completed','error','interrupted','unknown'].includes(run.status)&&!targetActive) throw Error('This conversation is not ready for a follow-up');
  if(input.fork)return forkAndContinue(run,input.prompt.trim());
  const previousStatus=run.status,previousLastInput=run.lastInput;starting=true;run.status='starting';run.lastInput=input.prompt.trim();publish();
  try {
    await connect();if(!state.account) throw Error('Sign in to Codex first: run codex login in your terminal');
    if(run.external&&run.archived){await rpc('thread/unarchive',{threadId:run.threadId});run.archived=false;}
    const prompt=input.prompt.trim(),steered=await steerActiveThread(run,a,prompt);if(steered)return steered;
    let resumed;
    try {resumed=await rpc('thread/resume',{threadId:run.threadId});}
    catch(e) {if(/active writer/i.test(e.message)){const result=await steerActiveThread(run,a,prompt);if(result)return result;throw Error(busyThreadMessage);}throw e;}
    a.model=resumed.model||resumed.thread.model||a.model;a.reasoningEffort=resumed.reasoningEffort||resumed.thread.reasoningEffort||a.reasoningEffort||null;run.reasoningEffort=a.reasoningEffort;
    const reply=await rpc('turn/start',{threadId:run.threadId,input:[{type:'text',text:prompt,text_elements:[]}]});
    a.turnId=reply.turn.id;
    if(run.status==='starting'){run.status='running';a.status='running';}
    delete run.finishedAt;record(state,'run/continued',prompt,run.threadId);publish();return {runId:run.id};
  } catch(e) {
    if(run.status==='starting') run.status=previousStatus;
    if(run.lastInput===input.prompt.trim())run.lastInput=previousLastInput;
    a.activity=e.message;publish();throw e;
  } finally {starting=false;}
}
async function stopRun(id) {
  const run=state.runs.find(r=>r.id===id);if(!run)throw Error('Run not found');
  const agents=Object.values(state.agents).filter(a=>a.runId===id&&['running','waiting','queued'].includes(a.status));
  const results=await Promise.allSettled(agents.map(async a=>{
    if(!a.turnId) {const t=await rpc('thread/read',{threadId:a.id,includeTurns:true});a.turnId=t.thread.turns?.findLast(x=>x.status==='inProgress')?.id;}
    if(a.turnId) await rpc('turn/interrupt',{threadId:a.id,turnId:a.turnId});
    a.status='interrupted';
  }));
  if(results.some(r=>r.status==='rejected')) throw Error('Could not stop every agent; inspect current status');
  run.status='interrupted';publish();return {ok:true};
}
function saveSolFeedback(input){
  if(typeof input.runId!=='string'||typeof input.useful!=='boolean')throw Error('Choose whether Sol was useful for this run');
  const run=state.runs.find(item=>item.id===input.runId);
  if(!run||!['completed','error','interrupted'].includes(run.status))throw Error('Feedback is available after a run finishes');
  run.solUseful=input.useful;run.solFeedbackAt=new Date().toISOString();publish();return {ok:true};
}
async function readBody(req) {
  let body='';for await(const chunk of req) {body+=chunk;if(body.length>100000)throw Error('Request too large');}
  return JSON.parse(body||'{}');
}
const staticFiles={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/monitor.mjs':['monitor.mjs','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
const server=http.createServer(async(req,res)=>{
  const json=(value,code=200)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  try {
    if(req.headers.host!==`127.0.0.1:${port}`&&req.headers.host!==`localhost:${port}`) return json({error:'Invalid host'},403);
    if(req.headers.origin&&![origin,`http://localhost:${port}`].includes(req.headers.origin))return json({error:'Invalid origin'},403);
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    const url=new URL(req.url,origin);
    if(req.method==='GET'&&url.pathname==='/api/state')return json({...snapshot(),token});
    if(req.method==='GET'&&url.pathname==='/api/events') {
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write(`data: ${JSON.stringify(snapshot())}\n\n`);clients.add(res);
      const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),15000);req.on('close',()=>{clients.delete(res);clearInterval(heartbeat);});return;
    }
    if(req.method==='POST'&&url.pathname.startsWith('/api/')) {
      if(req.headers['x-acode-token']!==token) return json({error:'Reload dashboard to reconnect'},403);
      const body=await readBody(req);
      if(url.pathname==='/api/config') {saveConfig(body);return json({ok:true});}
      if(url.pathname==='/api/run')return json(await startRun(body));
      if(url.pathname==='/api/continue')return json(await continueRun(body));
      if(url.pathname==='/api/stop')return json(await stopRun(body.runId));
      if(url.pathname==='/api/run/feedback')return json(saveSolFeedback(body));
      if(url.pathname==='/api/reconnect'){
        await connect();const account=await rpc('account/read',{refreshToken:false});
        state.account=account.account?{type:account.account.type,planType:account.account.planType||null}:null;await refreshModels();publish();return json({ok:true});
      }
      if(url.pathname==='/api/models/refresh'){await connect();await refreshModels();publish();return json({models:state.models});}
      if(url.pathname==='/api/history/sync')return json(await syncCodexHistory(true));
      if(url.pathname==='/api/history/read')return json(await readCodexThread(body.threadId));
      if(url.pathname==='/api/approval') {
        const request=state.approvals.find(a=>a.id===body.id);if(!request||!['accept','decline'].includes(body.decision))throw Error('Invalid approval response');
        send({id:request.id,result:{decision:body.decision}});state.approvals=state.approvals.filter(a=>a.id!==request.id);
        const a=state.agents[request.params.threadId];if(a)a.status='running';publish();return json({ok:true});
      }
    }
    if(req.method==='GET'&&url.pathname==='/api/history'){
      const search=(url.searchParams.get('q')||'').trim().toLocaleLowerCase();const offset=Math.max(0,Number(url.searchParams.get('offset')||0));const limit=Math.min(100,Math.max(1,Number(url.searchParams.get('limit')||50)));
      const rows=search?codexThreads.filter(t=>(t.name+' '+t.preview+' '+t.cwd).toLocaleLowerCase().includes(search)):codexThreads;
      return json({threads:rows.slice(offset,offset+limit),total:rows.length,sync:state.historySync||null});
    }
    if(req.method==='GET'&&staticFiles[url.pathname]) {const [file,type]=staticFiles[url.pathname];res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-cache'});return res.end(readFileSync(path.join(root,file)));}
    json({error:'Not found'},404);
  }catch(e){json({error:e.message},400);}
});
server.listen(port,'127.0.0.1',()=>{console.log('Acode dashboard: '+origin);connect().then(()=>syncCodexHistory(true)).catch(()=>{});});
setInterval(()=>{if(state.connected)reconcileDashboardRuns().then(changed=>{if(changed)publish();}).catch(()=>{});},5000).unref();
setInterval(()=>{if(state.connected&&!historyBusy)syncCodexHistory(false).catch(()=>{});},30000).unref();
server.on('error',e=>{console.error(e.message);proc?.kill();process.exitCode=1;});
function shutdown(){clearTimeout(saveTimer);try{persist();}catch{}proc?.kill();for(const c of clients)c.end();server.close(()=>process.exit());setTimeout(()=>process.exit(),2000).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
