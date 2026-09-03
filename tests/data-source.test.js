import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchGoogleSheetRecords, fetchPrivateGoogleSheetRecords, parseGoogleSheetUrl } from '../src/data-source.js';

const SHEET = 'https://docs.google.com/spreadsheets/d/1SoKWd8RL1YpZxP3Bvs5bclF_fhs47VZpk1wh6H6UBJ0/edit?gid=0#gid=0';

test('downloads and converts Google Sheet CSV data', async () => {
  const calls = [];
  const records = await fetchGoogleSheetRecords(SHEET, async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      url,
      headers: { get: () => 'text/csv' },
      text: async () => 'Field,Value,Status\nEmail Address,person@example.com,verified',
    };
  });

  assert.equal(records[0].key, 'email_address');
  assert.match(calls[0].url, /gviz\/tq\?tqx=out%3Acsv&gid=0$/);
  assert.equal(calls[0].options.credentials, 'include');
});

test('explains when a private sheet cannot be exported', async () => {
  await assert.rejects(
    fetchGoogleSheetRecords(SHEET, async () => ({
      ok: true,
      url: 'https://accounts.google.com/signin',
      headers: { get: () => 'text/html' },
      text: async () => '<!doctype html><title>Sign in</title>',
    })),
    /private|access|sign-in/i,
  );
});

test('rejects a sheet without reusable answers', async () => {
  await assert.rejects(
    fetchGoogleSheetRecords(SHEET, async (url) => ({
      ok: true,
      url,
      headers: { get: () => 'text/csv' },
      text: async () => 'Field,Value\n,',
    })),
    /no reusable answers/i,
  );
});

test('parses spreadsheet id and gid from the supplied URL', () => {
  assert.deepEqual(parseGoogleSheetUrl(SHEET), {
    spreadsheetId: '1SoKWd8RL1YpZxP3Bvs5bclF_fhs47VZpk1wh6H6UBJ0',
    gid: 0,
  });
});

test('reads and combines all private workbook tabs through the authenticated Sheets API', async () => {
  const urls = [];
  const records = await fetchPrivateGoogleSheetRecords(
    SHEET,
    async () => 'oauth-token',
    async (url, options) => {
      urls.push({ url, options });
      if (url.includes('fields=sheets.properties')) {
        return {
          ok: true,
          json: async () => ({ sheets: [
            { properties: { sheetId: 0, title: 'Sheet1' } },
            { properties: { sheetId: 123, title: 'common questions' } },
            { properties: { sheetId: 456, title: 'email' } },
          ] }),
        };
      }
      return {
        ok: true,
        json: async () => ({ valueRanges: [
          { range: 'Sheet1!A1:Z2', values: [['LinkedIn:', 'https://linkedin.example/me']] },
          { range: "'common questions'!A1:Z2", values: [['Questions', 'Answers'], ['Why this role?', 'To build useful AI.']] },
          { range: 'email!A1:Z2', values: [[''], ['', 'Unstructured email body']] },
        ] }),
      };
    },
  );

  assert.deepEqual(records.map((record) => record.key), ['linkedin', 'why_this_role', 'email_template']);
  assert.equal(records.find((record) => record.key === 'email_template').status, 'draft');
  assert.equal(urls[0].options.headers.Authorization, 'Bearer oauth-token');
  assert.match(urls[1].url, /values:batchGet/);
  assert.match(urls[1].url, /common%2Bquestions|common\+questions|common%20questions/);
});
