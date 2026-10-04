const $=id=>document.getElementById(id);
let state,token,selectedRun='',filter='all',busy=false,source,view=location.hash==='#workflow'?'workflow':'monitor',flowAgent='',flowSignature='',flowScale=1,flowSize={width:800,height:500};
const labels={running:'กำลังทำงาน',queued:'รอเริ่ม',waiting:'รออนุมัติ',completed:'เสร็จแล้ว',interrupted:'หยุดแล้ว',error:'ผิดพลาด',unknown:'ไม่ทราบสถานะ',closed:'ปิดแล้ว',idle:'ว่าง'};
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=s=>new Date(s).toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
const eventLabels={'run/started':'เริ่มงานใหม่','turn/started':'เริ่มทำงาน','turn/completed':'จบการทำงาน','item/started':'เริ่มกิจกรรม','item/completed':'กิจกรรมเสร็จ','turn/plan/updated':'อัปเดตแผน','approval/requested':'รอการอนุมัติ','request/unsupported':'คำขอที่ยังไม่รองรับ','error':'เกิดข้อผิดพลาด'};
const detailLabels={agentMessage:'กำลังส่งข้อความ',userMessage:'รับโจทย์',collabAgentToolCall:'ประสานงานกับทีม',subAgentActivity:'อัปเดตสถานะ subagent',wait:'รอผลจากทีม',sleep:'รอเวลา',completed:'เสร็จแล้ว',interrupted:'หยุดแล้ว',inProgress:'กำลังทำงาน'};
function toast(message,error=false){$('toast').textContent=message;$('toast').className='toast'+(error?' error':'');$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,7000);}
async function post(route,body={}) {const res=await fetch('/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Acode-Token':token},body:JSON.stringify(body)});const result=await res.json();if(!res.ok)throw Error(result.error);return result;}
function selectedAgents(){return Object.values(state.agents).filter(a=>a.runId===selectedRun);}
function render(){
  if(!state)return;
  if(!selectedRun&&state.runs.length)selectedRun=state.runs[0].id;
  const connected=state.connected;
  $('connection').textContent=connected?'● Connected':'○ Offline';
  $('side-dot').hidden=!connected;
  $('banner').hidden=!state.error&&!!state.account;
  $('banner').textContent=state.error||(!state.account?'ยังไม่ได้เข้าสู่ระบบ Codex กรุณาเปิด terminal แล้วใช้ codex login จากนั้นกดเชื่อมต่อใหม่':'');
  $('account-label').textContent=connected?('Codex connected · '+(state.account?.type||'Not signed in')+(state.account?.planType?' / '+state.account.planType:'')):'Codex disconnected';
  $('workspace-label').textContent='⌁ '+state.config.workspace+' · สูงสุด '+state.config.maxAgents+' subagents';
  $('model-tag').textContent=state.config.model||(state.models.find(m=>m.isDefault)?.displayName)||'Codex default';
  $('start').disabled=busy||!connected||!state.account||state.runs.some(r=>['starting','running'].includes(r.status))||Object.values(state.agents).some(a=>['running','waiting','queued'].includes(a.status));
  const active=state.runs.some(r=>['starting','running'].includes(r.status))||Object.values(state.agents).some(a=>['running','waiting','queued'].includes(a.status));
  const selected=state.runs.find(r=>r.id===selectedRun);
  $('continue').disabled=busy||!connected||!state.account||active||!selected?.threadId||!['completed','error','interrupted','unknown'].includes(selected.status);
  $('composer-help').textContent=selected?.threadId?'ส่งคำสั่งใหม่ หรือคุยต่อจากบริบทของ thread ที่เลือก':'เริ่มงานใหม่ หรือเลือก thread เดิมเพื่อส่งคำสั่งต่อ';
  $('run-select').innerHTML=state.runs.length?state.runs.map(r=>`<option value="${escape(r.id)}" ${r.id===selectedRun?'selected':''}>${escape(r.prompt.slice(0,40))} · ${escape(labels[r.status]||r.status)}</option>`).join(''):'<option value="">ยังไม่มีงาน</option>';
  const agents=selectedAgents(),working=agents.filter(a=>['running','waiting','queued'].includes(a.status));
  $('total').textContent=agents.length;$('working').textContent=working.length;$('completed').textContent=agents.filter(a=>a.status==='completed').length;$('errors').textContent=agents.filter(a=>['error','unknown'].includes(a.status)).length;$('agent-count').textContent=agents.length;
  const ordered=[],visit=(parent,depth=0)=>{for(const a of agents.filter(a=>a.parentId===parent)){if(ordered.some(x=>x.a.id===a.id))continue;ordered.push({a,depth});if(depth<12)visit(a.id,depth+1);}};
  visit(null);for(const a of agents)if(!ordered.some(x=>x.a.id===a.id))ordered.push({a,depth:0});
  const visible=ordered.filter(({a})=>filter==='all'||(filter==='working'?['running','waiting','queued'].includes(a.status):a.status==='completed'));
  const openIds=new Set([...$('agents').querySelectorAll('details[open]')].map(d=>d.dataset.id));
  if(agents.length){$('agents').innerHTML=visible.length?visible.map(({a,depth})=>`<article class="agent-card ${depth?'child':''}"><div class="agent-top"><div class="avatar">${depth?'↳':'◈'}</div><div><div class="agent-name">${escape(a.name)}</div><div class="agent-id">${depth?'SUBAGENT':'COORDINATOR'} · ${escape(a.id.slice(0,8))}</div></div><span class="badge ${escape(a.status)}">${escape(labels[a.status]||a.status)}</span></div><div class="agent-task">${escape(a.task||'Codex ยังไม่ส่งรายละเอียดงาน — ดูกิจกรรมและผลลัพธ์ด้านล่าง')}</div><div class="agent-activity">${escape(a.activity||'รอเหตุการณ์จาก Codex')} · ${time(a.updatedAt)}</div>${a.plan?.length?'<ul class="agent-plan">'+a.plan.map(p=>`<li>${escape(p.step)} · ${escape(p.status)}</li>`).join('')+'</ul>':''}${a.output?`<details data-id="${escape(a.id)}" ${openIds.has(a.id)?'open':''}><summary>ดูผลลัพธ์</summary><pre>${escape(a.output)}</pre></details>`:''}</article>`).join(''):'<div class="empty-small">ไม่มี agent ในสถานะนี้</div>';}
  const run=state.runs.find(r=>r.id===selectedRun);$('run-actions').hidden=!run;$('stop').hidden=!run||(!['starting','running'].includes(run.status)&&!working.length);$('run-status').textContent=run?'สถานะงาน: '+(labels[run.status]||run.status):'';
  const ids=new Set(agents.map(a=>a.id));const events=state.events.filter(e=>(!e.threadId||ids.has(e.threadId))&&eventLabels[e.method]);
  $('activity').innerHTML=events.length?events.slice(0,60).map(e=>`<div class="activity-item"><time>${time(e.time)}</time><b>${escape(eventLabels[e.method])} · ${escape(state.agents[e.threadId]?.name||'ระบบ')}</b><p>${escape(detailLabels[e.detail]||e.detail.slice(0,230))}</p></div>`).join(''):'<div class="empty-small">ยังไม่มีกิจกรรม</div>';
  renderWorkflow(agents,run);
  $('approvals').innerHTML=state.approvals.map(r=>`<article class="approval"><h3>Codex รอการอนุมัติ</h3><p>${escape(r.params.reason||r.method)}</p><pre>${escape(r.params.command||JSON.stringify(r.params,null,2))}</pre><div class="approval-actions"><button class="primary" data-approval="${escape(r.id)}" data-decision="accept">อนุมัติครั้งนี้</button><button class="secondary" data-approval="${escape(r.id)}" data-decision="decline">ปฏิเสธ</button></div></article>`).join('');
}
async function init(){try{const res=await fetch('/api/state');state=await res.json();token=state.token;delete state.token;render();source?.close();source=new EventSource('/api/events');source.onmessage=e=>{state=JSON.parse(e.data);render();};source.onerror=()=>{$('connection').textContent='○ Reconnecting';$('start').disabled=true;};}catch(e){toast(e.message,true);}}
$('run-form').onsubmit=async e=>{e.preventDefault();const mode=e.submitter?.value||'new';busy=true;render();try{const route=mode==='continue'?'continue':'run';const r=await post(route,{runId:selectedRun,prompt:$('prompt').value});selectedRun=r.runId;$('prompt').value='';toast(mode==='continue'?'ส่งคำสั่งต่อใน thread เดิมแล้ว':'เริ่มงานใหม่แล้ว');render();}catch(e){toast(e.message,true);}finally{busy=false;render();}};
$('run-select').onchange=e=>{selectedRun=e.target.value;render();};
document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('active',x===b));render();});
$('stop').onclick=async()=>{try{await post('stop',{runId:selectedRun});toast('ส่งคำสั่งหยุดแล้ว');}catch(e){toast(e.message,true);}};
$('reconnect').onclick=async()=>{try{await post('reconnect');await init();toast('เชื่อมต่อแล้ว');}catch(e){toast(e.message,true);}};
$('approvals').onclick=async e=>{const b=e.target.closest('[data-approval]');if(!b)return;try{await post('approval',{id:/^\d+$/.test(b.dataset.approval)?Number(b.dataset.approval):b.dataset.approval,decision:b.dataset.decision});}catch(e){toast(e.message,true);}};
function addRole(role={name:'',instructions:''}){const div=document.createElement('div');div.className='role-row';div.innerHTML=`<div class="role-name-row"><input aria-label="ชื่อบทบาท" placeholder="เช่น reviewer" required pattern="[a-zA-Z][a-zA-Z0-9_-]{0,39}" value="${escape(role.name)}"><button type="button" class="secondary remove-role" aria-label="ลบบทบาท">×</button></div><textarea aria-label="คำสั่งของบทบาท" required maxlength="4000" rows="2" placeholder="อธิบายงานและผลลัพธ์ที่ต้องการ">${escape(role.instructions)}</textarea>`;div.querySelector('button').onclick=()=>div.remove();$('roles').append(div);}
const extraModels=[{model:'gpt-6.1-sol',displayName:'GPT-6.1-Sol'},{model:'gpt-6-sol',displayName:'GPT-6-Sol'},{model:'gpt-6-luna',displayName:'GPT-6-Luna'}];
function modelHelp(){
  const value=$('cfg-model').value, model=state.models.find(m=>(m.model||m.id)===value);
  $('model-help').textContent=!value?'ใช้โมเดลเริ่มต้นจาก Codex CLI':model?(model.hidden?'โมเดลนี้อยู่ใน catalog แต่ Codex ซ่อนไว้จากรายการปกติ':'โมเดลนี้อยู่ใน catalog ของ Codex CLI'):'โมเดลนี้ยังไม่อยู่ใน catalog ของ Codex CLI บนเครื่อง การเลือกไม่ได้ยืนยันสิทธิ์ใช้งาน หากไม่รองรับ Codex จะแสดงข้อผิดพลาดตอนเริ่มงาน';
}
function modelOptions(value=state.config.model){
  const option=m=>'<option value="'+escape(m.model||m.id)+'">'+escape(m.displayName||m.model||m.id)+'</option>';
  const group=(label,models)=>models.length?'<optgroup label="'+label+'">'+models.map(option).join('')+'</optgroup>':'';
  const listed=new Set(state.models.map(m=>m.model||m.id));
  const extras=extraModels.filter(m=>!listed.has(m.model));
  if(value&&!listed.has(value)&&!extras.some(m=>m.model===value))extras.push({model:value,displayName:value});
  $('cfg-model').innerHTML='<option value="">ใช้ค่าเริ่มต้น Codex</option>'+group('จาก catalog ของ Codex CLI',state.models.filter(m=>!m.hidden))+group('ใน catalog แต่ซ่อนจากรายการปกติ',state.models.filter(m=>m.hidden))+group('โมเดลเพิ่มเติม — ยังไม่ยืนยันสิทธิ์',extras);
  $('cfg-model').value=value;modelHelp();
}
$('cfg-model').onchange=modelHelp;
$('refresh-models').onclick=async()=>{const button=$('refresh-models');button.disabled=true;try{const value=$('cfg-model').value;const result=await post('models/refresh');state.models=result.models;modelOptions(value);toast('รีเฟรชรายการโมเดลแล้ว');}catch(e){toast(e.message,true);}finally{button.disabled=false;}};
$('nav-config').onclick=()=>{if(!state)return;$('cfg-workspace').value=state.config.workspace;$('cfg-max').value=state.config.maxAgents;modelOptions();$('roles').innerHTML='';state.config.roles.forEach(addRole);$('config-dialog').showModal();};
$('nav-monitor').onclick=()=>setView('monitor');$('nav-workflow').onclick=()=>setView('workflow');$('close-config').onclick=()=>$('config-dialog').close();$('add-role').onclick=()=>{if($('roles').children.length<8)addRole();else toast('เพิ่มได้สูงสุด 8 บทบาท',true);};
$('config-form').onsubmit=async e=>{e.preventDefault();try{await post('config',{workspace:$('cfg-workspace').value,model:$('cfg-model').value,maxAgents:Number($('cfg-max').value),roles:[...$('roles').children].map(row=>({name:row.querySelector('input').value,instructions:row.querySelector('textarea').value}))});$('config-dialog').close();toast('บันทึกแล้ว — ใช้กับงานใหม่');}catch(e){toast(e.message,true);}};
function setView(next){view=next;location.hash=next==='workflow'?'workflow':'';$('config-dialog').close();applyView();render();}
function applyView(){
  $('workflow-page').hidden=view!=='workflow';$('monitor-page').hidden=view==='workflow';document.body.classList.toggle('workflow-view',view==='workflow');
  $('nav-monitor').classList.toggle('active',view==='monitor');$('nav-workflow').classList.toggle('active',view==='workflow');$('page-title').textContent=view==='workflow'?'Agent workflow':'Agent dashboard';
}
function zoomFlow(value){flowScale=Math.max(.35,Math.min(1.6,value));$('flow-stage').style.transform='scale('+flowScale+')';$('flow-space').style.width=flowSize.width*flowScale+'px';$('flow-space').style.height=flowSize.height*flowScale+'px';$('flow-zoom-label').textContent=Math.round(flowScale*100)+'%';}
function fitFlow(){zoomFlow(Math.min(1,($('flow-viewport').clientWidth-32)/flowSize.width,($('flow-viewport').clientHeight-70)/flowSize.height));$('flow-viewport').scrollTo({top:0,left:0});}
function agentModel(a,run){return a.model||(!a.parentId?run?.model:null)||'ยังไม่ทราบโมเดล';}
function renderWorkflow(agents,run){
  $('flow-run-select').innerHTML=$('run-select').innerHTML;$('flow-run-select').value=selectedRun;
  $('flow-summary').textContent=run?(run.lastInput||run.prompt)+' · '+(labels[run.status]||run.status)+' · '+agents.length+' agents':'ยังไม่มีงาน — เริ่มงานจากหน้า Live monitor';
  $('flow-stop').hidden=$('stop').hidden;
  if(!agents.some(a=>a.id===flowAgent))flowAgent=run?.threadId||agents[0]?.id||'';
  const signature=JSON.stringify([selectedRun,flowAgent,run?.model,agents.map(a=>[a.id,a.parentId,a.name,a.status,a.model,a.task,a.activity])]);
  if(signature!==flowSignature){
    flowSignature=signature;
    if(!agents.length){$('flow-stage').innerHTML='<div class="flow-empty"><div class="empty-icon">⤳</div><h3>Workflow จะปรากฏเมื่อเริ่มงาน</h3><p>กล่องตัวหลักและตัวลูกสร้างจาก agent ที่ทำงานจริง</p></div>';flowSize={width:700,height:500};}
    else {
      const nodes=[],seen=new Set();let leaf=0;
      const visit=(a,depth)=>{if(seen.has(a.id))return null;seen.add(a.id);const node={a,depth,x:0,y:42+depth*232};nodes.push(node);const children=agents.filter(c=>c.parentId===a.id).map(c=>visit(c,depth+1)).filter(Boolean);node.x=children.length?(children[0].x+children.at(-1).x)/2:42+leaf++*340;return node;};
      agents.filter(a=>!a.parentId||!agents.some(p=>p.id===a.parentId)).forEach(a=>visit(a,0));agents.filter(a=>!seen.has(a.id)).forEach(a=>visit(a,0));
      flowSize={width:Math.max(720,...nodes.map(n=>n.x+344)),height:Math.max(480,...nodes.map(n=>n.y+210))};
      const paths=nodes.filter(n=>nodes.some(p=>p.a.id===n.a.parentId)).map(n=>{const p=nodes.find(p=>p.a.id===n.a.parentId),x=p.x+145,y=p.y+168,endX=n.x+145,endY=n.y;return '<path class="flow-edge '+escape(n.a.status)+'" d="M '+x+' '+y+' C '+x+' '+(y+40)+' '+endX+' '+(endY-40)+' '+endX+' '+endY+'" />';}).join('');
      $('flow-stage').innerHTML='<svg class="flow-edges" width="'+flowSize.width+'" height="'+flowSize.height+'" aria-hidden="true">'+paths+'</svg>'+nodes.map(({a,x,y})=>'<button type="button" data-flow-agent="'+escape(a.id)+'" class="flow-node '+escape(a.status)+(a.id===flowAgent?' selected':'')+'" style="left:'+x+'px;top:'+y+'px" aria-pressed="'+(a.id===flowAgent)+'"><span class="flow-node-top"><span class="flow-icon">'+(a.parentId?'↳':'◈')+'</span><span class="flow-role">'+(a.parentId?'SUBAGENT · ตัวลูก':'COORDINATOR · ตัวหลัก')+'</span></span><strong>'+escape(a.name?.split('/').filter(Boolean).at(-1)||'Agent')+'</strong><span class="flow-model">'+escape(agentModel(a,run))+'</span><span class="flow-node-status"><i class="flow-dot '+escape(a.status)+'"></i>'+escape(labels[a.status]||a.status)+'</span><span class="flow-task">'+escape(a.task||'รอรายละเอียดงาน')+'</span></button>').join('');
    }
    $('flow-stage').style.width=flowSize.width+'px';$('flow-stage').style.height=flowSize.height+'px';zoomFlow(flowScale);
  }
  const a=agents.find(a=>a.id===flowAgent),inspector=$('flow-inspector');
  const detail=a?'<span class="eyebrow">'+(a.parentId?'SUBAGENT':'COORDINATOR')+'</span><h3>'+escape(a.name)+'</h3><span class="badge '+escape(a.status)+'">'+escape(labels[a.status]||a.status)+'</span><dl><dt>โมเดลของ thread</dt><dd>'+escape(agentModel(a,run))+'</dd><dt>ตัวหลักที่เชื่อมต่อ</dt><dd>'+escape(state.agents[a.parentId]?.name||'ตัวหลักของงานนี้')+'</dd><dt>งานที่รับผิดชอบ</dt><dd>'+escape(a.task||'ยังไม่มีรายละเอียด')+'</dd><dt>กิจกรรมล่าสุด</dt><dd>'+escape(detailLabels[a.activity]||a.activity||'รอเหตุการณ์')+'</dd></dl>'+(a.output?'<h3>ผลลัพธ์</h3><pre>'+escape(a.output)+'</pre>':'<p>ยังไม่มีผลลัพธ์</p>'):'<h3>รายละเอียด agent</h3><p>คลิกกล่องในแผนผังเพื่อดูงานและผลลัพธ์</p>';
  if(inspector.innerHTML!==detail)inspector.innerHTML=detail;
}
$('flow-stage').onclick=e=>{const node=e.target.closest('[data-flow-agent]');if(node){flowAgent=node.dataset.flowAgent;render();}};
$('flow-run-select').onchange=e=>{selectedRun=e.target.value;flowAgent='';flowSignature='';render();fitFlow();};
$('flow-stop').onclick=()=>$('stop').click();
$('flow-zoom-in').onclick=()=>zoomFlow(flowScale+.1);$('flow-zoom-out').onclick=()=>zoomFlow(flowScale-.1);$('flow-fit').onclick=fitFlow;
window.addEventListener('hashchange',()=>{view=location.hash==='#workflow'?'workflow':'monitor';applyView();render();});
applyView();init();
