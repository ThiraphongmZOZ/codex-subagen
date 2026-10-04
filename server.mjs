import http from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFileSync,writeFileSync,mkdirSync,existsSync,statSync,renameSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {createState,record,ensureAgent,reduceEvent} from './monitor.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const port=Number(process.env.PORT||4310), origin=`http://127.0.0.1:${port}`;
const dataDir=path.join(root,'data');mkdirSync(dataDir,{recursive:true});
const configFile=path.join(dataDir,'config.json'), historyFile=path.join(dataDir,'history.json');
const defaults={workspace:root,model:'',maxAgents:3,roles:[{name:'explorer',instructions:'Inspect the project and gather evidence. Return concise findings.'},{name:'worker',instructions:'Implement the assigned change and verify it.'},{name:'reviewer',instructions:'Review correctness and risks. Return actionable findings.'}]};
let config=existsSync(configFile)?JSON.parse(readFileSync(configFile,'utf8')):defaults;
const state=createState(), clients=new Set(), pending=new Map(), token=randomBytes(24).toString('hex');
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
  const childId=msg.params?.item?.type==='subAgentActivity'?msg.params.item.agentThreadId:null;
  if(childId&&!hydrated.has(childId)&&state.agents[childId]) {
    hydrated.add(childId);
    rpc('thread/read',{threadId:childId,includeTurns:false}).then(({thread})=>{
      const a=state.agents[childId];if(a){a.task=thread.preview||a.task;a.model=thread.model||a.model;publish();}
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
    await Promise.allSettled(Object.values(state.agents).filter(a=>!a.model).map(async a=>{
      const {thread}=await rpc('thread/read',{threadId:a.id,includeTurns:false});
      a.model=thread.model||null;
    }));publish();
  })().catch(e=>{state.error=e.message;publish();readyPromise=null;throw e;});
  return readyPromise;
}
async function refreshModels() {
  const models=[];let cursor=null;
  do {
    const page=await rpc('model/list',{includeHidden:true,limit:100,cursor});
    models.push(...(page.data||[]));cursor=page.nextCursor;
  } while(cursor);
  state.models=models.map(m=>({id:m.id,model:m.model,displayName:m.displayName,isDefault:m.isDefault,hidden:!!m.hidden}));
}
function validateConfig(value) {
  if(!value || typeof value.workspace!=='string'||!path.isAbsolute(value.workspace)||!existsSync(value.workspace)||!statSync(value.workspace).isDirectory()) throw Error('Workspace must be an existing absolute directory');
  if(!Number.isInteger(value.maxAgents)||value.maxAgents<1||value.maxAgents>8) throw Error('Max agents must be between 1 and 8');
  if(typeof value.model!=='string'||value.model.length>100) throw Error('Invalid model');
  if(!Array.isArray(value.roles)||value.roles.length<1||value.roles.length>8) throw Error('Provide 1–8 roles');
  for(const role of value.roles) if(!/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(role.name)||typeof role.instructions!=='string'||!role.instructions.trim()||role.instructions.length>4000) throw Error('Invalid role name or instructions');
  if(new Set(value.roles.map(r=>r.name)).size!==value.roles.length) throw Error('Role names must be unique');
  return {workspace:path.resolve(value.workspace),model:value.model,maxAgents:value.maxAgents,roles:value.roles.map(r=>({name:r.name,instructions:r.instructions}))};
}
async function startRun(input) {
  if(starting||state.runs.some(r=>['starting','running'].includes(r.status))||Object.values(state.agents).some(a=>['running','waiting','queued'].includes(a.status))) throw Error('A run is already active. Stop it or wait for completion.');
  if(typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>20000) throw Error('Enter a task (up to 20,000 characters)');
  const cfg=validateConfig(config);starting=true;
  const run={id:randomUUID(),prompt:input.prompt.trim(),status:'starting',startedAt:new Date().toISOString(),threadId:null,workspace:cfg.workspace};
  try {
    await connect();if(!state.account) throw Error('Sign in to Codex first: run codex login in your terminal');
    const instructions='You are the coordinator for Acode. Delegate independent tasks to subagents when useful. Name each subagent after its assigned role, tell it its task, and collect results. For the live monitor, instruct each subagent to begin its work with a brief visible commentary line starting with "งาน: " followed by its actual assigned task. If you are a subagent, begin with that task commentary yourself before doing the work. Do not spawn more than '+cfg.maxAgents+' concurrent subagents. Avoid concurrent edits to the same files. Roles:\n'+cfg.roles.map(r=>r.name+': '+r.instructions).join('\n');
    const chosenModel=cfg.model||(state.models.find(m=>m.isDefault)?.model);
    if(!chosenModel) throw Error('No available default model. Choose a model in Configuration.');
    const params={model:chosenModel,cwd:cfg.workspace,approvalPolicy:'on-request',sandbox:'workspace-write',developerInstructions:instructions,config:{'agents.enabled':true,'agents.max_concurrent_threads_per_session':cfg.maxAgents,'agents.default_subagent_model':chosenModel}};
    run.model=chosenModel;
    const result=await rpc('thread/start',params);
    run.threadId=result.thread.id;state.runs.unshift(run);
    ensureAgent(state,run.threadId,{name:'Coordinator',runId:run.id,model:result.model||result.thread.model||chosenModel,task:run.prompt,status:'queued'});publish();
    const reply=await rpc('turn/start',{threadId:run.threadId,input:[{type:'text',text:run.prompt,text_elements:[]}]});
    const a=state.agents[run.threadId];a.turnId=reply.turn.id;
    // A very short turn may finish before the start response arrives.
    if(run.status==='starting') run.status='running';
    if(a.status==='queued') a.status='running';
    record(state,'run/started',run.prompt,run.threadId);publish();return {runId:run.id};
  } catch(e) {if(run.threadId){run.status='error';ensureAgent(state,run.threadId,{status:'error',activity:e.message});publish();}throw e;} finally {starting=false;}
}
async function continueRun(input) {
  if(starting||state.runs.some(r=>['starting','running'].includes(r.status))||Object.values(state.agents).some(a=>['running','waiting','queued'].includes(a.status))) throw Error('A run is already active. Wait for completion or stop it first.');
  if(typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>20000) throw Error('Enter a follow-up (up to 20,000 characters)');
  const run=state.runs.find(r=>r.id===input.runId);
  if(!run?.threadId) throw Error('Choose a conversation started from this dashboard');
  if(!['completed','error','interrupted','unknown'].includes(run.status)) throw Error('This conversation is not ready for a follow-up');
  const a=state.agents[run.threadId];if(!a) throw Error('Coordinator thread was not found');
  const previousStatus=run.status;starting=true;run.status='starting';run.lastInput=input.prompt.trim();publish();
  try {
    await connect();if(!state.account) throw Error('Sign in to Codex first: run codex login in your terminal');
    const resumed=await rpc('thread/resume',{threadId:run.threadId});a.model=resumed.model||resumed.thread.model||a.model;
    const reply=await rpc('turn/start',{threadId:run.threadId,input:[{type:'text',text:input.prompt.trim(),text_elements:[]}]});
    a.turnId=reply.turn.id;
    if(run.status==='starting'){run.status='running';a.status='running';}
    delete run.finishedAt;record(state,'run/continued',input.prompt.trim(),run.threadId);publish();return {runId:run.id};
  } catch(e) {
    if(run.status==='starting') run.status=previousStatus;
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
async function readBody(req) {
  let body='';for await(const chunk of req) {body+=chunk;if(body.length>100000)throw Error('Request too large');}
  return JSON.parse(body||'{}');
}
const staticFiles={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
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
      if(url.pathname==='/api/config') {config=validateConfig(body);const tmp=configFile+'.tmp';writeFileSync(tmp,JSON.stringify(config,null,2));renameSync(tmp,configFile);publish();return json({ok:true});}
      if(url.pathname==='/api/run')return json(await startRun(body));
      if(url.pathname==='/api/continue')return json(await continueRun(body));
      if(url.pathname==='/api/stop')return json(await stopRun(body.runId));
      if(url.pathname==='/api/reconnect'){
        await connect();const account=await rpc('account/read',{refreshToken:false});
        state.account=account.account?{type:account.account.type,planType:account.account.planType||null}:null;await refreshModels();publish();return json({ok:true});
      }
      if(url.pathname==='/api/models/refresh'){await connect();await refreshModels();publish();return json({models:state.models});}
      if(url.pathname==='/api/approval') {
        const request=state.approvals.find(a=>a.id===body.id);if(!request||!['accept','decline'].includes(body.decision))throw Error('Invalid approval response');
        send({id:request.id,result:{decision:body.decision}});state.approvals=state.approvals.filter(a=>a.id!==request.id);
        const a=state.agents[request.params.threadId];if(a)a.status='running';publish();return json({ok:true});
      }
    }
    if(req.method==='GET'&&staticFiles[url.pathname]) {const [file,type]=staticFiles[url.pathname];res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-cache'});return res.end(readFileSync(path.join(root,file)));}
    json({error:'Not found'},404);
  }catch(e){json({error:e.message},400);}
});
server.listen(port,'127.0.0.1',()=>{console.log('Acode dashboard: '+origin);connect().catch(()=>{});});
server.on('error',e=>{console.error(e.message);proc?.kill();process.exitCode=1;});
function shutdown(){clearTimeout(saveTimer);try{persist();}catch{}proc?.kill();for(const c of clients)c.end();server.close(()=>process.exit());setTimeout(()=>process.exit(),2000).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
