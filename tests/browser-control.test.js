import test from 'node:test';
import assert from 'node:assert/strict';

import { accessibilityControls, createBrowserController, mergeAccessibilityInspection } from '../src/browser-control.js';

test('normalizes the browser accessibility tree and joins unambiguous labels', () => {
  const controls = accessibilityControls([{nodeId: '7', role: {value: 'combobox'}, name: {value: 'Country'}, properties: [
    {name: 'required', value: {value: true}}, {name: 'expanded', value: {value: false}},
  ]}]);
  assert.deepEqual(controls, [{id: '7', role: 'combobox', name: 'Country', value: '', required: true, expanded: false, disabled: false}]);
  const inspection = mergeAccessibilityInspection({fields: [{id: 'country', label: 'Country'}]}, controls);
  assert.equal(inspection.fields[0].accessibility.role, 'combobox');
});

test('browser controller detaches after an observation and a trusted click', async () => {
  const calls = [];
  const browser = {debugger: {
    attach: async (...args) => calls.push(['attach', ...args]),
    detach: async (...args) => calls.push(['detach', ...args]),
    sendCommand: async (...args) => {
      calls.push(['command', ...args]);
      return args[1] === 'Accessibility.getFullAXTree' ? {nodes: []} : {};
    },
  }};
  const controller = createBrowserController(browser);
  assert.deepEqual(await controller.observe(5), {ok: true, controls: []});
  assert.deepEqual(await controller.click(5, {x: 10, y: 20, width: 30, height: 40}), {ok: true});
  assert.equal(calls.filter(call => call[0] === 'attach').length, 2);
  assert.equal(calls.filter(call => call[0] === 'detach').length, 2);
  assert.equal(calls.filter(call => call[2] === 'Input.dispatchMouseEvent').length, 2);
});

test('browser controller includes accessibility controls from flat child-frame sessions', async () => {
  const listeners = [];
  const browser = {debugger: {
    onEvent: {addListener: listener => listeners.push(listener)},
    onDetach: {addListener: () => {}},
    attach: async () => {}, detach: async () => {},
    sendCommand: async (session, method) => {
      if (method === 'Target.setAutoAttach' && !session.sessionId) {
        queueMicrotask(() => listeners.forEach(listener => listener({tabId: 5}, 'Target.attachedToTarget', {sessionId: 'child-frame'})));
      }
      if (method === 'Accessibility.getFullAXTree') {
        return {nodes: [{nodeId: session.sessionId ? 'child' : 'root', role: {value: 'textbox'}, name: {value: session.sessionId ? 'Experience' : 'Name'}}]};
      }
      return {};
    },
  }};
  const observed = await createBrowserController(browser).observe(5);
  assert.equal(observed.ok, true);
  assert.deepEqual(observed.controls.map(control => control.name).sort(), ['Experience', 'Name']);
  assert.equal(observed.controls.find(control => control.name === 'Experience').sessionId, 'child-frame');
});

test('browser controller fails closed when debugger access is unavailable', async () => {
  const controller = createBrowserController({});
  assert.equal((await controller.observe(5)).ok, false);
  assert.deepEqual(await controller.click(5, {x: 0, y: 0, width: 1, height: 1}), {ok: false, code: 'browser_control_unavailable', error: 'Browser control is unavailable'});
});
