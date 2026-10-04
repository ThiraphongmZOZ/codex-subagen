import {sumTokenUsage,estimateTokenCost,solTokenUsage,solTokenWarningExceeded,delegationReasonLabel,agentsForRun,activeDashboardRunCount,maxConcurrentRuns} from './monitor.mjs';
const $=id=>document.getElementById(id);
let state,token,selectedRun='',filter='all',busy=false,source,refreshAfterReconnect=false,view=location.hash==='#workflow'?'workflow':location.hash==='#history'?'history':'monitor',flowAgent='',flowSignature='',flowScale=1,flowSize={width:800,height:500};
const labels={running:'กำลังทำงาน',queued:'รอเริ่ม',waiting:'รออนุมัติ',completed:'เสร็จแล้ว',interrupted:'หยุดแล้ว',error:'ผิดพลาด',unknown:'ไม่ทราบสถานะ',closed:'ปิดแล้ว',idle:'ว่าง'};
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=s=>new Date(s).toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
const eventLabels={'run/started':'เริ่มงานใหม่','turn/started':'เริ่มทำงาน','turn/completed':'จบการทำงาน','item/started':'เริ่มกิจกรรม','item/completed':'กิจกรรมเสร็จ','turn/plan/updated':'อัปเดตแผน','approval/requested':'รอการอนุมัติ','request/unsupported':'คำขอที่ยังไม่รองรับ','error':'เกิดข้อผิดพลาด'};
const detailLabels={agentMessage:'กำลังส่งข้อความ',userMessage:'รับโจทย์',collabAgentToolCall:'ประสานงานกับทีม',subAgentActivity:'อัปเดตสถานะ subagent',wait:'รอผลจากทีม',sleep:'รอเวลา',completed:'เสร็จแล้ว',interrupted:'หยุดแล้ว',inProgress:'กำลังทำงาน'};
function toast(message,error=false){$('toast').textContent=message;$('toast').className='toast'+(error?' error':'');$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,7000);}
async function post(route,body={}) {const res=await fetch('/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Acode-Token':token},body:JSON.stringify(body)});const result=await res.json();if(!res.ok)throw Error(result.error);return result;}
function selectedAgents(){return agentsForRun(Object.values(state.agents),selectedRun);}
const tokenFormat=value=>Number(value||0).toLocaleString('en-US');
function effectiveAgentModel(agent,run){const roleName=agent.name?.split('/').filter(Boolean).at(-1),role=state.config.roles.find(r=>r.name===roleName);return agent.model||role?.model||(!agent.parentId?run?.model:'')||'';}
function displayModel(model){return state.models.find(item=>(item.model||item.id)===model)?.displayName||model||'ไม่ได้ระบุ';}
function agentCost(agent){const run=state.runs.find(r=>r.id===agent.runId);return estimateTokenCost(agent.tokenUsage?.total,state.config.tokenRates?.[effectiveAgentModel(agent,run)]);}
function costLabel(value){return value===null?'ค่าเทียบ API: ตั้งราคาใน Config':'ค่าเทียบ API: $'+value.toFixed(8)+' (เปรียบเทียบเท่านั้น ไม่ใช่ยอดแพ็กเกจ Codex)';}
function agentUsage(agent){
  const u=agent.tokenUsage?.total;if(!u)return '';
  return '<div class="agent-usage">Token '+tokenFormat(u.totalTokens)+' · เข้า '+tokenFormat(u.inputTokens)+' (cache '+tokenFormat(u.cachedInputTokens)+') · ออก '+tokenFormat(u.outputTokens)+' · '+escape(costLabel(agentCost(agent)))+'</div>';
}
function usageTotals(agents){
  const used=agents.filter(a=>a.tokenUsage?.total),total=sumTokenUsage(agents);
  if(!used.length)return '';
  const costs=used.map(agentCost),cost=costs.every(value=>value!==null)?costs.reduce((sum,value)=>sum+value,0):null;
  return tokenFormat(total.totalTokens)+' tokens · '+costLabel(cost);
}
function solSubagentCount(agents){
  return agents.filter(a=>a.parentId).filter(a=>{
    return effectiveAgentModel(a,state.runs.find(r=>r.id===a.runId)).toLowerCase().includes('sol');
  }).length;
}
function renderRunAnalytics(agents,run){
  const used=agents.filter(a=>a.tokenUsage?.total);if(!used.length){$('flow-analytics').innerHTML='<p class="muted">จะแสดงสรุปการใช้ token ต่อ role เมื่อ Codex ส่งข้อมูล usage มา</p>';return;}
  const total=sumTokenUsage(agents),solTokens=solTokenUsage(agents.map(a=>({...a,model:effectiveAgentModel(a,run)}))),limit=state.config.solTokenWarning??50000,warning=solTokenWarningExceeded(agents.map(a=>({...a,model:effectiveAgentModel(a,run)})),limit),costs=used.map(agentCost),allCostsKnown=costs.every(value=>value!==null),totalCost=allCostsKnown?costs.reduce((sum,value)=>sum+value,0):null,solUsed=used.filter(a=>effectiveAgentModel(a,run).toLowerCase().includes('sol')),solCosts=solUsed.map(agentCost),solCost=solCosts.every(value=>value!==null)?solCosts.reduce((sum,value)=>sum+value,0):null;
  const rows=used.map(a=>'<tr><td>'+escape(a.name?.split('/').filter(Boolean).at(-1)||'Agent')+'</td><td>'+escape(effectiveAgentModel(a,run)||'ไม่ทราบ')+'</td><td>'+tokenFormat(a.tokenUsage.total.totalTokens)+'</td><td>'+(agentCost(a)===null?'—':('$'+agentCost(a).toFixed(8)))+'</td></tr>').join('');
  const tokenShare=total.totalTokens?((solTokens/total.totalTokens)*100).toFixed(1)+'%':'—',costShare=totalCost!==null&&totalCost>0&&solCost!==null?((solCost/totalCost)*100).toFixed(1)+'%':'—';
  $('flow-analytics').innerHTML='<div class="analytics-stats"><div><span>Token รวม</span><strong>'+tokenFormat(total.totalTokens)+'</strong></div><div><span>Sol tokens</span><strong>'+tokenFormat(solTokens)+' / '+(limit?tokenFormat(limit):'ไม่มีแจ้งเตือน')+'</strong></div><div><span>สัดส่วน Sol</span><strong>'+tokenShare+' tokens · '+costShare+' cost</strong></div><div><span>ค่าเทียบ API รวม</span><strong>'+(totalCost===null?'ตั้งราคาใน Config':'$'+totalCost.toFixed(8))+'</strong><small>ใช้เปรียบเทียบเท่านั้น ไม่ใช่ยอดแพ็กเกจ Codex</small></div></div>'+(warning?'<p class="budget-warning" role="alert">⚠ Sol token usage เกินเกณฑ์แจ้งเตือน '+tokenFormat(limit)+' tokens แล้ว · งานยังทำต่อได้</p>':'')+(rows?'<table class="analytics-table"><thead><tr><th>Role</th><th>Model</th><th>Tokens</th><th>ค่าเทียบ API</th></tr></thead><tbody>'+rows+'</tbody></table>':'<p class="muted">จะแสดงยอดเมื่อ Codex ส่ง token usage ของ agent มา</p>');
}
function renderRunSummary(agents,run){
  const panel=$('run-summary');
  if(!run||!['completed','error','interrupted'].includes(run.status)){panel.hidden=true;return;}
  panel.hidden=false;
  const total=sumTokenUsage(agents),models=agents.map(a=>({...a,model:effectiveAgentModel(a,run)})),solAgents=agents.filter(a=>effectiveAgentModel(a,run).toLowerCase().includes('sol')),lunaAgents=agents.filter(a=>effectiveAgentModel(a,run).toLowerCase().includes('luna')),used=agents.filter(a=>a.tokenUsage?.total);
  const costFor=list=>{const costs=list.filter(a=>a.tokenUsage?.total).map(agentCost);return costs.length&&costs.every(value=>value!==null)?'$'+costs.reduce((sum,value)=>sum+value,0).toFixed(8):'ตั้งราคาใน Config';};
  const solTokens=solTokenUsage(models),lunaTokens=sumTokenUsage(lunaAgents).totalTokens,delegated=agents.filter(a=>a.parentId),escalated=delegated.filter(a=>effectiveAgentModel(a,run).toLowerCase().includes('sol')),reasoned=escalated.filter(a=>a.escalationReason),feedback=run.solUseful===true?'yes':run.solUseful===false?'no':'';
  const resultLabel=run.status==='completed'?'สำเร็จ':run.status==='error'?'ผิดพลาด':'หยุดแล้ว',coordinator=agents.find(a=>a.id===run.threadId),coordinatorEffort=coordinator?agentEffort(coordinator,run):{value:run.reasoningEffort||null},attention=agents.filter(a=>['error','unknown','interrupted'].includes(a.status));
  const escalations=escalated.length?'<div class="run-escalations"><h4>Sol escalations · '+escalated.length+'</h4>'+escalated.map(a=>'<div><strong>'+escape(a.name?.split('/').filter(Boolean).at(-1)||'Subagent')+' · '+escape(displayModel(effectiveAgentModel(a,run)))+'</strong><span>Reason: '+escape(delegationReasonLabel(a.escalationReason))+'</span></div>').join('')+'</div>':'<p class="muted">รอบนี้ไม่มี subagent ที่ใช้ Sol</p>';
  const verification='<div class="run-verification"><strong>การตรวจสถานะ</strong><span>'+(attention.length?'⚠ ต้องตรวจ '+attention.length+' agent':'✓ ไม่มี agent ที่ต้องตรวจ')+'</span><span>'+(agents.some(a=>['running','waiting','queued'].includes(a.status))?'⚠ ยังมี agent ทำงานอยู่':'✓ ไม่พบ agent ที่ยังทำงาน')+'</span><span>ผล run อ้างอิงจากสถานะที่ Codex รายงาน</span></div>';
  panel.innerHTML='<div class="section-heading"><div><h3>สรุปผลรอบนี้</h3><p>ผลลัพธ์และการใช้โมเดลของ run ที่จบแล้ว</p></div><span class="badge '+escape(run.status)+'">'+resultLabel+'</span></div><div class="analytics-stats"><div><span>Preset</span><strong>'+escape(run.workflowPreset||'ไม่ได้ระบุ')+'</strong></div><div><span>Coordinator</span><strong>'+escape(coordinator?displayModel(agentModel(coordinator,run)):displayModel(run.model))+' · '+escape(effortLabels[coordinatorEffort.value]||coordinatorEffort.value||'ไม่ได้ระบุ')+'</strong></div><div><span>Agents / Sol agents</span><strong>'+agents.length+' / '+solAgents.length+' of '+(state.config.maxSolAgents??2)+' soft limit</strong></div><div><span>Sol escalations / Reason</span><strong>'+escalated.length+' / '+reasoned.length+'</strong></div><div><span>Total tokens</span><strong>'+tokenFormat(total.totalTokens)+'</strong></div><div><span>Luna tokens</span><strong>'+tokenFormat(lunaTokens)+'</strong></div><div><span>Sol tokens / share</span><strong>'+tokenFormat(solTokens)+' · '+(total.totalTokens?((solTokens/total.totalTokens)*100).toFixed(1)+'%':'—')+'</strong></div><div><span>ค่าเทียบ API · Luna</span><strong>'+costFor(lunaAgents)+'</strong></div><div><span>ค่าเทียบ API · Sol</span><strong>'+costFor(solAgents)+'</strong></div><div><span>ค่าเทียบ API · Total</span><strong>'+costFor(used)+'</strong></div></div>'+verification+escalations+'<p class="muted">ค่าเทียบ API ใช้ราคาที่ตั้งเองเพื่อเปรียบเทียบเท่านั้น ไม่ใช่ยอดเรียกเก็บของแพ็กเกจ Codex</p>'+(coordinator?.output?'<details><summary>ผลลัพธ์จาก Coordinator</summary><pre>'+escape(coordinator.output)+'</pre></details>':'')+(solAgents.length?'<div class="sol-feedback"><span>Sol ช่วยให้งานนี้ดีขึ้นไหม?</span><button type="button" class="'+(feedback==='yes'?'primary':'secondary')+'" data-sol-feedback="true">ช่วย</button><button type="button" class="'+(feedback==='no'?'primary':'secondary')+'" data-sol-feedback="false">ไม่ช่วย</button></div>':'');
}
function render(){
  if(!state)return;
  if(!selectedRun&&state.runs.length)selectedRun=state.runs[0].id;
  const connected=state.connected;
  $('connection').textContent=connected?'● เชื่อมต่อแล้ว':'○ ออฟไลน์';
  $('side-dot').hidden=!connected;
  $('banner').hidden=!state.error&&!!state.account;
  $('banner').textContent=state.error||(!state.account?'ยังไม่ได้เข้าสู่ระบบ Codex กรุณาเปิด terminal แล้วใช้ codex login จากนั้นกดเชื่อมต่อใหม่':'');
  $('account-label').textContent=connected?('Codex connected · '+(state.account?.type||'Not signed in')+(state.account?.planType?' / '+state.account.planType:'')):'Codex disconnected';
  $('workspace-label').textContent='⌁ '+state.config.workspace+' · สูงสุด '+state.config.maxAgents+' subagents';
  $('model-tag').textContent=(state.config.model||(state.models.find(m=>m.isDefault)?.displayName)||'Codex default')+(state.config.reasoningEffort?' · '+state.config.reasoningEffort:'');
  const activeRuns=activeDashboardRunCount(state.runs);
  $('start').disabled=busy||!connected||!state.account||activeRuns>=maxConcurrentRuns;
  $('start').textContent='▶ เริ่มงานใหม่ · '+activeRuns+'/'+maxConcurrentRuns;
  const selected=state.runs.find(r=>r.id===selectedRun);
  const selectedAgent=selected?.threadId?state.agents[selected.threadId]:null;
  const selectedActive=!!selected?.external&&(['running','waiting'].includes(selected.status)||['running','waiting'].includes(selectedAgent?.status));
  $('continue').disabled=busy||!connected||!state.account||selectedActive||!selected?.threadId||!['completed','error','interrupted','unknown'].includes(selected.status);
  $('branch').hidden=!selected?.external;
  $('branch').disabled=busy||!connected||!state.account||!selected?.threadId;
  $('composer-help').textContent=selectedActive?'Codex/VS Code กำลังล็อก thread นี้อยู่ — ปิด thread ต้นทางเพื่อสั่งต่อ หรือแยก branch เพื่อทำงานต่อทันที':activeRuns>=maxConcurrentRuns?'มีงานทำงานครบ '+maxConcurrentRuns+' runs แล้ว รอให้มีงานจบก่อน':activeRuns?'กำลังทำงาน '+activeRuns+'/'+maxConcurrentRuns+' runs · เริ่มงานเพิ่มหรือสั่งต่อ thread ที่จบแล้วได้':selected?.external?'เลือกสั่งต่อใน thread เดิม หรือแยก branch เพื่อทำงานคู่ขนานได้':selected?.threadId?'ส่งคำสั่งใหม่ หรือคุยต่อจากบริบทของ thread ที่เลือก':'เริ่มงานใหม่ หรือเลือก thread เดิมเพื่อส่งคำสั่งต่อ';
  $('run-select').innerHTML=state.runs.length?state.runs.map(r=>`<option value="${escape(r.id)}" ${r.id===selectedRun?'selected':''}>${escape(String(r.prompt||'').slice(0,40))} · ${escape(labels[r.status]||r.status)}</option>`).join(''):'<option value="">ยังไม่มีงาน</option>';
  const agents=selectedAgents(),working=agents.filter(a=>['running','waiting','queued'].includes(a.status));
  $('total').textContent=agents.length;$('working').textContent=working.length;$('completed').textContent=agents.filter(a=>a.status==='completed').length;$('errors').textContent=agents.filter(a=>['error','unknown'].includes(a.status)).length;$('agent-count').textContent=agents.length;
  const ordered=[],visit=(parent,depth=0)=>{for(const a of agents.filter(a=>a.parentId===parent)){if(ordered.some(x=>x.a.id===a.id))continue;ordered.push({a,depth});if(depth<12)visit(a.id,depth+1);}};
  visit(null);for(const a of agents)if(!ordered.some(x=>x.a.id===a.id))ordered.push({a,depth:0});
  const visible=ordered.filter(({a})=>filter==='all'||(filter==='working'?['running','waiting','queued'].includes(a.status):a.status==='completed'));
  const openIds=new Set([...$('agents').querySelectorAll('details[open]')].map(d=>d.dataset.id));
  if(agents.length){$('agents').innerHTML=visible.length?visible.map(({a,depth})=>`<article class="agent-card ${depth?'child':''}"><div class="agent-top"><div class="avatar">${depth?'↳':'◈'}</div><div><div class="agent-name">${escape(a.name)}</div><div class="agent-id">${depth?'SUBAGENT':'COORDINATOR'} · ${escape(a.id.slice(0,8))}</div></div><span class="badge ${escape(a.status)}">${escape(labels[a.status]||a.status)}</span></div><div class="agent-task">${escape(a.task||'Codex ยังไม่ส่งรายละเอียดงาน — ดูกิจกรรมและผลลัพธ์ด้านล่าง')}</div><div class="agent-activity">${escape(a.activity||'รอเหตุการณ์จาก Codex')} · ${time(a.updatedAt)}</div>${a.escalationReason?'<div class="agent-reason">เหตุผลที่เรียก agent: '+escape(a.escalationReason)+'</div>':''}${agentUsage(a)}${a.plan?.length?'<ul class="agent-plan">'+a.plan.map(p=>`<li>${escape(p.step)} · ${escape(p.status)}</li>`).join('')+'</ul>':''}${a.output?`<details data-id="${escape(a.id)}" ${openIds.has(a.id)?'open':''}><summary>ดูผลลัพธ์</summary><pre>${escape(a.output)}</pre></details>`:''}</article>`).join(''):'<div class="empty-small">ไม่มี agent ในสถานะนี้</div>';}
  const run=state.runs.find(r=>r.id===selectedRun);$('run-actions').hidden=!run;$('stop').hidden=!run||(!['starting','running'].includes(run.status)&&!working.length);$('run-status').textContent=run?'สถานะงาน: '+(labels[run.status]||run.status):'';
  const ids=new Set(agents.map(a=>a.id));const events=state.events.filter(e=>(!e.threadId||ids.has(e.threadId))&&eventLabels[e.method]);
  $('activity').innerHTML=events.length?events.slice(0,60).map(e=>{const detail=String(e.detail??'');return `<div class="activity-item"><time>${time(e.time)}</time><b>${escape(eventLabels[e.method])} · ${escape(state.agents[e.threadId]?.name||'ระบบ')}</b><p>${escape(detailLabels[detail]||detail.slice(0,230))}</p></div>`;}).join(''):'<div class="empty-small">ยังไม่มีกิจกรรม</div>';
  renderWorkflow(agents,run);
  renderRunSummary(agents,run);
  if(view==='history')loadHistorySummary();
  $('approvals').innerHTML=state.approvals.map(r=>`<article class="approval"><h3>Codex รอการอนุมัติ</h3><p>${escape(r.params.reason||r.method)}</p><pre>${escape(r.params.command||JSON.stringify(r.params,null,2))}</pre><div class="approval-actions"><button class="primary" data-approval="${escape(r.id)}" data-decision="accept">อนุมัติครั้งนี้</button><button class="secondary" data-approval="${escape(r.id)}" data-decision="decline">ปฏิเสธ</button></div></article>`).join('');
}
async function init(){try{const res=await fetch('/api/state');state=await res.json();token=state.token;delete state.token;render();source?.close();source=new EventSource('/api/events');source.onmessage=e=>{const previousSync=state?.historySync?.at;state=JSON.parse(e.data);render();if(view==='history'&&state.historySync?.at!==previousSync)loadHistory();};source.onopen=()=>{if(refreshAfterReconnect){refreshAfterReconnect=false;init();}};source.onerror=()=>{$('connection').textContent='○ กำลังเชื่อมต่อใหม่';$('start').disabled=true;refreshAfterReconnect=true;};}catch(e){toast(e.message,true);}}
$('run-form').onsubmit=async e=>{e.preventDefault();const mode=e.submitter?.value||'new';busy=true;render();try{const route=mode==='new'?'run':'continue';const r=await post(route,{runId:selectedRun,prompt:$('prompt').value,fork:mode==='branch'});selectedRun=r.runId;$('prompt').value='';toast(r.forked?'สร้าง branch ใหม่และสั่งงานต่อแล้ว':r.steered?'ส่งข้อความเข้า turn ที่กำลังทำงานแล้ว':mode==='continue'?'ส่งคำสั่งต่อใน thread เดิมแล้ว':'เริ่มงานใหม่แล้ว');render();}catch(e){toast(e.message,true);}finally{busy=false;render();}};
$('run-select').onchange=e=>{selectedRun=e.target.value;render();};
document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('active',x===b));render();});
$('stop').onclick=async()=>{try{await post('stop',{runId:selectedRun});toast('ส่งคำสั่งหยุดแล้ว');}catch(e){toast(e.message,true);}};
$('reconnect').onclick=async()=>{try{await post('reconnect');await init();toast('เชื่อมต่อแล้ว');}catch(e){toast(e.message,true);}};
$('approvals').onclick=async e=>{const b=e.target.closest('[data-approval]');if(!b)return;try{await post('approval',{id:/^\d+$/.test(b.dataset.approval)?Number(b.dataset.approval):b.dataset.approval,decision:b.dataset.decision});}catch(e){toast(e.message,true);}};
const extraModels=[{model:'gpt-6.1-sol',displayName:'GPT-6.1-Sol'},{model:'gpt-6-sol',displayName:'GPT-6-Sol'},{model:'gpt-6-luna',displayName:'GPT-6-Luna'}];
const effortLabels={none:'None',minimal:'Minimal',low:'Low · เร็ว',medium:'Medium · สมดุล',high:'High · คิดละเอียด',xhigh:'Extra High',max:'Max',ultra:'Ultra'};
function defaultModelId(){const model=state.models.find(m=>m.isDefault);return model?.model||model?.id||'';}
function modelOptionsHTML(value,firstLabel){
  const option=m=>'<option value="'+escape(m.model||m.id)+'">'+escape(m.displayName||m.model||m.id)+'</option>';
  const group=(label,models)=>models.length?'<optgroup label="'+label+'">'+models.map(option).join('')+'</optgroup>':'';
  const listed=new Set(state.models.map(m=>m.model||m.id));
  const extras=extraModels.filter(m=>!listed.has(m.model));
  if(value&&!listed.has(value)&&!extras.some(m=>m.model===value))extras.push({model:value,displayName:value});
  return '<option value="">'+escape(firstLabel)+'</option>'+group('จาก catalog ของ Codex CLI',state.models.filter(m=>!m.hidden))+group('ใน catalog แต่ซ่อนจากรายการปกติ',state.models.filter(m=>m.hidden))+group('โมเดลเพิ่มเติม — ยังไม่ยืนยันสิทธิ์',extras);
}
function fillModelSelect(select,value,firstLabel){select.innerHTML=modelOptionsHTML(value,firstLabel);select.value=value;}
function modelFor(id){return state.models.find(m=>(m.model||m.id)===(id||defaultModelId()));}
function fillEffortSelect(select,modelId,value,defaultLabel){
  const model=modelFor(modelId),efforts=model?.supportedReasoningEfforts||[];
  select.innerHTML='<option value="">'+escape(defaultLabel)+(model?.defaultReasoningEffort?' · '+escape(effortLabels[model.defaultReasoningEffort]||model.defaultReasoningEffort):'')+'</option>'+efforts.map(e=>'<option value="'+escape(e.reasoningEffort)+'">'+escape(effortLabels[e.reasoningEffort]||e.reasoningEffort)+'</option>').join('');
  select.value=efforts.some(e=>e.reasoningEffort===value)?value:'';select.disabled=!efforts.length;
}
function modelHelp(){
  const value=$('cfg-model').value,model=modelFor(value);
  $('model-help').textContent=!value?'ใช้โมเดลเริ่มต้นจาก Codex CLI':model?(model.hidden?'โมเดลนี้อยู่ใน catalog แต่ Codex ซ่อนไว้จากรายการปกติ':'โมเดลนี้อยู่ใน catalog ของ Codex CLI'):'โมเดลนี้ยังไม่อยู่ใน catalog ของ Codex CLI บนเครื่อง การเลือกไม่ได้ยืนยันสิทธิ์ใช้งาน';
}
function roleModelLabel(){return 'สืบทอดโมเดล Coordinator'+($('cfg-model').value?' · '+$('cfg-model').value:'');}
function syncRoleEffort(row,value){
  const model=row.querySelector('[data-role-field="model"]').value||$('cfg-model').value||defaultModelId();
  const select=row.querySelector('[data-role-field="reasoningEffort"]');
  fillEffortSelect(select,model,value===undefined?select.value:value,'สืบทอด effort จาก Coordinator');
}
function addRole(role={name:'',description:'Custom agent for one focused task',model:'',reasoningEffort:'',sandboxMode:'',enabled:true,instructions:'Handle one clearly scoped task. Follow the coordinator\'s constraints and return a concise result.'}){
  const div=document.createElement('div');div.className='role-row';
  div.innerHTML='<div class="role-name-row"><label class="role-enabled"><input type="checkbox" data-role-field="enabled" '+(role.enabled===false?'':'checked')+'> เปิดบทบาท</label><input aria-label="ชื่อบทบาท" data-role-field="name" placeholder="เช่น reviewer" required pattern="[a-z][a-z0-9_-]{0,39}" value="'+escape(role.name)+'"><button type="button" class="secondary remove-role" aria-label="ลบบทบาท">×</button></div><label>คำอธิบายการเลือกใช้<input data-role-field="description" required maxlength="500" value="'+escape(role.description||'')+'"></label><div class="form-grid role-settings"><div><label>โมเดล<select data-role-field="model">'+modelOptionsHTML(role.model||'',roleModelLabel())+'</select></label></div><div><label>Reasoning effort<select data-role-field="reasoningEffort"></select></label></div><div><label>สิทธิ์ของ agent<select data-role-field="sandboxMode"><option value="">สืบทอดจาก Coordinator</option><option value="read-only">read-only · อ่านอย่างเดียว</option><option value="workspace-write">workspace-write · แก้ใน workspace</option><option value="danger-full-access">danger-full-access · เข้าถึงเต็มรูปแบบ</option></select></label></div></div><label>Instructions<textarea data-role-field="instructions" required maxlength="4000" rows="4">'+escape(role.instructions||'')+'</textarea></label>';
  const modelSelect=div.querySelector('[data-role-field="model"]');modelSelect.value=role.model||'';
  const sandboxSelect=div.querySelector('[data-role-field="sandboxMode"]');sandboxSelect.value=role.sandboxMode||'';
  syncRoleEffort(div,role.reasoningEffort||'');
  modelSelect.onchange=()=>{syncRoleEffort(div,'');renderTokenRates();};
  div.querySelector('.remove-role').onclick=()=>{div.remove();renderTokenRates();};$('roles').append(div);
}
function readRole(row){return {name:row.querySelector('[data-role-field="name"]').value,description:row.querySelector('[data-role-field="description"]').value,model:row.querySelector('[data-role-field="model"]').value,reasoningEffort:row.querySelector('[data-role-field="reasoningEffort"]').value,sandboxMode:row.querySelector('[data-role-field="sandboxMode"]').value,enabled:row.querySelector('[data-role-field="enabled"]').checked,instructions:row.querySelector('[data-role-field="instructions"]').value};}
const presetRoles={explorer:{model:'gpt-6-luna',effort:'',sandbox:'read-only'},planner:{model:'gpt-6.1-sol',effort:'medium',sandbox:'read-only'},worker:{model:'gpt-6-luna',effort:'medium',sandbox:''},reviewer:{model:'gpt-6-luna',effort:'medium',sandbox:'read-only'},senior_reviewer:{model:'gpt-6.1-sol',effort:'high',sandbox:'read-only'}};
function applyWorkflowPreset(name){
  if(name==='custom')return;
  modelOptions('gpt-6-luna','medium');
  const enabled=name==='fast'?new Set():name==='balanced'?new Set(['explorer','planner','worker','reviewer']):new Set(Object.keys(presetRoles));
  for(const row of $('roles').children){
    const role=row.querySelector('[data-role-field="name"]').value,preset=Object.prototype.hasOwnProperty.call(presetRoles,role)?presetRoles[role]:null;
    row.querySelector('[data-role-field="enabled"]').checked=enabled.has(role);
    if(preset){const model=row.querySelector('[data-role-field="model"]');fillModelSelect(model,preset.model,roleModelLabel());model.value=preset.model;syncRoleEffort(row,preset.effort);row.querySelector('[data-role-field="sandboxMode"]').value=preset.sandbox;}
  }
  $('cfg-max-sol').value=name==='fast'?0:name==='balanced'?1:2;
  refreshRoleModelOptions();
}
function refreshRoleModelOptions(){
  for(const row of $('roles').children){const select=row.querySelector('[data-role-field="model"]'),value=select.value;fillModelSelect(select,value,roleModelLabel());syncRoleEffort(row);}
  renderTokenRates();
}
const rateFields=[['input','input ปกติ'],['cachedInput','cached input'],['cacheWrite','cache write'],['output','output']];
function renderTokenRates(){
  const edited=new Map();for(const input of $('token-rates').querySelectorAll('[data-rate-model]')){const values=edited.get(input.dataset.rateModel)||{};values[input.dataset.rateField]=input.value;edited.set(input.dataset.rateModel,values);}
  const models=new Set(Object.keys(state.config.tokenRates||{})),coordinator=$('cfg-model').value||defaultModelId();
  if(coordinator)models.add(coordinator);
  for(const row of $('roles').children){const model=row.querySelector('[data-role-field="model"]').value||coordinator;if(model)models.add(model);}
  $('token-rates').innerHTML=[...models].sort().map(model=>{
    const rates=edited.get(model)||state.config.tokenRates?.[model]||{};
    return '<div class="token-rate-row"><code>'+escape(model)+'</code>'+rateFields.map(([field,label])=>{const raw=rates[field],value=raw!==''&&Number.isFinite(Number(raw))?Number(raw):'';return '<label>'+label+'<input type="number" min="0" max="1000000" step="0.000001" data-rate-model="'+escape(model)+'" data-rate-field="'+field+'" value="'+value+'" placeholder="ยังไม่ระบุ"></label>';}).join('')+'</div>';
  }).join('')||'<p class="muted">เลือกโมเดลเพื่อกำหนดราคาอ้างอิง</p>';
}
function readTokenRates(){
  const rates={...(state.config.tokenRates||{})};
  const groups=new Map();for(const input of $('token-rates').querySelectorAll('[data-rate-model]')){const fields=groups.get(input.dataset.rateModel)||[];fields.push(input);groups.set(input.dataset.rateModel,fields);}
  for(const [model,fields] of groups){
    const entry={};for(const input of fields)if(input.value!=='')entry[input.dataset.rateField]=Number(input.value);
    if(Object.keys(entry).length)rates[model]=entry;else delete rates[model];
  }
  return rates;
}
function modelOptions(value=state.config.model,effort=state.config.reasoningEffort||''){
  fillModelSelect($('cfg-model'),value,'ใช้ค่าเริ่มต้น Codex');modelHelp();
  fillEffortSelect($('cfg-effort'),value,effort,'ใช้ค่าเริ่มต้นของโมเดล');
  $('effort-help').textContent='ระดับที่เลือกใช้กับ Coordinator และเป็นค่าตั้งต้นของ agent ที่ไม่ได้ระบุ effort เอง';
}
$('cfg-model').onchange=()=>{modelHelp();fillEffortSelect($('cfg-effort'),$('cfg-model').value,'','ใช้ค่าเริ่มต้นของโมเดล');refreshRoleModelOptions();};
$('cfg-preset').onchange=e=>applyWorkflowPreset(e.target.value);
$('refresh-models').onclick=async()=>{const button=$('refresh-models');button.disabled=true;try{const value=$('cfg-model').value,effort=$('cfg-effort').value;const result=await post('models/refresh');state.models=result.models;modelOptions(value,effort);refreshRoleModelOptions();toast('รีเฟรชรายการโมเดลแล้ว');}catch(e){toast(e.message,true);}finally{button.disabled=false;}};
$('nav-config').onclick=()=>{if(!state)return;$('cfg-workspace').value=state.config.workspace;$('cfg-max').value=state.config.maxAgents;$('cfg-max-sol').value=state.config.maxSolAgents??2;$('cfg-sol-token-warning').value=state.config.solTokenWarning??50000;$('cfg-preset').value=state.config.workflowPreset||'custom';$('cfg-approval').value=state.config.approvalPolicy||'on-request';$('cfg-sandbox').value=state.config.sandboxMode||'workspace-write';$('cfg-instructions').value=state.config.coordinatorInstructions||'';modelOptions();$('roles').innerHTML='';state.config.roles.forEach(addRole);renderTokenRates();$('config-dialog').showModal();};
$('nav-monitor').onclick=()=>setView('monitor');$('nav-workflow').onclick=()=>setView('workflow');$('nav-history').onclick=()=>setView('history');$('close-config').onclick=()=>$('config-dialog').close();$('add-role').onclick=()=>{if($('roles').children.length<8)addRole();else toast('เพิ่มได้สูงสุด 8 บทบาท',true);};
$('config-form').onsubmit=async e=>{e.preventDefault();try{await post('config',{workspace:$('cfg-workspace').value,model:$('cfg-model').value,reasoningEffort:$('cfg-effort').value,maxAgents:Number($('cfg-max').value),maxSolAgents:Number($('cfg-max-sol').value),solTokenWarning:Number($('cfg-sol-token-warning').value),workflowPreset:$('cfg-preset').value,tokenRates:readTokenRates(),approvalPolicy:$('cfg-approval').value,sandboxMode:$('cfg-sandbox').value,coordinatorInstructions:$('cfg-instructions').value,roles:[...$('roles').children].map(readRole)});$('config-dialog').close();toast('บันทึกแล้ว — ใช้กับงานใหม่และอัปเดต custom agents ใน workspace');}catch(e){toast(e.message,true);}};
function setView(next){view=next;location.hash=next==='monitor'?'':next;$('config-dialog').close();applyView();render();}
function applyView(){
  $('history-page').hidden=view!=='history';$('workflow-page').hidden=view!=='workflow';$('stats').hidden=view==='history';$('composer').hidden=view==='history';$('approvals').hidden=view==='history';$('monitor-page').hidden=view!=='monitor';document.body.classList.toggle('workflow-view',view==='workflow');
  for(const [id,active] of [['nav-history',view==='history'],['nav-monitor',view==='monitor'],['nav-workflow',view==='workflow']]){const button=$(id);button.classList.toggle('active',active);if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');}
  $('page-title').textContent=view==='workflow'?'ผัง Workflow ของ Agent':view==='history'?'ประวัติแชต':'จัดการ Agent';
}
function zoomFlow(value){flowScale=Math.max(.35,Math.min(1.6,value));$('flow-stage').style.transform='scale('+flowScale+')';$('flow-space').style.width=flowSize.width*flowScale+'px';$('flow-space').style.height=flowSize.height*flowScale+'px';$('flow-zoom-label').textContent=Math.round(flowScale*100)+'%';}
function fitFlow(){zoomFlow(Math.min(1,($('flow-viewport').clientWidth-32)/flowSize.width,($('flow-viewport').clientHeight-70)/flowSize.height));$('flow-viewport').scrollTo({top:0,left:0});}
function agentModel(a,run){return a.model||(!a.parentId?run?.model:null)||'ยังไม่ทราบโมเดล';}
function agentEffort(a,run){
  const value=a.reasoningEffort||(!a.parentId?run?.reasoningEffort:null);
  if(value)return {value,defaulted:false};
  const model=state.models.find(m=>(m.model||m.id)===agentModel(a,run));
  return {value:model?.defaultReasoningEffort||null,defaulted:!!model?.defaultReasoningEffort};
}
function renderWorkflow(agents,run){
  $('flow-run-select').innerHTML=$('run-select').innerHTML;$('flow-run-select').value=selectedRun;
  const solCount=solSubagentCount(agents),solLimit=state.config.maxSolAgents??2,solCountWarning=solCount>solLimit;
  $('flow-summary').textContent=run?(run.lastInput||run.prompt)+' · '+(labels[run.status]||run.status)+' · '+agents.length+' agents · Sol subagents '+solCount+' / '+solLimit+(solCountWarning?' · ⚠ เกิน Soft limit':'')+(usageTotals(agents)?' · '+usageTotals(agents):''):'ยังไม่มีงาน — เริ่มงานจากหน้า Live monitor';
  renderRunAnalytics(agents,run);
  $('flow-stop').hidden=$('stop').hidden;
  if(!agents.some(a=>a.id===flowAgent))flowAgent=run?.threadId||agents[0]?.id||'';
  const signature=JSON.stringify([selectedRun,flowAgent,run?.model,run?.reasoningEffort,agents.map(a=>[a.id,a.parentId,a.name,a.status,a.model,a.reasoningEffort,a.task,a.activity,a.escalationReason,a.tokenUsage])]);
  if(signature!==flowSignature){
    flowSignature=signature;
    if(!agents.length){$('flow-stage').innerHTML='<div class="flow-empty"><div class="empty-icon">⤳</div><h3>Workflow จะปรากฏเมื่อเริ่มงาน</h3><p>กล่องตัวหลักและตัวลูกสร้างจาก agent ที่ทำงานจริง</p></div>';flowSize={width:700,height:500};}
    else {
      const nodes=[],seen=new Set();let leaf=0;
      const visit=(a,depth)=>{if(seen.has(a.id))return null;seen.add(a.id);const node={a,depth,x:0,y:42+depth*232};nodes.push(node);const children=agents.filter(c=>c.parentId===a.id).map(c=>visit(c,depth+1)).filter(Boolean);node.x=children.length?(children[0].x+children.at(-1).x)/2:42+leaf++*340;return node;};
      agents.filter(a=>!a.parentId||!agents.some(p=>p.id===a.parentId)).forEach(a=>visit(a,0));agents.filter(a=>!seen.has(a.id)).forEach(a=>visit(a,0));
      flowSize={width:Math.max(720,...nodes.map(n=>n.x+344)),height:Math.max(480,...nodes.map(n=>n.y+210))};
      const paths=nodes.filter(n=>nodes.some(p=>p.a.id===n.a.parentId)).map(n=>{const p=nodes.find(p=>p.a.id===n.a.parentId),x=p.x+145,y=p.y+168,endX=n.x+145,endY=n.y;return '<path class="flow-edge '+escape(n.a.status)+'" d="M '+x+' '+y+' C '+x+' '+(y+40)+' '+endX+' '+(endY-40)+' '+endX+' '+endY+'" />';}).join('');
      $('flow-stage').innerHTML='<svg class="flow-edges" width="'+flowSize.width+'" height="'+flowSize.height+'" aria-hidden="true">'+paths+'</svg>'+nodes.map(({a,x,y})=>{const effort=agentEffort(a,run);return '<button type="button" data-flow-agent="'+escape(a.id)+'" class="flow-node '+escape(a.status)+(a.id===flowAgent?' selected':'')+'" aria-pressed="'+(a.id===flowAgent)+'"><span class="flow-node-top"><span class="flow-icon">'+(a.parentId?'↳':'◈')+'</span><span class="flow-role">'+(a.parentId?'SUBAGENT · ตัวลูก':'COORDINATOR · ตัวหลัก')+'</span></span><strong>'+escape(a.name?.split('/').filter(Boolean).at(-1)||'Agent')+'</strong><span class="flow-model">'+escape(agentModel(a,run))+' · effort '+escape(effort.value||'ไม่ทราบ')+(effort.defaulted?'*':'')+'</span><span class="flow-node-status"><i class="flow-dot '+escape(a.status)+'"></i>'+escape(labels[a.status]||a.status)+'</span><span class="flow-task">'+escape(a.task||'รอรายละเอียดงาน')+'</span></button>';}).join('');
      $('flow-stage').querySelectorAll('[data-flow-agent]').forEach((el,i)=>{el.style.left=nodes[i].x+'px';el.style.top=nodes[i].y+'px';});
    }
    $('flow-stage').style.width=flowSize.width+'px';$('flow-stage').style.height=flowSize.height+'px';zoomFlow(flowScale);
  }
  const a=agents.find(a=>a.id===flowAgent),inspector=$('flow-inspector');
  const u=a?.tokenUsage?.total,usageText=u?'รวม '+tokenFormat(u.totalTokens)+' · input '+tokenFormat(u.inputTokens)+' · cached '+tokenFormat(u.cachedInputTokens)+' · cache write '+tokenFormat(u.cacheWriteInputTokens)+' · output '+tokenFormat(u.outputTokens)+' · reasoning '+tokenFormat(u.reasoningOutputTokens)+'\n'+costLabel(agentCost(a)):'ยังไม่มีข้อมูล token usage จาก Codex';
  const detail=a?'<span class="eyebrow">'+(a.parentId?'SUBAGENT':'COORDINATOR')+'</span><h3>'+escape(a.name)+'</h3><span class="badge '+escape(a.status)+'">'+escape(labels[a.status]||a.status)+'</span><dl><dt>โมเดลของ thread</dt><dd>'+escape(agentModel(a,run))+'</dd><dt>Reasoning effort</dt><dd>'+(()=>{const effort=agentEffort(a,run);return effort.value?escape(effortLabels[effort.value]||effort.value)+(effort.defaulted?' · ค่าเริ่มต้นของโมเดล':''):'ไม่ได้ระบุ / ไม่มีข้อมูลจาก Codex'})()+'</dd><dt>Token usage · สะสมของ thread</dt><dd>'+escape(usageText)+'</dd><dt>เหตุผลที่เรียก agent</dt><dd>'+escape(delegationReasonLabel(a.escalationReason))+'</dd><dt>ตัวหลักที่เชื่อมต่อ</dt><dd>'+escape(state.agents[a.parentId]?.name||'ตัวหลักของงานนี้')+'</dd><dt>งานที่รับผิดชอบ</dt><dd>'+escape(a.task||'ยังไม่มีรายละเอียด')+'</dd><dt>กิจกรรมล่าสุด</dt><dd>'+escape(detailLabels[a.activity]||a.activity||'รอเหตุการณ์')+'</dd></dl>'+(a.output?'<h3>ผลลัพธ์</h3><pre>'+escape(a.output)+'</pre>':'<p>ยังไม่มีผลลัพธ์</p>'):'<h3>รายละเอียด agent</h3><p>คลิกกล่องในแผนผังเพื่อดูงานและผลลัพธ์</p>';
  if(inspector.innerHTML!==detail)inspector.innerHTML=detail;
}
$('flow-stage').onclick=e=>{const node=e.target.closest('[data-flow-agent]');if(node){flowAgent=node.dataset.flowAgent;render();}};
$('flow-run-select').onchange=e=>{selectedRun=e.target.value;flowAgent='';flowSignature='';render();fitFlow();};
$('flow-stop').onclick=()=>$('stop').click();
$('run-summary').onclick=async e=>{const button=e.target.closest('[data-sol-feedback]');if(!button)return;button.disabled=true;try{await post('run/feedback',{runId:selectedRun,useful:button.dataset.solFeedback==='true'});toast('บันทึก feedback แล้ว');}catch(err){toast(err.message,true);}finally{button.disabled=false;}};
$('flow-zoom-in').onclick=()=>zoomFlow(flowScale+.1);$('flow-zoom-out').onclick=()=>zoomFlow(flowScale-.1);$('flow-fit').onclick=fitFlow;
let historyRows=[],historyOffset=0,historyTotal=0,historyQuery='',historyLoadedQuery='',historySelected='',historyTimer,historyRequest=0,historyRead=0;
async function loadHistory(append=false){
  const query=historyQuery;if(append&&query!==historyLoadedQuery)append=false;
  const request=++historyRequest,offset=append?historyOffset:0,list=$('history-list');
  if(!append)historyOffset=0;
  list.setAttribute('aria-busy','true');
  try{
    const res=await fetch('/api/history?limit=50&offset='+offset+'&q='+encodeURIComponent(query)),data=await res.json();
    if(!res.ok)throw Error(data.error||'โหลดรายการประวัติไม่สำเร็จ');
    if(request!==historyRequest||query!==historyQuery)return false;
    historyRows=append?historyRows.concat(data.threads||[]):(data.threads||[]);historyLoadedQuery=query;historyOffset=historyRows.length;historyTotal=data.total||0;
    list.innerHTML=historyRows.map(t=>'<button type="button" class="history-row '+(t.id===historySelected?'selected':'')+'" data-thread="'+escape(t.id)+'"><span class="history-row-title">'+escape(t.name||t.preview||'แชต Codex')+(t.archived?' <small class="history-archived">เก็บถาวร</small>':'')+'</span><span class="history-row-preview">'+escape(t.preview||'')+'</span><span class="history-row-meta">'+escape(t.source==='vscode'?'VS Code extension':'Codex CLI')+' · '+escape(t.model||'ไม่ทราบโมเดล')+' · '+escape(t.cwd||'')+'</span></button>').join('')||'<div class="empty-small">ไม่พบแชตที่ตรงกัน</div>';
    $('history-more').hidden=historyRows.length>=historyTotal;$('history-summary').textContent='พบ '+historyTotal.toLocaleString()+' รายการจาก Codex CLI และ VS Code extension · แสดง '+historyRows.length;
    $('history-sync-time').textContent=data.sync?.at?'ซิงก์ล่าสุด '+time(data.sync.at):'กำลังซิงก์';
    if(data.sync?.error)$('history-summary').textContent='ซิงก์ไม่สำเร็จ: '+data.sync.error;
    return true;
  }catch(err){
    if(request===historyRequest&&query===historyQuery){list.innerHTML='<div class="empty-small error-text">โหลดประวัติไม่สำเร็จ: '+escape(err.message)+'</div>';$('history-more').hidden=true;$('history-summary').textContent='ตรวจการเชื่อมต่อแล้วลองซิงก์อีกครั้ง';}
    return false;
  }finally{if(request===historyRequest)list.removeAttribute('aria-busy');}
}
async function loadHistorySummary(){const list=$('history-list');if(!list.dataset.loaded){list.dataset.loaded='1';if(!await loadHistory())delete list.dataset.loaded;}}
$('history-list').onclick=async e=>{
  const row=e.target.closest('[data-thread]');if(!row)return;
  const threadId=row.dataset.thread,request=++historyRead;historySelected=threadId;
  $('history-list').querySelectorAll('.history-row').forEach(x=>x.classList.toggle('selected',x===row));
  $('history-chat').setAttribute('aria-busy','true');$('history-chat').innerHTML='<p class="empty-small">กำลังโหลดประวัติจาก Codex…</p>';
  try{
    const data=await post('history/read',{threadId});if(request!==historyRead)return;selectedRun=data.runId;
    $('history-chat').innerHTML='<header class="history-chat-head"><div><h2>'+escape(data.thread.name||data.thread.preview||'Codex chat')+'</h2><p>'+escape(data.thread.source==='vscode'?'VS Code extension':'Codex CLI')+' · '+escape(data.thread.model||'')+' · '+escape(data.thread.cwd||'')+'</p></div><button type="button" class="primary" id="history-continue">สั่งต่อใน Live monitor</button></header><div class="history-messages">'+((data.messages||[]).map(m=>'<article class="history-message '+(m.role==='user'?'user':'assistant')+'"><span>'+(m.role==='user'?'คุณ':'Codex')+'</span><p>'+escape(m.text)+'</p></article>').join('')||'<p class="empty-small">Codex ไม่มีข้อความที่บันทึกไว้ใน thread นี้</p>')+'</div>';
    $('history-continue').onclick=()=>{setView('monitor');$('run-select').value=selectedRun;$('run-select').dispatchEvent(new Event('change'));$('prompt').focus();};
  }catch(err){if(request===historyRead)$('history-chat').innerHTML='<p class="error-text">โหลดประวัติไม่สำเร็จ: '+escape(err.message)+'</p>';}
  finally{if(request===historyRead)$('history-chat').removeAttribute('aria-busy');}
};
$('history-more').onclick=()=>loadHistory(true);$('history-search').oninput=()=>{clearTimeout(historyTimer);historyTimer=setTimeout(()=>{historyQuery=$('history-search').value;loadHistory();},220);};
$('sync-history').onclick=async e=>{const button=e.currentTarget;button.disabled=true;button.textContent='กำลังซิงก์…';try{await post('history/sync');if(!await loadHistory())throw Error('ซิงก์แล้ว แต่โหลดรายการประวัติไม่สำเร็จ');toast('ซิงก์ประวัติ Codex แล้ว');}catch(err){toast(err.message,true);}finally{button.disabled=false;button.textContent='↻ ซิงก์ประวัติทั้งหมด';}};

window.addEventListener('hashchange',()=>{view=location.hash==='#workflow'?'workflow':location.hash==='#history'?'history':'monitor';applyView();render();if(view==='workflow')fitFlow();});
window.addEventListener('resize',()=>{if(view==='workflow')fitFlow();});
applyView();init().then(()=>{if(view==='workflow')fitFlow();});
