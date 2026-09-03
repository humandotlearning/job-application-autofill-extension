import { buildGoogleSheetCsvUrl, parseCsv, rowsToRecords } from './core.js';

export function parseGoogleSheetUrl(input) {
  const url = new URL(String(input).trim());
  const idMatch = url.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
  if (!idMatch) throw new Error('Enter a valid Google Sheets URL.');
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
  const rawGid = url.searchParams.get('gid') || fragment.get('gid') || '0';
  const gid = Number(rawGid);
  if (!Number.isInteger(gid) || gid < 0) throw new Error('The Google Sheet URL has an invalid gid.');
  return { spreadsheetId: idMatch[1], gid };
}

export async function fetchGoogleSheetRecords(sheetUrl, fetchImpl = fetch) {
  const csvUrl = new URL(buildGoogleSheetCsvUrl(sheetUrl));
  csvUrl.searchParams.set('tqx', 'out:csv');
  const response = await fetchImpl(csvUrl.toString(), {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`Google Sheets returned HTTP ${response.status}. Check that the sheet is accessible.`);
  }

  const text = await response.text();
  const contentType = response.headers?.get?.('content-type') || '';
  const redirectedToLogin = /accounts\.google\.com|ServiceLogin/i.test(response.url || '');
  const looksLikeHtml = /text\/html/i.test(contentType) || /^\s*<!doctype html|^\s*<html/i.test(text);
  if (redirectedToLogin || looksLikeHtml) {
    throw new Error('This appears to be a private Google Sheet and the CSV export needs sign-in access. Use local CSV import for now or configure authenticated Google Sheets access.');
  }

  const records = rowsToRecords(parseCsv(text), 'google-sheet');
  if (records.length === 0) {
    throw new Error('The sheet contains no reusable answers. Add Field/Question and Value/Answer columns.');
  }
  return records;
}

async function readJson(response, context) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${context} returned an unreadable response.`);
  }
  if (!response.ok) {
    const detail = body?.error?.message || `HTTP ${response.status}`;
    throw new Error(`${context} failed: ${detail}`);
  }
  return body;
}

export async function fetchPrivateGoogleSheetRecords(sheetUrl, getToken, fetchImpl = fetch) {
  const { spreadsheetId } = parseGoogleSheetUrl(sheetUrl);
  const token = await getToken();
  if (!token) throw new Error('Google authorization did not return an access token.');
  const options = {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  };

  const metadataUrl = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`);
  metadataUrl.searchParams.set('fields', 'sheets.properties(sheetId,title)');
  const metadata = await readJson(await fetchImpl(metadataUrl.toString(), options), 'Google Sheets metadata');
  const sheets = (metadata.sheets || []).filter((entry) => entry.properties?.title);
  if (!sheets.length) throw new Error('The spreadsheet has no readable tabs.');

  const valuesUrl = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet`);
  for (const sheet of sheets) {
    const title = sheet.properties.title.replace(/'/g, "''");
    valuesUrl.searchParams.append('ranges', `'${title}'!A:Z`);
  }
  const values = await readJson(await fetchImpl(valuesUrl.toString(), options), 'Google Sheets values');
  const combined = [];
  for (let index = 0; index < (values.valueRanges || []).length; index += 1) {
    const rows = values.valueRanges[index]?.values || [];
    const title = sheets[index]?.properties?.title || `tab-${index + 1}`;
    try {
      combined.push(...rowsToRecords(rows, `google-sheet-oauth:${title}`));
    } catch {
      // Unstructured tabs such as email drafts are intentionally ignored.
    }
  }
  const records = [...new Map(combined.map((record) => [record.key, record])).values()];
  if (!records.length) {
    throw new Error('The workbook contains no reusable answers. Add Field/Question and Value/Answer columns or two-column key/value rows.');
  }
  return records;
}
