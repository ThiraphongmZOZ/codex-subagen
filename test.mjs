import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,unlinkSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createState,ensureAgent,reduceEvent,reconcileThreadSnapshot,compareThreadRecency,sumTokenUsage,estimateTokenCost,solTokenUsage,solTokenWarningExceeded,delegationReason,delegationReasonLabel,agentsForRun,activeDashboardRunCount,maxConcurrentRuns} from './monitor.mjs';
import {roleDefaults,writeAgentDefinitions,recoverAgentDefinitions} from './agent-config.mjs';
test('real protocol events build a parent/child tree and maintain completed status',()=>{
 const s=createState();s.runs.push({id:'run',threadId:'root',status:'running'});
 ensureAgent(s,'root',{runId:'run',name:'Coordinator'});
 reduceEvent(s,'turn/started',{threadId:'root',turn:{id:'turn'}});
 reduceEvent(s,'item/completed',{threadId:'root',item:{type:'collabAgentToolCall',tool:'spawnAgent',receiverThreadIds:['child'],prompt:'Review code',agentsStates:{child:{status:'running'}}}});
 assert.equal(s.agents.child.parentId,'root');assert.equal(s.agents.child.runId,'run');assert.equal(s.agents.child.task,'Review code');
 reduceEvent(s,'thread/started',{thread:{id:'child',parentThreadId:'root',model:'gpt-6-luna',agentNickname:'Reviewer'}});
 assert.equal(s.agents.child.model,'gpt-6-luna');assert.equal(s.agents.child.name,'Reviewer');
 reduceEvent(s,'item/agentMessage/delta',{threadId:'child',delta:'Result'});assert.equal(s.agents.child.output,'Result');
 reduceEvent(s,'turn/completed',{threadId:'child',turn:{status:'completed'}});
 reduceEvent(s,'thread/status/changed',{threadId:'child',status:{type:'idle'}});assert.equal(s.agents.child.status,'completed');
 reduceEvent(s,'turn/completed',{threadId:'root',turn:{status:'failed',error:{message:'Access denied'}}});assert.equal(s.runs[0].status,'error');
 reduceEvent(s,'thread/started',{thread:{id:'unrelated'}});assert.equal(s.agents.unrelated,undefined);
});
test('current subAgentActivity events report child lifecycle without fake counts',()=>{
 const s=createState();ensureAgent(s,'root',{runId:'r'});
 const item={type:'subAgentActivity',id:'i',agentThreadId:'child',agentPath:'/root/reviewer',kind:'started'};
 reduceEvent(s,'item/started',{threadId:'root',item});
 reduceEvent(s,'item/completed',{threadId:'root',item});
 assert.equal(Object.keys(s.agents).length,2);assert.equal(s.agents.child.status,'running');
 reduceEvent(s,'item/completed',{threadId:'root',item:{...item,kind:'completed'}});assert.equal(s.agents.child.status,'completed');
 reduceEvent(s,'item/completed',{threadId:'child',item:{type:'agentMessage',text:'งาน: ตรวจความถูกต้อง\nผลลัพธ์'}});
 assert.equal(s.agents.child.task,'ตรวจความถูกต้อง');
 reduceEvent(s,'turn/completed',{threadId:'child',turn:{status:'failed',error:{message:'failed'}}});
 reduceEvent(s,'item/completed',{threadId:'root',item:{...item,kind:'completed'}});
 assert.equal(s.agents.child.status,'error');
});
test('history recency sorts ISO dates and Unix timestamps newest first',()=>{
 const threads=[
  {id:'older',updatedAt:'2026-10-02T00:00:00.000Z'},
  {id:'missing'},
  {id:'newer',updatedAt:'2026-10-04T00:00:00.000Z'},
  {id:'unix',updatedAt:1791072000},
  {id:'milliseconds',updatedAt:1791072000000},
  {id:'numeric-string',updatedAt:'1791072000'}
 ];
 assert.deepEqual(threads.sort(compareThreadRecency).map(thread=>thread.id),['newer','unix','milliseconds','numeric-string','older','missing']);
});
test('thread token usage is retained and summed by agent without double-counting output details',()=>{
 const s=createState();ensureAgent(s,'root',{runId:'r'});ensureAgent(s,'child',{runId:'r'});
 reduceEvent(s,'thread/tokenUsage/updated',{threadId:'root',tokenUsage:{total:{totalTokens:150,inputTokens:100,cachedInputTokens:20,cacheWriteInputTokens:10,outputTokens:50,reasoningOutputTokens:8}}});
 reduceEvent(s,'thread/tokenUsage/updated',{threadId:'root',tokenUsage:{total:{totalTokens:150,inputTokens:100,cachedInputTokens:20,cacheWriteInputTokens:10,outputTokens:50,reasoningOutputTokens:8}}});
 reduceEvent(s,'thread/tokenUsage/updated',{threadId:'child',tokenUsage:{total:{totalTokens:40,inputTokens:25,cachedInputTokens:5,cacheWriteInputTokens:0,outputTokens:15,reasoningOutputTokens:3}}});
 assert.equal(s.agents.root.tokenUsage.total.inputTokens,100);assert.equal(sumTokenUsage(Object.values(s.agents)).totalTokens,190);
});
test('API-equivalent estimate rejects invalid rates and ignores malformed token counts without NaN',()=>{
 const usage={inputTokens:100,cachedInputTokens:20,cacheWriteInputTokens:10,outputTokens:40};
 assert.equal(estimateTokenCost(usage,{input:1,cachedInput:0.5,cacheWrite:2,output:3}),0.00022);
 assert.equal(estimateTokenCost(usage,{input:1,output:3}),null);
 for(const rate of [NaN,Infinity,-1,null])assert.equal(estimateTokenCost(usage,{input:rate,cachedInput:0.5,cacheWrite:2,output:3}),null);
 const malformed={inputTokens:Infinity,cachedInputTokens:-3,cacheWriteInputTokens:'bad',outputTokens:NaN};
 assert.equal(estimateTokenCost(malformed,{input:1,cachedInput:1,cacheWrite:1,output:1}),0);
 assert.ok(Number.isFinite(sumTokenUsage([{tokenUsage:{total:{totalTokens:Infinity,inputTokens:-5}}}]).totalTokens));
});
test('agent selection and token totals stay scoped to one run',()=>{
 const agents=[{id:'a',runId:'one',tokenUsage:{total:{totalTokens:10}}},{id:'b',runId:'one',tokenUsage:{total:{totalTokens:5}}},{id:'c',runId:'two',tokenUsage:{total:{totalTokens:500}}}];
 assert.equal(sumTokenUsage(agentsForRun(agents,'one')).totalTokens,15);
 assert.deepEqual(agentsForRun(agents,'one').map(a=>a.id),['a','b']);
});
test('five interleaved runs keep reasons, tokens, and parent trees isolated',()=>{
 const s=createState(),expected=[];
 for(let i=0;i<5;i++){
  const runId='run-'+i,root='root-'+i,child='child-'+i;s.runs.push({id:runId,threadId:root,status:'running',workflowPreset:i%2?'balanced':'safe'});
  ensureAgent(s,root,{runId,name:'Coordinator'});reduceEvent(s,'item/completed',{threadId:root,item:{type:'collabAgentToolCall',tool:'spawnAgent',receiverThreadIds:[child],prompt:'Reason: issue-'+i+'\nInspect component'}});
  reduceEvent(s,'thread/tokenUsage/updated',{threadId:child,tokenUsage:{total:{totalTokens:100+i,inputTokens:80+i,outputTokens:20}}});
  reduceEvent(s,'thread/started',{thread:{id:child,parentThreadId:root,model:i%2?'gpt-6.1-sol':'gpt-6-luna',agentNickname:'Reviewer'}});
  expected.push({runId,root,child,token:100+i,reason:'issue-'+i});
 }
 for(const row of expected){
  const scoped=agentsForRun(Object.values(s.agents),row.runId);
  assert.deepEqual(scoped.map(a=>a.id).sort(),[row.child,row.root].sort());
  assert.equal(s.agents[row.child].parentId,row.root);assert.equal(s.agents[row.child].escalationReason,row.reason);
  assert.equal(sumTokenUsage(scoped).totalTokens,row.token);
 }
 assert.equal(activeDashboardRunCount(s.runs),5);assert.equal(maxConcurrentRuns,5);
});
test('restart reconciliation restores live thread status and stale event order cannot regress it',()=>{
 const s=createState();s.runs.push({id:'run',threadId:'root',status:'unknown',workflowPreset:'balanced'});
 ensureAgent(s,'root',{runId:'run',status:'unknown',tokenUsage:{total:{totalTokens:200}}});
 ensureAgent(s,'child',{runId:'run',parentId:'root',status:'unknown'});
 const restored=reconcileThreadSnapshot(s,{id:'root',status:{type:'active',activeFlags:[]},model:'gpt-6-luna',turns:[{id:'turn-2',status:'inProgress',items:[]}]});
 assert.equal(restored.status,'running');assert.equal(restored.turnId,'turn-2');assert.equal(s.runs[0].status,'running');
 reconcileThreadSnapshot(s,{id:'child',parentThreadId:'root',status:{type:'idle'},model:'gpt-6.1-sol',turns:[{id:'child-turn',status:'completed',items:[{type:'agentMessage',text:'Recovered result'}]}]});
 assert.equal(s.agents.child.parentId,'root');assert.equal(s.agents.child.output,'Recovered result');
 reduceEvent(s,'turn/completed',{threadId:'root',turn:{id:'turn-2',status:'completed'}});
 reduceEvent(s,'turn/started',{threadId:'root',turn:{id:'turn-2'}});
 assert.equal(s.agents.root.status,'completed');assert.equal(s.runs[0].status,'completed');
 reduceEvent(s,'thread/tokenUsage/updated',{threadId:'root',tokenUsage:{total:{totalTokens:100}}});
 assert.equal(s.agents.root.tokenUsage.total.totalTokens,200);
});
test('child and terminal turn events arriving before their metadata reconcile safely',()=>{
 const s=createState();
 reduceEvent(s,'thread/tokenUsage/updated',{threadId:'child',tokenUsage:{total:{totalTokens:24,outputTokens:4}}});
 reduceEvent(s,'thread/started',{thread:{id:'child',parentThreadId:'root',model:'gpt-6-luna'}});
 ensureAgent(s,'root',{runId:'run'});
 assert.equal(s.agents.child.parentId,'root');assert.equal(s.agents.child.runId,'run');assert.equal(s.agents.child.tokenUsage.total.totalTokens,24);
 const other=createState();ensureAgent(other,'thread',{runId:'run'});
 reduceEvent(other,'turn/completed',{threadId:'thread',turn:{id:'turn-1',status:'completed'}});
 reduceEvent(other,'turn/started',{threadId:'thread',turn:{id:'turn-1'}});
 assert.equal(other.agents.thread.status,'completed');assert.equal(other.agents.thread.turnId,'turn-1');
});
test('Sol token warning counts only Sol-model agents and accepts a disabled threshold',()=>{
 const agents=[{model:'gpt-6-luna',tokenUsage:{total:{totalTokens:900}}},{model:'gpt-6.1-sol',tokenUsage:{total:{totalTokens:2000}}}];
 assert.equal(solTokenUsage(agents),2000);assert.equal(solTokenWarningExceeded(agents,2000),false);assert.equal(solTokenWarningExceeded(agents,1999),true);assert.equal(solTokenWarningExceeded(agents,0),false);
});
test('delegation reason is read from the explicit first-line field',()=>{
 assert.equal(delegationReason('Reason: unclear root cause\nInspect these findings'), 'unclear root cause');
 assert.equal(delegationReason('Inspect these findings'),null);
 assert.equal(delegationReasonLabel(null),'ไม่ได้ระบุ');
 const s=createState();ensureAgent(s,'root',{runId:'r'});reduceEvent(s,'item/completed',{threadId:'root',item:{type:'collabAgentToolCall',tool:'spawnAgent',receiverThreadIds:['planner'],prompt:'Reason: cross-service data flow\nAnalyze the supplied evidence'}});assert.equal(s.agents.planner.escalationReason,'cross-service data flow');
 reduceEvent(s,'item/completed',{threadId:'root',item:{type:'collabAgentToolCall',tool:'spawnAgent',receiverThreadIds:['explorer'],prompt:'Inspect this file'}});assert.equal(s.agents.explorer.escalationReason,null);
});
test('agent config smoke test pins planner to Sol, worker to Luna, and cleans only managed files on workspace change',()=>{
 const base=mkdtempSync(path.join(os.tmpdir(),'acode-agent-smoke-')),oldWorkspace=path.join(base,'old'),newWorkspace=path.join(base,'new');
 const roles=roleDefaults.filter(role=>['planner','worker'].includes(role.name)).map(role=>({...role,enabled:true}));
 try{
  writeAgentDefinitions({workspace:oldWorkspace,roles},{workspace:oldWorkspace,roles:[]});
  const oldAgentDir=path.join(oldWorkspace,'.codex','agents');
  writeFileSync(path.join(oldAgentDir,'my-custom-agent.toml'),'name = "my_custom_agent"\n','utf8');
  writeAgentDefinitions({workspace:newWorkspace,roles},{workspace:oldWorkspace,roles});
  const newAgentDir=path.join(newWorkspace,'.codex','agents');
  assert.match(readFileSync(path.join(newAgentDir,'acode-planner.toml'),'utf8'),/model = "gpt-6\.1-sol"[\s\S]*model_reasoning_effort = "medium"[\s\S]*sandbox_mode = "read-only"/);
  assert.match(readFileSync(path.join(newAgentDir,'acode-worker.toml'),'utf8'),/model = "gpt-6-luna"/);
  assert.equal(existsSync(path.join(oldAgentDir,'acode-planner.toml')),false);
  assert.equal(existsSync(path.join(oldAgentDir,'acode-worker.toml')),false);
  assert.equal(existsSync(path.join(oldAgentDir,'my-custom-agent.toml')),true);
 }finally{rmSync(base,{recursive:true,force:true});}
});
test('disabled planner does not produce a custom agent file',()=>{
 const workspace=mkdtempSync(path.join(os.tmpdir(),'acode-disabled-agent-'));
 try{
  const previousRoles=roleDefaults.filter(role=>['planner','worker'].includes(role.name)).map(role=>({...role,enabled:true}));
  const roles=previousRoles.map(role=>({...role,enabled:role.name==='worker'}));
  writeAgentDefinitions({workspace,roles:previousRoles},{workspace,roles:[]});
  writeAgentDefinitions({workspace,roles},{workspace,roles:previousRoles});
  const dir=path.join(workspace,'.codex','agents');
  assert.equal(existsSync(path.join(dir,'acode-planner.toml')),false);
  assert.equal(existsSync(path.join(dir,'acode-worker.toml')),true);
 }finally{rmSync(workspace,{recursive:true,force:true});}
});
test('agent config update rolls back prior managed files when a later rename fails',()=>{
 const workspace=mkdtempSync(path.join(os.tmpdir(),'acode-agent-rollback-'));
 try{
  const roles=roleDefaults.filter(role=>['explorer','planner'].includes(role.name)).map(role=>({...role,enabled:true}));
  writeAgentDefinitions({workspace,roles},{workspace,roles:[]});
  const explorer=path.join(workspace,'.codex','agents','acode-explorer.toml'),planner=path.join(workspace,'.codex','agents','acode-planner.toml');
  const beforeExplorer=readFileSync(explorer,'utf8'),beforePlanner=readFileSync(planner,'utf8');
  const nextRoles=roles.map(role=>({...role,description:'Changed '+role.name}));
  let failed=false;
  assert.throws(()=>writeAgentDefinitions({workspace,roles:nextRoles},{workspace,roles},{
   renameSync(from,to){if(!failed&&to===planner){failed=true;throw Error('simulated planner write failure');}return renameSync(from,to);},
   writeFileSync,unlinkSync
  }),/rolled back/);
  assert.equal(readFileSync(explorer,'utf8'),beforeExplorer);assert.equal(readFileSync(planner,'utf8'),beforePlanner);
  assert.deepEqual(readdirSync(path.dirname(explorer)).filter(name=>name.includes('acode-tmp-')||name.includes('acode-rollback-')),[]);
 }finally{rmSync(workspace,{recursive:true,force:true});}
});
test('agent config journal recovers files after the process exits mid-commit',()=>{
 const workspace=mkdtempSync(path.join(os.tmpdir(),'acode-agent-crash-')),journal=path.join(workspace,'data','agent-transaction.json');
 try{
  const roles=roleDefaults.filter(role=>['explorer','planner'].includes(role.name)).map(role=>({...role,enabled:true}));
  writeAgentDefinitions({workspace,roles},{workspace,roles:[]},{transactionFile:journal});
  const explorer=path.join(workspace,'.codex','agents','acode-explorer.toml'),planner=path.join(workspace,'.codex','agents','acode-planner.toml');
  const beforeExplorer=readFileSync(explorer,'utf8'),beforePlanner=readFileSync(planner,'utf8'),nextRoles=roles.map(role=>({...role,description:'Updated '+role.name}));
  const script=`import {writeAgentDefinitions} from './agent-config.mjs'; import {renameSync,writeFileSync,unlinkSync} from 'node:fs'; const [workspace,journal,planner]=process.argv.slice(1); const roles=${JSON.stringify(nextRoles)}; writeAgentDefinitions({workspace,roles},{workspace,roles:${JSON.stringify(roles)}},{transactionFile:journal,renameSync(from,to){if(to===planner)process.exit(23);return renameSync(from,to);},writeFileSync,unlinkSync});`;
  const crashed=spawnSync(process.execPath,['--input-type=module','-e',script,workspace,journal,planner],{cwd:path.dirname(fileURLToPath(import.meta.url)),encoding:'utf8'});
  assert.equal(crashed.status,23,crashed.stderr||crashed.error?.message);
  assert.equal(existsSync(journal),true);
  assert.equal(recoverAgentDefinitions(journal),true);
  assert.equal(readFileSync(explorer,'utf8'),beforeExplorer);assert.equal(readFileSync(planner,'utf8'),beforePlanner);
  assert.equal(existsSync(journal),false);
 }finally{rmSync(workspace,{recursive:true,force:true});}
});
