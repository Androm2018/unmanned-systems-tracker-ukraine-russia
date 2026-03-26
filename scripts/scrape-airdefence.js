const { google } = require('googleapis');
const https = require('https');

// ── CONFIG ────────────────────────────────────────────────
const SHEET_ID   = process.env.SPREADSHEET_ID;
const TAB_NAME   = 'AirDefence';
const DATA_URL   = 'https://raw.githubusercontent.com/PetroIvaniuk/2022-Ukraine-Russia-War-Dataset/main/data/ukraine_missile_attacks.json';

// Column order for the sheet
const HEADERS = ['date', 'time_start', 'time_end', 'model', 'launched', 'destroyed', 'not_reach_goal', 'notes'];

// ── FETCH JSON from GitHub ─────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'UnmannedSystemsTracker/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

// ── MAIN ──────────────────────────────────────────────────
async function main() {
  console.log('Fetching Petro Ivaniuk air defence dataset...');

  // Fetch raw data
  const raw = await fetchJSON(DATA_URL);
  console.log(`Fetched ${Array.isArray(raw) ? raw.length : 'unknown'} records`);

  // Normalise — the dataset can be an array of objects or wrapped
  let records = Array.isArray(raw) ? raw : (raw.data || raw.attacks || []);

  if (!records.length) {
    console.error('No records found in dataset');
    process.exit(1);
  }

  // Sort by date ascending
  records.sort((a, b) => {
    const da = a.time_start || a.date || '';
    const db = b.time_start || b.date || '';
    return da.localeCompare(db);
  });

  // Build rows for the sheet
  const rows = records.map(r => {
    // Date: extract YYYY-MM-DD from time_start or date field
    const rawDate = r.time_start || r.date || '';
    const date = rawDate.slice(0, 10);

    const launched   = parseInt(r.launched)   || 0;
    const destroyed  = parseInt(r.destroyed)  || parseInt(r.interceptions) || 0;
    const notReach   = parseInt(r.not_reach_goal) || 0;

    // Build a notes string from any interesting fields
    const notesParts = [];
    if (r.still_fly !== undefined) notesParts.push(`Still in flight: ${r.still_fly}`);
    if (r.strike_target) notesParts.push(`Target: ${r.strike_target}`);
    const notes = notesParts.join(' · ');

    return [
      date,
      r.time_start || '',
      r.time_end   || '',
      r.model || r.type || r.weapon || '',
      launched,
      destroyed,
      notReach,
      notes,
    ];
  });

  console.log(`Prepared ${rows.length} rows for sheet`);

  // ── Authenticate with Google Sheets ──────────────────────
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // ── Clear and rewrite the AirDefence tab ─────────────────
  // First ensure the tab exists
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const existing = meta.data.sheets.map(s => s.properties.title);

  if (!existing.includes(TAB_NAME)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: TAB_NAME } } }]
      }
    });
    console.log(`Created sheet tab: ${TAB_NAME}`);
  }

  // Clear existing data
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!A:Z`,
  });

  // Write header + all rows
  const allRows = [HEADERS, ...rows];
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: allRows },
  });

  console.log(`✓ Written ${rows.length} rows to ${TAB_NAME} tab`);
}

main().catch(err => {
  console.error('Scraper failed:', err.message);
  process.exit(1);
});
