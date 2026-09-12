import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hostnameFromUrl,
  isHostnameDisabled,
  isSupportedSiteUrl,
  normalizeHostname,
  normalizeHostnames,
} from '../src/site-control.js';

test('site rules normalize to exact lowercase hostnames and ignore URL paths and ports', () => {
  assert.equal(normalizeHostname(' HTTPS://Jobs.Example.com:8443/apply?step=1 '), 'jobs.example.com');
  assert.equal(hostnameFromUrl('https://Jobs.Example.com/apply'), 'jobs.example.com');
  assert.deepEqual(normalizeHostnames(['Jobs.Example.com', 'https://jobs.example.com/other', 'Other.Example.com.']), ['jobs.example.com', 'other.example.com']);
  assert.equal(isSupportedSiteUrl('chrome://settings'), false);
  assert.equal(isSupportedSiteUrl('https://jobs.example.com/apply'), true);
});

test('site rules match only the exact hostname, not a parent or sibling subdomain', () => {
  const disabled = ['jobs.example.com'];
  assert.equal(isHostnameDisabled('JOBS.EXAMPLE.COM', disabled), true);
  assert.equal(isHostnameDisabled('example.com', disabled), false);
  assert.equal(isHostnameDisabled('other.example.com', disabled), false);
});
