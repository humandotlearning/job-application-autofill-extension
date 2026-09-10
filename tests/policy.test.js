import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import * as core from '../src/core.js';
import * as retrieval from '../src/retrieval.js';
import { collectFieldDescriptors, planDeterministicFill, applyDecisions } from '../src/form-engine.js';
const email={key:'email',question:'Email',answer:'a@example.test',sensitivity:'safe',confirmationState:'confirmed'};
test('policy requires confirmed exact facts and keeps legal manual',()=>{
 assert.equal(typeof core.decideDisposition,'function');
 const d={value:email.answer,sensitivity:'safe',matchKind:'exact',confirmationState:'confirmed',confidence:'high'};
 const f={label:'Email',type:'email'};
 assert.equal(core.decideDisposition(d,f).disposition,'autofill');
 for(const change of [{confirmationState:undefined},{matchKind:'fuzzy'},{matchKind:'ai'},{reusePolicy:'review_only'}]) assert.equal(core.decideDisposition({...d,...change},f).disposition,'review');
 assert.equal(core.decideDisposition({...d,reusePolicy:'never',approved:true},f).disposition,'manual');
 assert.equal(core.decideDisposition({...d,approved:true},{label:'I agree to terms',type:'checkbox'}).disposition,'manual');
});
test('planner/executor protect legacy and invalid existing values',async()=>{
 const document=new JSDOM('<form><label>Email<input type="email" id="email"></label></form>').window.document;
 const fields=collectFieldDescriptors(document), decisions=planDeterministicFill(fields,[{...email,confirmationState:undefined}]);
 assert.equal(decisions[0].disposition,'review');
 assert.equal((await applyDecisions(document,decisions)).applied.length,0);
 document.querySelector('input').value='invalid';
 assert.equal((await applyDecisions(document,planDeterministicFill(fields,[email]))).kept.length,1);
 assert.equal((await applyDecisions(document,[{...decisions[0],approved:true}])).applied.length,1);
});
test('executor rejects a different valid retained value',async()=>{
 const document=new JSDOM('<form><label>Email<input type="email" id="email"></label></form>').window.document;
 document.querySelector('input').addEventListener('input',event=>{event.target.value='other@example.test';});
 const result=await applyDecisions(document,planDeterministicFill(collectFieldDescriptors(document),[email]));
 assert.equal(result.applied.length,0); assert.equal(result.failed.length,1);
});
test('unknown previous employer and legacy relationships stay manual',()=>{
 const fields=[{id:'prior',label:'Have you worked at Acme?',type:'text'},{id:'family',label:'Do you have a family member at Acme?',type:'text'}];
 const plan=planDeterministicFill(fields,[],[],{employment:[{company:'Other'}],defaults:{relatedToHiringCompany:'No'}},{company:'Acme'});
 assert.ok(plan.every(d=>d.disposition==='manual'&&d.value==null));
});
test('retrieval suppresses never reuse and duplicates and balances fields',()=>{
 const records=[{...email,semantic:{reusePolicy:'never'}},...Array.from({length:30},(_,i)=>({...email,key:'email_'+i})),{key:'city',question:'City',answer:'Pune',confirmationState:'confirmed'}];
 const evidence=retrieval.retrieveEvidence({label:'Email',type:'email'},records);
 assert.equal(evidence.length,1); assert.notEqual(evidence[0].sourceKey,'email');
 assert.equal(typeof retrieval.selectPlannerEvidence,'function');
 assert.ok(retrieval.selectPlannerEvidence([{label:'Email'},{label:'City'}],records,{limit:2}).some(r=>r.key==='city'));
});
test('executor verifies exact value after delayed framework normalization', async () => {
 const document=new JSDOM('<form><label>Email<input type="email" id="email"></label></form>').window.document;
 document.querySelector('input').addEventListener('input',event=>{setTimeout(()=>{event.target.value='delayed@example.test';},60);});
 const result=await applyDecisions(document,planDeterministicFill(collectFieldDescriptors(document),[email]));
 assert.equal(result.applied.length,0); assert.equal(result.failed.length,1);
});
test('retrieval offers compatible fuzzy short facts only as review evidence', () => {
 const records=[{key:'language',question:'Preferred programming language',answer:'Python',confirmationState:'confirmed',sensitivity:'safe'}];
 assert.equal(retrieval.retrieveEvidence({label:'Main programming language',type:'text'},records)[0]?.answer,'Python');
});
test('executor observes an exhausted deadline before any write',async()=>{
 const document=new JSDOM('<form><label>Email<input type="email" id="email"></label></form>').window.document;
 const result=await applyDecisions(document,planDeterministicFill(collectFieldDescriptors(document),[email]),{deadline:Date.now()-1});
 assert.equal(result.applied.length,0); assert.equal(document.querySelector('input').value,'');
});
test('custom option waits stop at the execution deadline',async()=>{
 const document=new JSDOM('<form><button type="button" role="combobox" id="city" aria-label="City" aria-controls="cities">Select</button><div role="listbox" id="cities"></div></form>').window.document;
 const started=Date.now();
 await applyDecisions(document,[{fieldId:'city',action:'fill',value:'Pune',approved:true}],{deadline:Date.now()+100});
 assert.ok(Date.now()-started<700);
});
test('stable source IDs do not hide explicit canonical question concepts',()=>{
 const record=core.normalizeAnswerRecord({key:'source_42',question:'GitHub URL',answer:'https://github.com/example',confirmationState:'confirmed'});
 const decision=planDeterministicFill([{id:'target',label:'GitHub URL',type:'url'}],[record])[0];
 assert.equal(decision.value,record.answer); assert.equal(decision.disposition,'autofill');
});
