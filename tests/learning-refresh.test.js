import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createLearningSession} from '../src/learning.js';
test('debounced revalidation runs for cleared controls without learning or navigation',async()=>{
 const dom=new JSDOM('<form><input aria-label="Email"></form>');let validations=0;const sent=[];
 const session=createLearningSession(dom.window.document,{capture:()=>[],send:async m=>{sent.push(m);return{ok:true};},onRevalidate:()=>validations++,validationDelayMs:20});
 const input=dom.window.document.querySelector('input');
 input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,30));assert.equal(validations,0);
 session.activate('run');input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));input.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
 await new Promise(r=>setTimeout(r,40));assert.equal(validations,1);assert.equal(sent.length,0);
 session.dispose();input.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await new Promise(r=>setTimeout(r,30));assert.equal(validations,1);dom.window.close();
});
