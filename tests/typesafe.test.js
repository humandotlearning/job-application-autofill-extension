import test from 'node:test';
import assert from 'node:assert/strict';
import { createSemanticMatcher, TYPESAFE_MODEL } from '../src/typesafe.js';
import { rankSuggestionEvidence, selectSemanticEvidence, semanticEligible } from '../src/retrieval.js';

const field = (id, label) => ({id,handle:`h-${id}`,label,labelConfidence:'high',type:'textarea',currentValue:'',rawValue:'',constraints:{}});
const record = (key, question, answer, extra = {}) => ({key,question,answer,confirmationState:'confirmed',sensitivity:'safe',...extra});
const jsonResponse = value => ({ok:true,status:200,json:async()=>value});
const answersFor = (body, selections = {}) => Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
  if (question.type === 'noul') return [id, {type:'noul', noul:id.endsWith('_conflict') ? 0 : 1}];
  if (question.type === 'score') return [id, {type:'score',score:3,confidence:1,
    probabilities:{0:0,1:0,2:0,3:1},legend:{0:question.criteria[0],1:question.criteria[1],2:question.criteria[2],3:question.criteria[3]}}];
  const supplied=selections[id];
  if (supplied && typeof supplied === 'object') return [id,supplied];
  const choice=supplied || 'none';
  return [id,{type:'choice',choice,confidence:1,probabilities:Object.fromEntries(Object.keys(question.criteria).map(key=>[key,key===choice?1:0]))}];
}));

test('batches parallel field questions into one request and deduplicates shared state', async () => {
  const calls=[], traces=[];
  const matcher=createSemanticMatcher({fetchImpl:async(url,options)=>{
    calls.push({url,body:JSON.parse(options.body)});
    return jsonResponse({answers:answersFor(calls.at(-1).body,{f0:'r0'})});
  },traceImpl:(name,attributes)=>traces.push({name,attributes})});
  const records=[
    record('reliability','Engineering achievement','Reduced production outages with health checks and automated rollback.'),
    record('leadership','Leadership example','Led a team through a difficult migration.'),
  ];
  const fields=[field('reliability-field','Describe a time you improved service reliability'),field('motivation','Why this company?')];
  const result=await matcher.match({fields,records,apiKey:'ts_test',scope:'page-1'});
  assert.equal(calls.length,1);
  assert.equal(calls[0].body.model,TYPESAFE_MODEL);
  assert.deepEqual(Object.keys(calls[0].body.questions),['f0','f0_sufficiency','f0_conflict','f1','f1_sufficiency','f1_conflict']);
  assert.deepEqual(calls[0].body.state.fields.f0.evidenceIds,['r0','r1']);
  assert.equal(calls[0].body.state.records.length,2);
  assert.equal(result[0].status,'matched');
  assert.equal(result[0].candidate.answer,records[0].answer);
  assert.equal(result[1].status,'none');
  const summary=traces.find(trace=>trace.name==='saved_answer_match_result');
  assert.equal(summary.attributes['typesafe.request_count'],1);
  assert.equal(summary.attributes['typesafe.matched'],1);
  assert.equal(summary.attributes['typesafe.no_match'],1);
  assert.equal(summary.attributes['typesafe.cache_hits'],0);
});

test('same-label fields keep separate choices and bounded disambiguating context', async () => {
  let request;
  const matcher=createSemanticMatcher({traceImpl:()=>{},fetchImpl:async(_url,options)=>{
    request=JSON.parse(options.body);
    return jsonResponse({answers:answersFor(request)});
  }});
  const fields=[field('first','Additional information'),field('second','Additional information')];
  fields[0].helpText='Explain the first project.';
  fields[1].nearbyContext='Second project section';
  await matcher.match({fields,records:[record('saved','Project details','Built a reliable service.')],apiKey:'ts_test'});
  assert.deepEqual(Object.keys(request.questions),['f0','f0_sufficiency','f0_conflict','f1','f1_sufficiency','f1_conflict']);
  assert.equal(request.state.fields.f0.helpText,'Explain the first project.');
  assert.equal(request.state.fields.f1.nearbyContext,'Second project section');
});

