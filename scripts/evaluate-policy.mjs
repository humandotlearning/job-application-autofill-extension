import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { collectFieldDescriptors, planDeterministicFill, applyDecisions, waitForDocumentSettled } from '../src/form-engine.js';
import { normalizeAnswerRecord, suggestionTargetKey } from '../src/core.js';
const cases=JSON.parse(fs.readFileSync(new URL('../tests/fixtures/policy-evaluation.json',import.meta.url)));
const baseline=JSON.parse(fs.readFileSync(new URL('../tests/fixtures/policy-baseline.json',import.meta.url)));
const metric=()=>({count:0,detected:0,sourceCorrect:0,answerCorrect:0,dispositionCorrect:0,automatic:0,correctAutomatic:0,reviewExpected:0,correctReview:0});
const all=metric(),comparable=metric();
for(const [index,item] of cases.entries()){
 const dom=new JSDOM('<form></form>'); const document=dom.window.document;
 const label=document.createElement('label');label.textContent=item.label;
 const control=document.createElement(item.type==='textarea'?'textarea':'input'); control.id='target';if(item.type!=='textarea')control.type=item.type;
 label.append(control);document.querySelector('form').append(label);
 const fields=collectFieldDescriptors(document);
 const record=item.answer?normalizeAnswerRecord({key:'source',question:item.sourceQuestion||item.label,answer:item.answer,confirmationState:item.confirmationState||(item.confirmed?'confirmed':undefined),semantic:{reusePolicy:item.reusePolicy},employmentId:item.employmentId}):null;
 if(item.suppressed)record.suppressedFor=[suggestionTargetKey(fields[0])];
 const records=record?[record]:[];if(item.conflict)records.push({...record,key:'conflict',answer:item.conflict});
 const decision=planDeterministicFill(fields,records)[0]||{};
 const expectedSource=item.expectedSource??Boolean(item.answer&&item.reusePolicy!=='never');
 for(const result of index<baseline.count?[all,comparable]:[all]){
  result.count++; result.detected+=fields.length===1&&fields[0].label===item.label;
  result.sourceCorrect+=Boolean(decision.evidenceKeys?.includes(record?.key))===expectedSource;
  result.answerCorrect+=expectedSource?decision.value===item.answer:decision.value==null;
  result.dispositionCorrect+=decision.disposition===item.expected;
  if(decision.disposition==='autofill'){result.automatic++;result.correctAutomatic+=item.expected==='autofill'&&decision.value===item.answer;}
  if(item.expected==='review'){result.reviewExpected++;result.correctReview+=decision.disposition==='review'&&decision.value===item.answer;}
 }
 dom.window.close();
}
const ats={snapshots:0,correctSnapshots:0,expectedFields:0,detectedFields:0,unexpectedFields:0};
for(const [name,expected] of Object.entries({lever:['Full name','Email','GitHub URL','LinkedIn URL','Skills'],workday:['First name','Company','Job title','Company','Job title','Have you previously worked here?'],ashby:['Location','Languages']})){
 const dom=new JSDOM(fs.readFileSync(new URL(`../tests/fixtures/${name}.html`,import.meta.url),'utf8'));
 const check=(labels)=>{const actual=collectFieldDescriptors(dom.window.document).map(f=>f.label);ats.snapshots++;ats.expectedFields+=labels.length;const pool=[...actual];let matched=0;for(const label of labels){const i=pool.indexOf(label);if(i>=0){matched++;pool.splice(i,1);}}ats.detectedFields+=matched;ats.unexpectedFields+=pool.length;ats.correctSnapshots+=matched===labels.length&&pool.length===0;};
 check(expected);
 if(name==='workday'){
  setTimeout(()=>{dom.window.document.querySelector('form').innerHTML='<fieldset><legend>Education</legend><label>School<input id="school"></label></fieldset>';},30);
  await waitForDocumentSettled(dom.window.document,{quietMs:40,minWaitMs:80,timeoutMs:400});check(['School']);
 }
 dom.window.close();
}
const retention={cases:0,correct:0};
for(const changed of [false,true]){
 const dom=new JSDOM('<form><label>Email<input type="email" id="email"></label></form>');const document=dom.window.document;
 if(changed)document.querySelector('input').addEventListener('input',()=>setTimeout(()=>{document.querySelector('input').value='different@example.test';},50));
 const result=await applyDecisions(document,planDeterministicFill(collectFieldDescriptors(document),[{key:'email',question:'Email',answer:'candidate@example.test',sensitivity:'safe',confirmationState:'confirmed'}]));
 retention.cases++;retention.correct+=changed?result.failed.length===1&&result.applied.length===0:result.applied.length===1;
 dom.window.close();
}
const report={corpus:'synthetic-regression-v2',representative:false,baseline,comparableCurrent:comparable,expandedCurrent:all,atsDetection:ats,retention,note:'Small synthetic regression checks; no estimate of real-world >99% accuracy. Expanded cases and detection have no pre-change baseline. No applicant values or field labels are logged.'};
console.log(JSON.stringify(report,null,2));
if(process.argv.includes('--save'))fs.writeFileSync(new URL('../tests/fixtures/policy-current-metrics.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
