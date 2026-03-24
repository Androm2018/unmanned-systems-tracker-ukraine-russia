/**
 * USF Pidrakhuyka Kill Board Scraper — PRODUCTION v3
 * ---------------------------------------------------
 * Navigates directly to the USF grouping page and extracts
 * daily kill statistics by reading spans in document order.
 */

const { chromium } = require('@playwright/test');
const { google }   = require('googleapis');

const DATA_URL       = 'https://sbs-group.army/en/subdivision/usf_grouping';
const SOURCE_LABEL   = 'USF Pidrakhuyka';
const SHEET_TAB      = 'UAV';
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

const TARGET_CATEGORIES = [
  'Enemy personnel',
  'Drone launch positions',
  'Antennas',
  'SAMs, SPADs',
  'Radars (system)',
  'Radars (portable)',
  'EW (system)',
  'EW (car + portable)',
  'Enemy wings',
  'Shaheds and Gerberas',
  'Tanks',
  'APCs, IFVs, ACVs',
  'Guns, howitzers',
  'Self-propelled artillery',
  'Mortars',
  'MRLS',
  'Light, Heavy, Special-purpose vehicles',
  'Motorcycles and military buggies',
  'Ammo, fuel and equipment depots',
  'Strategic infrastructure',
  'Tactical infrastructure',
  'Shelters',
  'Dugouts',
  'Network equipment',
  'Cameras',
  'Enemy copter drones',
  'Enemy unmanned robotic complexes',
  'Other',
];

// ── GOOGLE SHEETS AUTH ────────────────────────────────────
async function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function ensureHeaders(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TAB}!A1:I1`,
  });
  const existing = (res.data.values || [])[0] || [];
  if (!existing.length || existing[0] !== 'date') {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TAB}!A1:I1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [['date', 'system', 'target', 'type', 'loc', 'outcome', 'notes', 'src', 'srcl']],
      },
    });
    console.log('Headers written.');
  }
}

async function getExistingKeys(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TAB}!A:C`,
  });
  const rows = res.data.values || [];
  return new Set(rows.slice(1).map(r => `${(r[0]||'').trim()}|${(r[2]||'').trim()}`));
}