test('reuses unchanged results and coalesces concurrent identical searches', async () => {
  let calls=0,release;
  const matcher=createSemanticMatcher({fetchImpl:async(_url,options)=>{
    calls+=1;
    await new Promise(resolve=>{release=resolve;});
    const body=JSON.parse(options.body);
    return jsonResponse({answers:answersFor(body)});
  }});
  const fields=[field('one','Tell us about reliability')];
  const records=[record('saved','Achievement','Improved reliability')];
  const first=matcher.match({fields,records,apiKey:'ts_test',scope:'page-1'});
  const second=matcher.match({fields,records,apiKey:'ts_test',scope:'page-1'});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(calls,1);
  release();
  await Promise.all([first,second]);
  await matcher.match({fields,records,apiKey:'ts_test',scope:'page-1'});
  assert.equal(calls,1);
});

test('failed searches stay failed until explicit retry', async () => {
  let calls=0;
  const matcher=createSemanticMatcher({fetchImpl:async(_url,options)=>{
    calls+=1;
    if(calls===1) throw new Error('offline');
    const body=JSON.parse(options.body);
    return jsonResponse({answers:answersFor(body)});
  }});
  const request={fields:[field('one','Tell us about reliability')],records:[record('saved','Achievement','Improved reliability')],apiKey:'ts_test',scope:'page-1'};
  assert.equal((await matcher.match(request))[0].status,'failed');
  assert.equal((await matcher.match(request))[0].status,'failed');
  assert.equal(calls,1);
  assert.equal((await matcher.match({...request,retry:true}))[0].status,'none');
  assert.equal(calls,2);
});

test('hard policy filters run before semantic selection', () => {
  const target=field('bio','Describe an engineering achievement');
  const valid=record('valid','Engineering achievement','Built a safer deployment system.');
  const blocked=[
    record('pending','Achievement','Pending answer',{confirmationState:'pending'}),
    record('never','Achievement','Never reuse',{reusePolicy:'never'}),
    record('suppressed','Achievement','Suppressed',{suppressedFor:['describe an engineering achievement|textarea']}),
    record('legal','Work authorization','Yes',{sensitivity:'legal'}),
    record('long','Achievement','x'.repeat(8001)),
  ];
  assert.equal(semanticEligible(target,valid),true);
  assert.deepEqual(selectSemanticEvidence(target,[...blocked,valid]),[valid]);
});

test('custom choices with observed options are eligible for review-only JEV matching', () => {
  const target = {...field('country', 'Country'), type: 'select', widget: 'custom', options: ['India'], optionsStatus: 'partial'};
  const saved = record('country', 'Country', 'India');
  assert.equal(semanticEligible(target, saved), true);
});

test('shortlists retain compatible answers beyond the lexical-match gate', () => {
  const target=field('ambiguity','What makes you effective in ambiguous situations?');
  const compatible=record('challenge','A challenge I handled','I clarified priorities, tested assumptions, and communicated tradeoffs early.');
  assert.deepEqual(selectSemanticEvidence(target,[compatible]),[compatible]);
});

test('low-confidence and unknown choices cannot become recommendations', async () => {
  for (const answer of [
    {type:'choice',choice:'r0',confidence:0.79,probabilities:{none:0.21,r0:0.79}},
    {type:'choice',choice:'unknown',confidence:1,probabilities:{none:0,r0:0}},
  ]) {
    const matcher=createSemanticMatcher({fetchImpl:async(_url,options)=>{
      const body=JSON.parse(options.body);
      return jsonResponse({answers:answersFor(body,{f0:answer})});
    }});
    const result=await matcher.match({fields:[field('one','Reliability')],records:[record('saved','Achievement','Improved reliability')],apiKey:'ts_test'});
    assert.notEqual(result[0].status,'matched');
  }
});

