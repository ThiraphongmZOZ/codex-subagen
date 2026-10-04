import {readFileSync,writeFileSync,mkdirSync,existsSync,renameSync,readdirSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const roleDefaults=[
  {name:'explorer',description:'สำรวจ repository และส่งหลักฐานให้ Coordinator โดยไม่แก้ไฟล์',model:'gpt-6-luna',reasoningEffort:'',sandboxMode:'read-only',instructions:'Inspect only the files and code paths relevant to the task. Trace current behavior, tests, and evidence. Do not modify files. Return relevant files, code paths, current behavior, evidence, risks, and unknowns concisely.'},
  {name:'planner',description:'วิเคราะห์ root cause และวางแผนสำหรับงานซับซ้อน โดยไม่ลงมือแก้',model:'gpt-6.1-sol',reasoningEffort:'medium',sandboxMode:'read-only',instructions:'Act as the senior planning agent. Use only the concise evidence supplied by the coordinator. Do not modify files. Return root cause, smallest safe solution, files and exact logic to change, risks, needed checks, and implementation order.'},
  {name:'worker',description:'ลงมือ implement ตามขอบเขตที่ Coordinator มอบหมาย',model:'gpt-6-luna',reasoningEffort:'medium',sandboxMode:'',instructions:'Implement the assigned change using the approved scope. Modify only necessary files, preserve unrelated behavior, follow project conventions, and inspect the final diff. If blocked, stop and return evidence instead of redesigning the plan.'},
  {name:'reviewer',description:'ตรวจ implementation งานทั่วไป หา regression และ edge cases',model:'gpt-6-luna',reasoningEffort:'medium',sandboxMode:'read-only',instructions:'Review the implementation for correctness, regressions, scope creep, edge cases, and missing checks. Do not modify files. Return PASS or NEEDS_CHANGES followed by concrete findings and recommended checks.'},
  {name:'senior_reviewer',description:'ตรวจงานเสี่ยงสูง เช่น business logic, migration, API หรือ architecture ด้วย Sol',model:'gpt-6.1-sol',reasoningEffort:'high',sandboxMode:'read-only',instructions:'Review high-risk business logic, migrations, public APIs, and architecture decisions. Check correctness, data integrity, regressions, security, and missing edge cases. Do not modify files. Lead with concrete findings and state PASS or NEEDS_CHANGES.'}
];
const agentMarker='# Managed by Acode Agent Control.';
const agentPath=(workspace,name)=>path.join(workspace,'.codex','agents','acode-'+name+'.toml');
const samePath=(a,b)=>{const left=path.resolve(a),right=path.resolve(b);return process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;};
function agentName(contents){return contents.match(/^name\s*=\s*["']([^"']+)["']/m)?.[1]||'';}
function agentToml(role) {
  const lines=[agentMarker,'name = '+JSON.stringify(role.name),'description = '+JSON.stringify(role.description)];
  if(role.model)lines.push('model = '+JSON.stringify(role.model));
  if(role.reasoningEffort)lines.push('model_reasoning_effort = '+JSON.stringify(role.reasoningEffort));
  if(role.sandboxMode)lines.push('sandbox_mode = '+JSON.stringify(role.sandboxMode));
  lines.push('developer_instructions = '+JSON.stringify(role.instructions),'');
  return lines.join('\n');
}
export function writeAgentDefinitions(next,previous={workspace:next.workspace,roles:[]},operations={}) {
  const io={writeFileSync,renameSync,unlinkSync,...operations};
  const directory=path.join(next.workspace,'.codex','agents');
  const active=next.roles.filter(role=>role.enabled);
  const files=existsSync(directory)?readdirSync(directory).filter(name=>name.toLowerCase().endsWith('.toml')):[];
  const writes=active.map(role=>{
    const target=agentPath(next.workspace,role.name),existing=files.map(name=>path.join(directory,name)).find(file=>file.toLowerCase()===target.toLowerCase());
    const existingContents=existing?readFileSync(existing,'utf8'):null;
    if(existingContents!==null&&!existingContents.includes(agentMarker))throw Error('ไม่สามารถเขียนทับไฟล์ agent ที่มีอยู่: '+existing);
    const conflict=files.map(name=>path.join(directory,name)).find(file=>{
      if(file.toLowerCase()===target.toLowerCase())return false;
      const contents=readFileSync(file,'utf8');
      return agentName(contents)===role.name&&!contents.includes(agentMarker);
    });
    if(conflict)throw Error('พบ custom agent ชื่อ '+role.name+' อยู่แล้วที่ '+conflict+' กรุณาเปลี่ยนชื่อ role ก่อนบันทึก');
    return {target,contents:agentToml(role),existingContents,temp:target+'.acode-tmp-'+randomUUID(),committed:false};
  });
  const changedWorkspace=!samePath(previous.workspace,next.workspace),cleanupWorkspace=changedWorkspace?previous.workspace:next.workspace;
  const removals=[];
  for(const role of previous.roles||[]){
    if(!/^[a-z][a-z0-9_-]{0,39}$/.test(role.name))continue;
    if(!changedWorkspace&&next.roles.some(item=>item.name===role.name&&item.enabled))continue;
    const target=agentPath(cleanupWorkspace,role.name);
    if(existsSync(target)){const contents=readFileSync(target,'utf8');if(contents.includes(agentMarker))removals.push({target,contents,removed:false});}
  }
  if(writes.length)mkdirSync(directory,{recursive:true});
  try{
    for(const file of writes)io.writeFileSync(file.temp,file.contents,'utf8');
    for(const file of writes){io.renameSync(file.temp,file.target);file.committed=true;}
    for(const file of removals){io.unlinkSync(file.target);file.removed=true;}
  }catch(error){
    const rollbackErrors=[];
    for(const file of removals.filter(item=>item.removed).reverse())try{
      const temp=file.target+'.acode-rollback-'+randomUUID();io.writeFileSync(temp,file.contents,'utf8');io.renameSync(temp,file.target);
    }catch(rollbackError){rollbackErrors.push(rollbackError.message);}
    for(const file of writes.filter(item=>item.committed).reverse())try{
      if(file.existingContents!==null){const temp=file.target+'.acode-rollback-'+randomUUID();io.writeFileSync(temp,file.existingContents,'utf8');io.renameSync(temp,file.target);}
      else if(existsSync(file.target))io.unlinkSync(file.target);
    }catch(rollbackError){rollbackErrors.push(rollbackError.message);}
    for(const file of writes)if(existsSync(file.temp))try{io.unlinkSync(file.temp);}catch(rollbackError){rollbackErrors.push(rollbackError.message);}
    const suffix=rollbackErrors.length?'; rollback incomplete: '+rollbackErrors.join('; '):'; managed agent files were rolled back';
    throw Error('Could not update managed agent files: '+error.message+suffix);
  }
}
