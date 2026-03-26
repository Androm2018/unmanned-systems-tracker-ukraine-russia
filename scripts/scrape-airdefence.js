const { google } = require('googleapis');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── CONFIG ────────────────────────────────────────────────
const SHEET_ID    = process.env.SPREADSHEET_ID;
const TAB_NAME    = 'AirDefence';
const KAGGLE_USER = process.env.KAGGLE_USERNAME;
const KAGGLE_KEY  = process.env.KAGGLE_KEY;
const DATASET     = 'piterfm/massive-missile-attacks-on-ukraine';
const CSV_FILE    = 'missile_attacks_daily.csv';

const HEADERS = ['date','time_start','time_end','model','launched','destroyed','not_reach_goal','notes'];

// ── PARSE CSV ─────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g,''));
  return lines.slice(1).map(line => {
    // Handle quoted fields with commas inside
    const fields = [];
    let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { fields.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    fields.push(cur.trim());
    const obj = {};
    headers.forEach((h, i) => obj[h] = (fields[i] || '').replace(/^"|"$/g, ''));
    return obj;
  });
}

// ── MAIN ──────────────────────────────────────────────────
async function main() {
  console.log('Setting up Kaggle credentials...');

  // Write kaggle.json credentials
  const kaggleDir = path.join(process.env.HOME || '/root', '.kaggle');
  fs.mkdirSync(kaggleDir, { recursive: true });
  fs.writeFileSync(
    path.join(kaggleDir, 'kaggle.json'),
    JSON.stringify({ username: KAGGLE_USER, key: KAGGLE_KEY }),
    { mode: 0o600 }
  );

  console.log('Installing kaggle CLI...');
  execSync('pip install kaggle --quiet --break-system-packages', { stdio: 'inherit' });

  console.log(`Downloading dataset: ${DATASET}...`);
  const tmpDir = '/tmp/kaggle-airdef';
  fs.mkdirSync(tmpDir, { recursive: true });
  execSync(`kaggle datasets download -d ${DATASET} -p ${tmpDir} --unzip`, { stdio: 'inherit' });

  const csvPath = path.join(tmpDir, CSV_FILE);
  if (!fs.existsSync(csvPath)) {
    // List what was downloaded
    const files = fs.readdirSync(tmpDir);
    console.error('Expected file not found. Downloaded files:', files);
    process.exit(1);
  }

  console.log('Parsing CSV...');
  const raw = parseCSV(fs.readFileSync(csvPath, 'utf8'));
  console.log(`Parsed ${raw.length} records. First row:`, JSON.stringify(raw[0]));

  // Sort ascending by date
  raw.sort((a, b) => {
    const da = (a.time_start || a.date || '').slice(0,10);
    const db = (b.time_start || b.date || '').slice(0,10);
    return da.localeCompare(db);
  });

  // Build sheet rows
  const rows = raw.map(r => {
    const date     = (r.time_start || r.date || '').slice(0, 10);
    const launched = parseInt(r.launched)        || 0;
    const destroyed= parseInt(r.destroyed)       || 0;
    const notReach = parseInt(r.not_reach_goal)  || 0;

    const notesParts = [];
    if (r.strike_target)    notesParts.push(`Target: ${r.strike_target}`);
    if (r.still_fly)        notesParts.push(`Still flying: ${r.still_fly}`);
    if (r.carrier)          notesParts.push(`Carrier: ${r.carrier}`);

    return [
      date,
      r.time_start  || '',
      r.time_end    || '',
      r.model       || r.type || '',
      launched,
      destroyed,
      notReach,
      notesParts.join(' · '),
    ];
  });

  console.log(`Prepared ${rows.length} rows`);

  // ── Authenticate Google Sheets ────────────────────────────
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Ensure tab exists
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const existing = meta.data.sheets.map(s => s.properties.title);
  if (!existing.includes(TAB_NAME)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB_NAME } } }] }
    });
    console.log(`Created tab: ${TAB_NAME}`);
  }

  // Clear and rewrite
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${TAB_NAME}!A:Z` });

  // Write in batches of 1000 to avoid payload limits
  const allRows = [HEADERS, ...rows];
  const BATCH = 1000;
  for (let i = 0; i < allRows.length; i += BATCH) {
    const batch = allRows.slice(i, i + BATCH);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${TAB_NAME}!A${i + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: batch },
    });
    console.log(`Written rows ${i + 1}–${Math.min(i + BATCH, allRows.length)}`);
  }

  console.log(`✓ Done — ${rows.length} rows written to ${TAB_NAME}`);
}

main().catch(err => {
  console.error('Scraper failed:', err.message);
  process.exit(1);
});