test('maps a confirmed fact to an exact visible option for one-time review', async () => {
  let request;
  const matcher=createSemanticMatcher({traceImpl:()=>{},fetchImpl:async(_url,options)=>{
    request=JSON.parse(options.body);
    return jsonResponse({answers:answersFor(request,{f0:{type:'choice',choice:'o1',confidence:0.93,probabilities:{none:0.02,o0:0.05,o1:0.93}}})});
  }});
  const choice={id:'authorization',handle:'h-auth',label:'Are you authorized to work?',labelConfidence:'high',type:'radio',currentValue:'',rawValue:'',options:['No, sponsorship required','Yes, authorized to work'],constraints:{}};
  const records=[record('authorization','Work authorization','Authorized to work')];
  const [result]=await matcher.match({fields:[choice],records,apiKey:'ts_test'});
  assert.equal(request.questions.f0.criteria.o1,'Select the exact enabled visible option label: Yes, authorized to work');
  assert.equal(result.status,'matched');
  assert.equal(result.candidate.kind,'semantic_option');
  assert.equal(result.candidate.answer,'Yes, authorized to work');
});

test('recommends autofill only for complete, high-confidence, low-risk factual matches', async () => {
  const email={...field('email','Email address'),type:'email'};
  const saved=record('email','Email address','person@example.com');
  let request;
  const matcher=createSemanticMatcher({traceImpl:()=>{},fetchImpl:async(_url,options)=>{
    request=JSON.parse(options.body);
    return jsonResponse({answers:answersFor(request,{f0:'r0'})});
  }});
  const [result]=await matcher.match({fields:[email],records:[saved],apiKey:'ts_test'});
  assert.deepEqual(Object.keys(request.questions),['f0','f0_sufficiency','f0_conflict']);
  assert.equal(result.status,'matched');
  assert.equal(result.route,'factual');
  assert.equal(result.coverage.complete,true);
  assert.equal(result.disposition,'autofill');
  assert.equal(result.candidate.requiresApproval,true);
});

test('incomplete evidence coverage prevents automatic filling', async () => {
  const email={...field('email','Email address'),type:'email'};
  const records=Array.from({length:255},(_,index)=>record(`email-${index}`,'Email address',`person${index}@example.com`));
  const matcher=createSemanticMatcher({traceImpl:()=>{},fetchImpl:async(_url,options)=>{
    const body=JSON.parse(options.body);
    return jsonResponse({answers:answersFor(body,{f0:'r0'})});
  }});
  const [result]=await matcher.match({fields:[email],records,apiKey:'ts_test'});
  assert.equal(result.status,'matched');
  assert.equal(result.coverage.complete,false);
  assert.equal(result.disposition,'review');
});

test('ranks large narrative evidence pools with Score and returns eight source records', async () => {
  const records=Array.from({length:21},(_,index)=>record(`story-${index}`,'Project example',`Built production system ${index}.`));
  let request;
  const matcher=createSemanticMatcher({traceImpl:()=>{},fetchImpl:async(_url,options)=>{
    request=JSON.parse(options.body);
    return jsonResponse({answers:answersFor(request)});
  }});
  const ranked=await matcher.rankNarrative({field:field('story','Describe a production project'),records,apiKey:'ts_test'});
  assert.equal(Object.keys(request.questions).length,21);
  assert.equal(ranked.length,8);
  assert.deepEqual(ranked.map(item=>item.key),records.slice(0,8).map(item=>item.key));
});

