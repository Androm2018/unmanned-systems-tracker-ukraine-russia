/**
 * USF Pidrakhuyka Kill Board — PERIOD SCRAPER
 * --------------------------------------------
 * Scrapes yearly/monthly period URLs directly instead of
 * trying to navigate day by day. Much more reliable.
 *
 * Periods available on the site:
 * - yearly_2025
 * - monthly: 2025_06, 2025_07, ... 2026_03 etc.
 *
 * Run once manually via GitHub Actions to backfill history.
 */

const { chromium } = require('@playwright/test');
const { google }   = require('googleapis');

const BASE_URL       = 'https://sbs-group.army/en/subdivision/usf_grouping';
const SOURCE_LABEL   = 'USF Pidrakhuyka';
const SHEET_TAB      = 'UAV';
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// Periods to scrape — add more as needed
// Format matches the site's URL parameter
const PERIODS = [
  // Full 2025 year
  { param: 'yearly_2025', label: '2025 (Full Year)' },
  // 2026 months scraped so far by daily scraper — skip these
  // Add monthly periods here if you want month-by-month breakdown too:
  // { param: 'monthly_2025_06', label: 'Jun 2025' },
  // { param: 'monthly_2025_07', label: 'Jul 2025' },
  // etc.
];

const TARGET_CATEGORIES = [
  'Enemy personnel','Drone launch positions','Antennas','SAMs, SPADs',
  'Radars (system)','Radars (portable)','EW (system)','EW (car + portable)',
  'Enemy wings','Shaheds and Gerberas','Tanks','APCs, IFVs, ACVs',
  'Guns, howitzers','Self-propelled artillery','Mortars','MRLS',
  'Light, Heavy, Special-purpose vehicles','Motorcycles and military buggies',
  'Ammo, fuel and equipment depots','Strategic infrastructure',
  'Tactical infrastructure','Shelters','Dugouts','Network equipment',
  'Cameras','Enemy copter drones','Enemy unmanned robotic complexes','Other',
];

// ── GOOGLE SHEETS ─────────────────────────────────────────
async function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function ensureHeaders(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID, range: `${SHEET_TAB}!A1:I1`,
  });
  const existing = (res.data.values || [])[0] || [];
  if (!existing.length || existing[0] !== 'date') {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TAB}!A1:I1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['date','system','target','type','loc','outcome','notes','src','srcl']] },
    });
    console.log('Headers written.');
  }
}

async function getExistingKeys(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID, range: `${SHEET_TAB}!A:C`,
  });
  const rows = res.data.values || [];
  return new Set(rows.slice(1).map(r => `${(r[0]||'').trim()}|${(r[2]||'').trim()}`));
}

