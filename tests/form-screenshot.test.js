import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareFormScreenshot} from '../src/form-screenshot.js';

function dependencies({blobSize = 20} = {}) {
  const calls = [];
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() { return {
      set fillStyle(value) { calls.push(['color', value]); },
      fillRect: (...args) => calls.push(['fill', ...args]),
      drawImage: (...args) => calls.push(['draw', ...args.slice(1)]),
    }; }
    async convertToBlob() { return new Blob([new Uint8Array(blobSize)], {type: 'image/jpeg'}); }
  }
  return {calls, options: {
    fetchImpl: async () => ({ok: true, blob: async () => new Blob(['source'], {type: 'image/png'})}),
    createImageBitmapImpl: async () => ({width: 1000, height: 800, close() { calls.push(['close']); }}),
    OffscreenCanvasImpl: Canvas,
  }};
}

test('returns null rather than sending an unbounded screenshot', async () => {
  const {options} = dependencies();
  assert.equal(await prepareFormScreenshot({dataUrl: 'data:image/png;base64,AA==', viewport: {width: 1000, height: 800}}, options), null);
});

test('crops to visible form regions and masks editable controls', async () => {
  const {calls, options} = dependencies();
  const result = await prepareFormScreenshot({
    dataUrl: 'data:image/png;base64,AA==', viewport: {width: 1000, height: 800},
    regions: [{rect: {x: 100, y: 50, width: 400, height: 500}}],
    redactions: [{x: 140, y: 120, width: 200, height: 30}],
  }, options);
  assert.match(result.dataUrl, /^data:image\/jpeg;base64,/);
  assert.deepEqual([result.width, result.height], [400, 500]);
  assert.ok(calls.some(call => call[0] === 'draw'));
  assert.ok(calls.some(call => call[0] === 'fill' && call.slice(1).join(',') === '40,70,200,30'));
  assert.deepEqual(calls.at(-1), ['close']);
});
