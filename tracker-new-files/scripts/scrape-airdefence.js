const { google } = require('googleapis');
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
    const files = fs.readdirSync(tmpDir);
    console.error('Expected file not found. Downloaded files:', files);
    process.exit(1);
  }

  console.log('Parsing CSV...');
  const raw = parseCSV(fs.readFileSync(csvPath, 'utf8'));
  console.log(`Parsed ${raw.length} records`);

  raw.sort((a, b) => {
    const da = (a.time_start || a.date || '').slice(0,10);
    const db = (b.time_start || b.date || '').slice(0,10);
    return da.localeCompare(db);
  });

  const blankLaunched = raw.filter(r => !parseFloat(r.launched || '')).length;
  if (blankLaunched > 0) console.log(`⚠ ${blankLaunched} rows had blank/zero launched value`);

  // Diagnostic: sum launched directly from raw CSV
  const rawSum = raw.reduce((s, r) => s + (parseFloat(r.launched) || 0), 0);
  console.log(`CSV launched sum: ${rawSum}`);

  // Log available column names from first row
  console.log(`CSV columns: ${Object.keys(raw[0]).join(', ')}`);

  // Log any rows where launched is non-numeric
  const nonNumeric = raw.filter(r => r.launched && isNaN(parseFloat(r.launched)));
  if (nonNumeric.length > 0) {
    console.log(`⚠ ${nonNumeric.length} rows with non-numeric launched value:`);
    nonNumeric.slice(0, 5).forEach(r => console.log(`  date=${r.date||r.time_start} launched="${r.launched}"`));
  }

  const rows = raw.map(r => {
    const date      = (r.time_start || r.date || '').slice(0, 10);
    // Try multiple possible column names for launched count
    const launchedRaw = r.launched || r.amount || r.total || r.count || '';
    const launched  = parseFloat(launchedRaw) || 0;
    const destroyed = parseFloat(r.destroyed || r.destroyed_details || '') || 0;
    const notReach  = parseFloat(r.not_reach_goal || r.not_reach || '') || 0;
    const notesParts = [];
    if (r.launch_place)    notesParts.push(`Launch: ${r.launch_place}`);
    if (r.still_attacking) notesParts.push(`Still attacking: ${r.still_attacking}`);
    return [
      date,
      r.time_start || '',
      r.time_end   || '',
      r.model      || '',
      launched,
      destroyed,
      notReach,
      notesParts.join(' · '),
    ];
  });

  const allRows = [HEADERS, ...rows];
  const totalRows = allRows.length;
  console.log(`Prepared ${rows.length} rows (${totalRows} including header)`);

  // ── Auth ──────────────────────────────────────────────────
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // ── Ensure tab exists and has enough rows ─────────────────
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheetMeta = meta.data.sheets.find(s => s.properties.title === TAB_NAME);

  if (!sheetMeta) {
    // Create with enough rows
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{
          addSheet: {
            properties: {
              title: TAB_NAME,
              gridProperties: { rowCount: totalRows + 100, columnCount: 26 }
            }
          }
        }]
      }
    });
    console.log(`Created tab: ${TAB_NAME} with ${totalRows + 100} rows`);
  } else {
    // Expand existing tab if needed
    const currentRows = sheetMeta.properties.gridProperties.rowCount;
    const sheetId = sheetMeta.properties.sheetId;
    if (currentRows < totalRows + 10) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
          requests: [{
            updateSheetProperties: {
              properties: {
                sheetId,
                gridProperties: { rowCount: totalRows + 100, columnCount: 26 }
              },
              fields: 'gridProperties.rowCount,gridProperties.columnCount'
            }
          }]
        }
      });
      console.log(`Expanded tab to ${totalRows + 100} rows`);
    }
  }

  // ── Clear and write in batches of 1000 ────────────────────
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${TAB_NAME}!A:Z` });

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