async function appendRows(sheets, rows) {
  if (!rows.length) { console.log('No new rows to append.'); return; }
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TAB}!A:I`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });
  console.log(`Appended ${rows.length} new rows.`);
}

function convertDate(raw) {
  const parts = raw.trim().split('.');
  if (parts.length === 3) return `${parts[2]}-${parts[1]}-${parts[0]}`;
  return raw;
}

function categoriseTarget(category) {
  const c = category.toLowerCase();
  if (c.includes('personnel'))                                              return 'Personnel';
  if (c.includes('tank'))                                                   return 'Tank / AFV';
  if (c.includes('apc') || c.includes('ifv') || c.includes('acv'))         return 'Tank / AFV';
  if (c.includes('artillery') || c.includes('gun') || c.includes('howitzer')
    || c.includes('mortar') || c.includes('mrls'))                         return 'Artillery';
  if (c.includes('sam') || c.includes('spad') || c.includes('radar')
    || c.includes('ew'))                                                    return 'Air defence';
  if (c.includes('shahed') || c.includes('gerbera') || c.includes('wing')
    || c.includes('copter') || c.includes('drone') || c.includes('launch')) return 'Drone / Aircraft';
  if (c.includes('vehicle') || c.includes('motorcycle') || c.includes('buggy')) return 'Logistics';
  if (c.includes('depot') || c.includes('ammo') || c.includes('fuel'))     return 'Logistics';
  if (c.includes('shelter') || c.includes('dugout')
    || c.includes('infrastructure'))                                        return 'Fortification';
  if (c.includes('antenna') || c.includes('network') || c.includes('camera')) return 'Electronics';
  return 'Other';
}

// ── SCRAPE ────────────────────────────────────────────────
async function scrape() {
  console.log('Launching browser...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  try {
    console.log(`Navigating to: ${DATA_URL}`);
    await page.goto(DATA_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(4000);

    // Dismiss cookie banner
    const gotIt = page.locator('button:has-text("Got it")');
    if (await gotIt.isVisible().catch(() => false)) {
      await gotIt.click();
      await page.waitForTimeout(500);
    }

    // ── Extract date ──────────────────────────────────────
    const rawDate = await page.evaluate(() => {
      const els = [...document.querySelectorAll('p, span')];
      for (const el of els) {
        const t = (el.innerText || '').trim();
        if (/^\d{2}\.\d{2}\.\d{4}$/.test(t)) return t;
      }
      return null;
    });

    if (!rawDate) throw new Error('Could not find date on page');
    const date = convertDate(rawDate);
    console.log(`Date: ${rawDate} → ${date}`);

    // ── Extract data using sequential span reading ────────
    // Strategy: get ALL span innerText values in document order.
    // When we see a category label, the next two numeric spans
    // are damaged and destroyed counts.
    const extracted = await page.evaluate((categories) => {
      // Get all spans in document order with their text
      const allSpans = [...document.querySelectorAll('span')];
      const texts = allSpans.map(s => (s.innerText || '').trim());

      const results = {};

      for (let i = 0; i < texts.length; i++) {
        const text = texts[i];
        if (!categories.includes(text)) continue;

        // Found a category label — look ahead for the next two numbers
        let damaged   = 0;
        let destroyed = 0;
        let numsFound = 0;

        for (let j = i + 1; j < Math.min(i + 15, texts.length); j++) {
          const t = texts[j];
          if (/^\d+$/.test(t)) {
            if (numsFound === 0) damaged   = parseInt(t, 10);
            if (numsFound === 1) destroyed = parseInt(t, 10);
            numsFound++;
            if (numsFound >= 2) break;
          }
          // Stop if we hit another category label
          if (numsFound === 0 && categories.includes(t)) break;
        }

        results[text] = { damaged, destroyed };
      }

      return results;
    }, TARGET_CATEGORIES);

    // ── Log results ───────────────────────────────────────
    console.log('\nExtracted data:');
    let nonZero = 0;
    for (const [cat, vals] of Object.entries(extracted)) {
      if (vals.damaged > 0 || vals.destroyed > 0) {
        console.log(`  ✓ ${cat}: damaged=${vals.damaged} destroyed=${vals.destroyed}`);
        nonZero++;
      }
    }
    console.log(`  (${nonZero} categories with activity, ${Object.keys(extracted).length} total extracted)`);

    // ── Extract summary headline figures ─────────────────────
    const summary = await page.evaluate(() => {
      const allSpans = [...document.querySelectorAll('span')];
      const texts = allSpans.map(s => (s.innerText || '').trim());
      const result = { totalDamaged: 0, totalDestroyed: 0, personnel: 0, killed: 0, wounded: 0, strikeFlights: 0, reconFlights: 0 };
      for (let i = 0; i < texts.length; i++) {
        const t = texts[i];
        const next = (texts[i + 1] || '').toLowerCase();
        if (!/[0-9]/.test(t) || t !== String(parseInt(t,10))) continue;
        const n = parseInt(t, 10);
        if (next.includes('damaged targets'))   { result.totalDamaged   = n; continue; }
        if (next.includes('incl. destroyed') && result.totalDamaged > 0 && result.totalDestroyed === 0) { result.totalDestroyed = n; continue; }
        if (next.includes('enemy personnel'))   { result.personnel      = n; continue; }
        if (next.includes('killed'))            { result.killed         = n; continue; }
        if (next.includes('wounded'))           { result.wounded        = n; continue; }
        if (next.includes('strike flights'))    { result.strikeFlights  = n; continue; }
        if (next.includes('recon flights'))     { result.reconFlights   = n; continue; }
      }
      return result;
    });

    console.log(`Summary: ${summary.totalDamaged} damaged, ${summary.totalDestroyed} destroyed, ${summary.personnel} personnel (${summary.killed} KIA, ${summary.wounded} WIA)`);

    // ── Build sheet rows ──────────────────────────────────
    const rows = [];

    // Summary row
    if (summary.totalDamaged > 0 || summary.totalDestroyed > 0) {
      rows.push([
        date, 'FPV / UAV (USF)', 'TOTAL — All targets', 'Summary', 'Eastern Front',
        `${summary.totalDestroyed} destroyed, ${summary.totalDamaged} damaged`,
        `Daily total. Damaged: ${summary.totalDamaged}. Destroyed: ${summary.totalDestroyed}. Strike flights: ${summary.strikeFlights}. Recon flights: ${summary.reconFlights}.`,
        DATA_URL, SOURCE_LABEL,
      ]);
    }

    // Personnel summary row
    if (summary.personnel > 0) {
      rows.push([
        date, 'FPV / UAV (USF)', 'Enemy personnel (summary)', 'Personnel', 'Eastern Front',
        `${summary.killed} killed, ${summary.wounded} wounded (${summary.personnel} total hit)`,
        `Personnel hit: ${summary.personnel}. Killed: ${summary.killed}. Wounded: ${summary.wounded}.`,
        DATA_URL, SOURCE_LABEL,
      ]);
    }

    for (const category of TARGET_CATEGORIES) {
      const vals = extracted[category];
      if (!vals) continue;
      if (vals.damaged === 0 && vals.destroyed === 0) continue;

      const outcome = vals.destroyed > 0
        ? `${vals.destroyed} destroyed, ${vals.damaged} damaged`
        : `${vals.damaged} damaged`;

      rows.push([
        date, 'FPV / UAV (USF)', category, categoriseTarget(category),
        'Eastern Front', outcome,
        `Damaged: ${vals.damaged}. Destroyed: ${vals.destroyed}. Source: USF Pidrakhuyka daily report.`,
        DATA_URL, SOURCE_LABEL,
      ]);
    }

    await browser.close();
    return rows;

  } catch (err) {
    console.error('Scrape error:', err.message);
    await page.screenshot({ path: 'error.png' }).catch(() => {});
    await browser.close();
    throw err;
  }
}

// ── MAIN ──────────────────────────────────────────────────
async function main() {
  if (!SPREADSHEET_ID) throw new Error('SPREADSHEET_ID not set');
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');

  const rows = await scrape();
  console.log(`\nTotal rows to write: ${rows.length}`);

  const sheets = await getSheetsClient();
  await ensureHeaders(sheets);

  const existingKeys = await getExistingKeys(sheets);
  console.log(`Existing rows in sheet: ${existingKeys.size}`);

  const toAppend = rows.filter(r => !existingKeys.has(`${r[0]}|${r[2]}`));
  console.log(`New rows after dedup: ${toAppend.length}`);

  await appendRows(sheets, toAppend);
  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
