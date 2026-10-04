import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const root=path.dirname(fileURLToPath(import.meta.url)),work=path.join(root,'work');
mkdirSync(work,{recursive:true});
const rate={input:1,cachedInput:0.5,cacheWrite:2,output:5};
const usage=(total)=>({total:{totalTokens:total,inputTokens:total*0.9,outputTokens:total*0.1,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0}});
const state={
 connected:true,account:{type:'chatgpt',planType:'plus'},error:null,approvals:[],events:[],
 models:['gpt-6-luna','gpt-6.1-sol'].map((model,index)=>({model,id:model,displayName:model==='gpt-6-luna'?'GPT-6 Luna':'GPT-6.1 Sol',isDefault:index===0,defaultReasoningEffort:'medium',supportedReasoningEfforts:['low','medium','high'].map(reasoningEffort=>({reasoningEffort}))})),
 config:{workspace:'C:\\.Acode',model:'gpt-6-luna',reasoningEffort:'medium',maxAgents:5,maxSolAgents:2,solTokenWarning:50000,workflowPreset:'balanced',tokenRates:{'gpt-6-luna':rate,'gpt-6.1-sol':rate},approvalPolicy:'on-request',sandboxMode:'workspace-write',coordinatorInstructions:'Coordinate small tasks directly.',roles:[
  {name:'explorer',description:'Explore',model:'gpt-6-luna',reasoningEffort:'',sandboxMode:'read-only',enabled:true,instructions:'Inspect only.'},
  {name:'planner',description:'Plan',model:'gpt-6.1-sol',reasoningEffort:'medium',sandboxMode:'read-only',enabled:true,instructions:'Plan only.'},
  {name:'worker',description:'Implement',model:'gpt-6-luna',reasoningEffort:'medium',sandboxMode:'',enabled:true,instructions:'Implement.'},
  {name:'reviewer',description:'Review',model:'gpt-6-luna',reasoningEffort:'medium',sandboxMode:'read-only',enabled:true,instructions:'Review.'},
  {name:'senior_reviewer',description:'Senior review',model:'gpt-6.1-sol',reasoningEffort:'high',sandboxMode:'read-only',enabled:false,instructions:'Review high risk.'}
 ]},
 runs:[{id:'run-balanced',threadId:'root-thread',prompt:'Reliability visual smoke',status:'completed',workflowPreset:'balanced',model:'gpt-6-luna',reasoningEffort:'medium',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),solUseful:null}],
 agents:{
  'root-thread':{id:'root-thread',runId:'run-balanced',name:'Coordinator',parentId:null,status:'completed',model:'gpt-6-luna',reasoningEffort:'medium',output:'Completed the reliability smoke test.',tokenUsage:usage(40000)},
  'explorer-thread':{id:'explorer-thread',runId:'run-balanced',name:'explorer',parentId:'root-thread',status:'completed',model:'gpt-6-luna',reasoningEffort:'medium',task:'Inspect the project',tokenUsage:usage(20000)},
  'planner-thread':{id:'planner-thread',runId:'run-balanced',name:'planner',parentId:'root-thread',status:'completed',model:'gpt-6.1-sol',reasoningEffort:'medium',task:'Analyze the root cause',escalationReason:'Root cause spans calculation service and API mapping',tokenUsage:usage(9670)},
  'worker-thread':{id:'worker-thread',runId:'run-balanced',name:'worker',parentId:'root-thread',status:'completed',model:'gpt-6-luna',reasoningEffort:'medium',task:'Implement the change',tokenUsage:usage(34610)}
 }
};
let server,browser,baseUrl,postedConfig,feedback;
const streams=new Set();
function sendState(){for(const response of streams)response.write('data: '+JSON.stringify(state)+'\n\n');}
before(async()=>{
 browser=await chromium.launch({headless:true});
 server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(req.method==='GET'&&url.pathname==='/api/state'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({...state,token:'ui-test-token'}));}
  if(req.method==='GET'&&url.pathname==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});streams.add(res);res.write('data: '+JSON.stringify(state)+'\n\n');req.on('close',()=>streams.delete(res));return;}
  if(req.method==='POST'&&url.pathname==='/api/config'){
   let body='';for await(const chunk of req)body+=chunk;postedConfig=JSON.parse(body);state.config=postedConfig;sendState();res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true}));
  }
  if(req.method==='POST'&&url.pathname==='/api/run/feedback'){
   let body='';for await(const chunk of req)body+=chunk;feedback=JSON.parse(body);state.runs[0].solUseful=feedback.useful;sendState();res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true}));
  }
  const files={'/':'index.html','/app.js':'app.js','/monitor.mjs':'monitor.mjs','/style.css':'style.css'};
  if(req.method==='GET'&&files[url.pathname]){const file=files[url.pathname],type=file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'text/javascript';res.writeHead(200,{'Content-Type':type});return res.end(readFileSync(path.join(root,file)));}
  res.writeHead(404);res.end();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 baseUrl='http://127.0.0.1:'+server.address().port;
});
after(async()=>{for(const stream of streams)stream.end();await browser?.close();await new Promise(resolve=>server?.close(resolve));});

test('Workflow summary renders accurately and preset manual edits survive Config save',async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:1050}});
 const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
 try{
  await page.goto(baseUrl+'/#workflow');
  await page.locator('#run-summary:not([hidden])').waitFor();
  const summary=page.locator('#run-summary'),text=await summary.innerText();
  assert.match(text,/GPT-6 Luna · Medium/);
  assert.match(text,/104,280/);assert.match(text,/94,610/);assert.match(text,/9,670/);assert.match(text,/9\.3%/);
  assert.match(text,/Sol · \$|ค่าเทียบ API · Sol/);
  assert.match(text,/Root cause spans calculation service and API mapping/);
  assert.equal(await summary.locator('[data-sol-feedback]').count(),2);
  await page.locator('#flow-viewport').screenshot({path:path.join(work,'workflow.png')});
  await summary.screenshot({path:path.join(work,'run-summary.png')});
  await summary.locator('[data-sol-feedback="true"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-sol-feedback="true"]')?.classList.contains('primary'));
  assert.deepEqual(feedback,{runId:'run-balanced',useful:true});
  await page.locator('#nav-config').click();
  await page.locator('#config-dialog[open]').waitFor();
  await page.locator('#config-dialog').screenshot({path:path.join(work,'config.png')});
  await page.locator('#cfg-preset').selectOption('balanced');
  const roleRows=page.locator('#roles .role-row');let planner;
  for(let i=0;i<await roleRows.count();i++)if(await roleRows.nth(i).locator('[data-role-field="name"]').inputValue()==='planner')planner=roleRows.nth(i);
  assert.ok(planner,'planner role should exist in Config');
  await planner.locator('[data-role-field="model"]').selectOption('gpt-6-luna');
  await planner.locator('[data-role-field="reasoningEffort"]').selectOption('medium');
  await page.locator('#config-form button[type="submit"]').click();
  await page.locator('#config-dialog:not([open])').waitFor({state:'hidden'});
  assert.equal(postedConfig.workflowPreset,'balanced');
  assert.equal(postedConfig.roles.find(role=>role.name==='planner').model,'gpt-6-luna');
  assert.equal(postedConfig.roles.find(role=>role.name==='planner').reasoningEffort,'medium');
  assert.deepEqual(pageErrors,[]);
 }finally{await page.close();}
});
