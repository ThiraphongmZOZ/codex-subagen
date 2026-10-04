import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createState,ensureAgent,reduceEvent,compareThreadRecency,sumTokenUsage,estimateTokenCost} from './monitor.mjs';
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
 reduceEvent(s,'thread/tokenUsage/updated',{threadId:'child',tokenUsage:{total:{totalTokens:40,inputTokens:25,cachedInputTokens:5,cacheWriteInputTokens:0,outputTokens:15,reasoningOutputTokens:3}}});
 assert.equal(s.agents.root.tokenUsage.total.inputTokens,100);assert.equal(sumTokenUsage(Object.values(s.agents)).totalTokens,190);
});
test('API-equivalent token estimate uses custom cache and output rates and needs rates for used buckets',()=>{
 const usage={inputTokens:100,cachedInputTokens:20,cacheWriteInputTokens:10,outputTokens:40};
 assert.equal(estimateTokenCost(usage,{input:1,cachedInput:0.5,cacheWrite:2,output:3}),0.00022);
 assert.equal(estimateTokenCost(usage,{input:1,output:3}),null);
});