async function appendRows(sheets, rows) {
  if (!rows.length) { console.log('Nothing to append.'); return; }
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TAB}!A:I`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });
  console.log(`  ✓ Wrote ${rows.length} rows`);
}

// ── HELPERS ───────────────────────────────────────────────
function categoriseTarget(category) {
  const c = category.toLowerCase();
  if (c.includes('personnel'))                                                return 'Personnel';
  if (c.includes('tank') || c.includes('apc') || c.includes('ifv') || c.includes('acv')) return 'Tank / AFV';
  if (c.includes('artillery') || c.includes('gun') || c.includes('howitzer') || c.includes('mortar') || c.includes('mrls')) return 'Artillery';
  if (c.includes('sam') || c.includes('spad') || c.includes('radar') || c.includes('ew')) return 'Air defence';
  if (c.includes('shahed') || c.includes('gerbera') || c.includes('wing') || c.includes('copter') || c.includes('drone') || c.includes('launch')) return 'Drone / Aircraft';
  if (c.includes('vehicle') || c.includes('motorcycle') || c.includes('buggy')) return 'Logistics';
  if (c.includes('depot') || c.includes('ammo') || c.includes('fuel'))       return 'Logistics';
  if (c.includes('shelter') || c.includes('dugout') || c.includes('infrastructure')) return 'Fortification';
  if (c.includes('antenna') || c.includes('network') || c.includes('camera')) return 'Electronics';
  return 'Other';
}

// ── EXTRACT DATA FROM CURRENT PAGE ───────────────────────
async function extractData(page, periodLabel, periodParam) {
  const extracted = await page.evaluate((categories) => {
    const allSpans = [...document.querySelectorAll('span')];
    const texts = allSpans.map(s => (s.innerText || '').trim());
    const results = {};
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      if (!categories.includes(text)) continue;
      let damaged = 0, destroyed = 0, numsFound = 0;
      for (let j = i + 1; j < Math.min(i + 15, texts.length); j++) {
        const t = texts[j];
        if (/^\d+$/.test(t)) {
          if (numsFound === 0) damaged   = parseInt(t, 10);
          if (numsFound === 1) destroyed = parseInt(t, 10);
          numsFound++;
          if (numsFound >= 2) break;
        }
        if (numsFound === 0 && categories.includes(t)) break;
      }
      results[text] = { damaged, destroyed };
    }
    return results;
  }, TARGET_CATEGORIES);

  // Log what we found
  let nonZero = 0;
  for (const [cat, vals] of Object.entries(extracted)) {
    if (vals.damaged > 0 || vals.destroyed > 0) nonZero++;
  }
  console.log(`  Extracted ${nonZero} categories with activity`);

  // ── Also extract summary headline figures ────────────────
  const summary = await page.evaluate(() => {
    const allSpans = [...document.querySelectorAll('span')];
    const texts = allSpans.map(s => (s.innerText || '').trim());
    const result = { totalDamaged: 0, totalDestroyed: 0, personnel: 0, killed: 0, wounded: 0, strikeFlights: 0, reconFlights: 0 };

    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      const next = texts[i + 1] || '';
      const prev = texts[i - 1] || '';

      if (/^\d+$/.test(t)) {
        const n = parseInt(t, 10);
        const label = next.toLowerCase();
        const prevLabel = prev.toLowerCase();
        if (label.includes('damaged targets'))   result.totalDamaged   = n;
        if (label.includes('incl. destroyed') && prevLabel.includes('damaged targets') || (label.includes('incl. destroyed') && result.totalDamaged > 0 && result.totalDestroyed === 0)) result.totalDestroyed = n;
        if (label.includes('enemy personnel') || label.includes('strike flights') === false && next.toLowerCase().includes('enemy personnel')) result.personnel = n;
        if (label.includes('killed') || label.includes('incl. killed')) result.killed   = n;
        if (label.includes('wounded') || label.includes('incl. wounded')) result.wounded  = n;
        if (label.includes('strike flights'))    result.strikeFlights  = n;
        if (label.includes('recon flights'))     result.reconFlights   = n;
      }
    }
    return result;
  });

  console.log(`  Summary: ${summary.totalDamaged} damaged, ${summary.totalDestroyed} destroyed, ${summary.personnel} personnel (${summary.killed} KIA, ${summary.wounded} WIA)`);

  // Build rows — use period param as the "date" so it's identifiable
  const dateKey = periodParam;
  const rows = [];

  // Add summary row first
  if (summary.totalDamaged > 0 || summary.totalDestroyed > 0) {
    rows.push([
      dateKey,
      'FPV / UAV (USF)',
      'TOTAL — All targets',
      'Summary',
      'Eastern Front',
      `${summary.totalDestroyed} destroyed, ${summary.totalDamaged} damaged`,
      `Period: ${periodLabel}. Total damaged: ${summary.totalDamaged}. Total destroyed: ${summary.totalDestroyed}. Strike flights: ${summary.strikeFlights}. Recon flights: ${summary.reconFlights}.`,
      `${BASE_URL}/?period=${periodParam}`,
      SOURCE_LABEL,
    ]);
  }

  // Add personnel row
  if (summary.personnel > 0) {
    rows.push([
      dateKey,
      'FPV / UAV (USF)',
      'Enemy personnel (summary)',
      'Personnel',
      'Eastern Front',
      `${summary.killed} killed, ${summary.wounded} wounded (${summary.personnel} total hit)`,
      `Period: ${periodLabel}. Total personnel hit: ${summary.personnel}. Killed: ${summary.killed}. Wounded: ${summary.wounded}.`,
      `${BASE_URL}/?period=${periodParam}`,
      SOURCE_LABEL,
    ]);
  }

  for (const category of TARGET_CATEGORIES) {
    const vals = extracted[category];
    if (!vals || (vals.damaged === 0 && vals.destroyed === 0)) continue;
    const outcome = vals.destroyed > 0
      ? `${vals.destroyed} destroyed, ${vals.damaged} damaged`
      : `${vals.damaged} damaged`;
    rows.push([
      dateKey,
      'FPV / UAV (USF)',
      category,
      categoriseTarget(category),
      'Eastern Front',
      outcome,
      `Period: ${periodLabel}. Damaged: ${vals.damaged}. Destroyed: ${vals.destroyed}. Source: USF Pidrakhuyka.`,
      `${BASE_URL}/?period=${periodParam}`,
      SOURCE_LABEL,
    ]);
  }
  return rows;
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
  const allRows = [];

  try {
    for (const period of PERIODS) {
      const url = `${BASE_URL}/?period=${period.param}`;
      console.log(`\nScraping: ${period.label} → ${url}`);

      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(3000);

      // Dismiss cookie banner
      const gotIt = page.locator('button:has-text("Got it")');
      if (await gotIt.isVisible().catch(() => false)) {
        await gotIt.click();
        await page.waitForTimeout(500);
      }

      // Log page text for debugging
      const bodyText = await page.evaluate(() => document.body.innerText);
      console.log(`  Page sample:\n${bodyText.slice(0, 400)}`);

      const rows = await extractData(page, period.label, period.param);
      console.log(`  → ${rows.length} rows extracted`);
      allRows.push(...rows);
    }

    await browser.close();
    return allRows;

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

  const sheets = await getSheetsClient();
  await ensureHeaders(sheets);
  const existingKeys = await getExistingKeys(sheets);
  console.log(`Existing rows in sheet: ${existingKeys.size}`);

  const rows = await scrape();
  console.log(`\nTotal rows scraped: ${rows.length}`);

  // Filter out any already in sheet
  const toAppend = rows.filter(r => !existingKeys.has(`${r[0]}|${r[2]}`));
  console.log(`New rows to write: ${toAppend.length}`);

  await appendRows(sheets, toAppend);
  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