test('narrative ranking keeps only evidence scoring at least useful', async () => {
  const records=Array.from({length:21},(_,index)=>record(`story-${index}`,'Project example',`Built production system ${index}.`));
  const matcher=createSemanticMatcher({traceImpl:()=>{},fetchImpl:async(_url,options)=>{
    const body=JSON.parse(options.body);
    const scores=[0,1,2,3,...Array(17).fill(0)];
    const answers=Object.fromEntries(Object.entries(body.questions).map(([id,question],index)=>[id,{
      type:'score',score:scores[index],confidence:index===2?0.8:1,
      probabilities:{0:Number(scores[index]===0),1:Number(scores[index]===1),2:Number(scores[index]===2),3:Number(scores[index]===3)},
      legend:{0:question.criteria[0],1:question.criteria[1],2:question.criteria[2],3:question.criteria[3]},
    }]));
    return jsonResponse({answers});
  }});
  const ranked=await matcher.rankNarrative({field:field('story','Describe a production project'),records,apiKey:'ts_test'});
  assert.deepEqual(ranked.map(item=>item.key),['story-3','story-2']);
});

test('narrative ranking returns no evidence when every score is below useful', async () => {
  const records=Array.from({length:21},(_,index)=>record(`story-${index}`,'Project example',`Archived project ${index}.`));
  const matcher=createSemanticMatcher({traceImpl:()=>{},fetchImpl:async(_url,options)=>{
    const body=JSON.parse(options.body);
    const answers=Object.fromEntries(Object.entries(body.questions).map(([id,question])=>[id,{
      type:'score',score:1,confidence:1,probabilities:{0:0,1:1,2:0,3:0},
      legend:{0:question.criteria[0],1:question.criteria[1],2:question.criteria[2],3:question.criteria[3]},
    }]));
    return jsonResponse({answers});
  }});
  assert.deepEqual(await matcher.rankNarrative({field:field('story','Describe a production project'),records,apiKey:'ts_test'}),[]);
});

test('local narrative ordering retains the full eligible pool after lexical matches', () => {
  const target=field('response','Describe a production project');
  const records=Array.from({length:21},(_,index)=>record(`archive-${index}`,
    index===0?'Describe a production project':`Archived example ${index}`,
    `Built and shipped a production system ${index}.`));
  const ranked=rankSuggestionEvidence(target,records,{limit:records.length});
  assert.equal(ranked.length,records.length);
  assert.equal(ranked[0].key,'archive-0');
});

test('narrative ranking never sends a request above the local byte limit', async () => {
  const records=[record('oversized','Project example','x'.repeat(30_000)),
    ...Array.from({length:20},(_,index)=>record(`story-${index}`,'Project example',`Built production system ${index}.`))];
  let calls=0;
  const traces=[];
  const matcher=createSemanticMatcher({traceImpl:(name,attributes)=>traces.push({name,attributes}),fetchImpl:async()=>{
    calls+=1;
    throw new Error('Oversized request should not be sent');
  }});
  assert.deepEqual(await matcher.rankNarrative({field:field('story','Describe a production project'),records,apiKey:'ts_test'}),[]);
  assert.equal(calls,0);
  assert.equal(traces[0].attributes['typesafe.question_count'],0);
  assert.equal(traces[0].attributes['typesafe.omitted'],records.length);
});

test('local narrative ordering preserves a relevant late record through request trimming', async () => {
  const records=Array.from({length:21},(_,index)=>record(`archive-${index}`,
    `Archived project ${index}`,
    `${index===20?'RELEVANT_LATE_RECORD':`Archived evidence ${index}`} ${'detail '.repeat(300)}`,
    index===20?{aliases:['quuxmarker']}:{}));
  const target={...field('response','Explain your approach'),helpText:'quuxmarker'};
  const shortlist=rankSuggestionEvidence(target,records,{limit:records.length});
  assert.equal(shortlist[0].key,'archive-20');
  let request;
  const matcher=createSemanticMatcher({traceImpl:()=>{},fetchImpl:async(_url,options)=>{
    request=JSON.parse(options.body);
    return jsonResponse({answers:answersFor(request)});
  }});
  await matcher.rankNarrative({field:target,records:shortlist,apiKey:'ts_test'});
  assert.ok(request.state.records.length<records.length);
  assert.ok(new TextEncoder().encode(JSON.stringify(request)).length<=24_000);
  assert.match(request.state.records[0].answer,/RELEVANT_LATE_RECORD/);
});
