import test from 'node:test';
import assert from 'node:assert/strict';
import { createSemanticMatcher, TYPESAFE_MODEL } from '../src/typesafe.js';
import { selectSemanticEvidence, semanticEligible } from '../src/retrieval.js';

const field = (id, label) => ({id,handle:`h-${id}`,label,labelConfidence:'high',type:'textarea',currentValue:'',rawValue:'',constraints:{}});
const record = (key, question, answer, extra = {}) => ({key,question,answer,confirmationState:'confirmed',sensitivity:'safe',...extra});
const jsonResponse = value => ({ok:true,status:200,json:async()=>value});

test('batches parallel field questions into one request and deduplicates shared state', async () => {
  const calls=[], traces=[];
  const matcher=createSemanticMatcher({fetchImpl:async(url,options)=>{
    calls.push({url,body:JSON.parse(options.body)});
    return jsonResponse({answers:{
      f0:{type:'choice',choice:'r0',confidence:0.94,probabilities:{none:0.03,r0:0.94,r1:0.03}},
      f1:{type:'choice',choice:'none',confidence:0.91,probabilities:{none:0.91,r0:0.04,r1:0.05}},
    }});
  },traceImpl:(name,attributes)=>traces.push({name,attributes})});
  const records=[
    record('reliability','Engineering achievement','Reduced production outages with health checks and automated rollback.'),
    record('leadership','Leadership example','Led a team through a difficult migration.'),
  ];
  const fields=[field('reliability-field','Describe a time you improved service reliability'),field('motivation','Why this company?')];
  const result=await matcher.match({fields,records,apiKey:'ts_test',scope:'page-1'});
  assert.equal(calls.length,1);
  assert.equal(calls[0].body.model,TYPESAFE_MODEL);
  assert.deepEqual(Object.keys(calls[0].body.questions),['f0','f1']);
  assert.equal(calls[0].body.state.records.length,2);
  assert.equal(result[0].status,'matched');
  assert.equal(result[0].candidate.answer,records[0].answer);
  assert.equal(result[1].status,'none');
  assert.equal(traces[0].name,'saved_answer_match_result');
  assert.equal(traces[0].attributes['typesafe.request_count'],1);
  assert.equal(traces[0].attributes['typesafe.matched'],1);
  assert.equal(traces[0].attributes['typesafe.no_match'],1);
  assert.equal(traces[0].attributes['typesafe.cache_hits'],0);
});

test('same-label fields keep separate choices and bounded disambiguating context', async () => {
  let request;
  const matcher=createSemanticMatcher({traceImpl:()=>{},fetchImpl:async(_url,options)=>{
    request=JSON.parse(options.body);
    return jsonResponse({answers:{
      f0:{type:'choice',choice:'none',confidence:1,probabilities:{none:1,r0:0}},
      f1:{type:'choice',choice:'none',confidence:1,probabilities:{none:1,r0:0}},
    }});
  }});
  const fields=[field('first','Additional information'),field('second','Additional information')];
  fields[0].helpText='Explain the first project.';
  fields[1].nearbyContext='Second project section';
  await matcher.match({fields,records:[record('saved','Project details','Built a reliable service.')],apiKey:'ts_test'});
  assert.deepEqual(Object.keys(request.questions),['f0','f1']);
  assert.equal(request.state.fields.f0.helpText,'Explain the first project.');
  assert.equal(request.state.fields.f1.nearbyContext,'Second project section');
});

test('reuses unchanged results and coalesces concurrent identical searches', async () => {
  let calls=0,release;
  const matcher=createSemanticMatcher({fetchImpl:async()=>{
    calls+=1;
    await new Promise(resolve=>{release=resolve;});
    return jsonResponse({answers:{f0:{type:'choice',choice:'none',confidence:0.9,probabilities:{none:0.9,r0:0.1}}}});
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
  const matcher=createSemanticMatcher({fetchImpl:async()=>{
    calls+=1;
    if(calls===1) throw new Error('offline');
    return jsonResponse({answers:{f0:{type:'choice',choice:'none',confidence:1,probabilities:{none:1,r0:0}}}});
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
    const matcher=createSemanticMatcher({fetchImpl:async()=>jsonResponse({answers:{f0:answer}})});
    const result=await matcher.match({fields:[field('one','Reliability')],records:[record('saved','Achievement','Improved reliability')],apiKey:'ts_test'});
    assert.notEqual(result[0].status,'matched');
  }
});

test('maps a confirmed fact to an exact visible option for one-time review', async () => {
  let request;
  const matcher=createSemanticMatcher({traceImpl:()=>{},fetchImpl:async(_url,options)=>{
    request=JSON.parse(options.body);
    return jsonResponse({answers:{f0:{type:'choice',choice:'o1',confidence:0.93,probabilities:{none:0.02,o0:0.05,o1:0.93}}}});
  }});
  const choice={id:'authorization',handle:'h-auth',label:'Are you authorized to work?',labelConfidence:'high',type:'radio',currentValue:'',rawValue:'',options:['No, sponsorship required','Yes, authorized to work'],constraints:{}};
  const records=[record('authorization','Work authorization','Authorized to work')];
  const [result]=await matcher.match({fields:[choice],records,apiKey:'ts_test'});
  assert.equal(request.questions.f0.criteria.o1,'Select the exact enabled visible option label: Yes, authorized to work');
  assert.equal(result.status,'matched');
  assert.equal(result.candidate.kind,'semantic_option');
  assert.equal(result.candidate.answer,'Yes, authorized to work');
});
