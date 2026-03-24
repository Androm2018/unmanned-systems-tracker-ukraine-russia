/**
 * USF Pidrakhuyka Kill Board Scraper — PRODUCTION
 * -------------------------------------------------
 * Scrapes https://sbs-group.army/en/subdivision/usf_grouping
 * Extracts daily kill data by target category and writes to Google Sheets UAV tab.
 * Runs daily via GitHub Actions. Only appends new dates — never overwrites.
 */

const { chromium } = require('@playwright/test');
const { google }   = require('googleapis');

const DATA_URL       = 'https://sbs-group.army/en/subdivision/usf_grouping';
const SOURCE_LABEL   = 'USF Pidrakhuyka';
const SHEET_TAB      = 'UAV';
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// Target categories to extract — in the order they appear on the page
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

// ── ENSURE HEADERS ────────────────────────────────────────
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

// ── READ EXISTING ROWS ────────────────────────────────────
async function getExistingKeys(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TAB}!A:C`,
  });
  const rows = res.data.values || [];
  // Key = date|target — prevents duplicates if run twice on same day
  return new Set(rows.slice(1).map(r => `${(r[0]||'').trim()}|${(r[2]||'').trim()}`));
}

// ── APPEND ROWS ───────────────────────────────────────────
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

// ── CONVERT DATE FORMAT ───────────────────────────────────
// Site shows DD.MM.YYYY → convert to YYYY-MM-DD for consistency
function convertDate(raw) {
  const parts = raw.trim().split('.');
  if (parts.length === 3) {
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }
  return raw;
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
    await page.waitForTimeout(3000);

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
        const t = el.innerText?.trim() || '';
        if (/^\d{2}\.\d{2}\.\d{4}$/.test(t)) return t;
      }
      return null;
    });

    if (!rawDate) throw new Error('Could not find date on page');
    const date = convertDate(rawDate);
    console.log(`Date found: ${rawDate} → ${date}`);

    // ── Extract all target rows ───────────────────────────
    // Structure: SPAN[label] followed by SPAN[damaged] SPAN[destroyed]
    // Label spans have the class containing 'flex items-center'
    const extracted = await page.evaluate((categories) => {
      const results = {};
      const allSpans = [...document.querySelectorAll('span')];

      for (const span of allSpans) {
        const text = span.innerText?.trim();
        if (!text || !categories.includes(text)) continue;

        // Find the next sibling spans with numbers
        let sibling = span.parentElement?.nextElementSibling;
        let damaged = null;
        let destroyed = null;

        // Look up to 3 siblings forward for number spans
        let attempts = 0;
        while (sibling && attempts < 3) {
          const spans = sibling.querySelectorAll('span');
          const nums = [...spans].map(s => s.innerText?.trim()).filter(t => /^\d+$/.test(t));
          if (nums.length >= 2) {
            damaged   = parseInt(nums[0], 10);
            destroyed = parseInt(nums[1], 10);
            break;
          } else if (nums.length === 1 && damaged === null) {
            damaged = parseInt(nums[0], 10);
          }
          sibling = sibling.nextElementSibling;
          attempts++;
        }

        results[text] = { damaged: damaged ?? 0, destroyed: destroyed ?? 0 };
      }
      return results;
    }, TARGET_CATEGORIES);

    console.log('\nExtracted data:');
    Object.entries(extracted).forEach(([cat, vals]) => {
      console.log(`  ${cat}: damaged=${vals.damaged} destroyed=${vals.destroyed}`);
    });

    // ── Build sheet rows ──────────────────────────────────
    // One row per category, only include rows where damaged > 0
    // Columns: date | system | target | type | loc | outcome | notes | src | srcl
    const rows = [];
    for (const category of TARGET_CATEGORIES) {
      const vals = extracted[category];
      if (!vals) continue;

      // Skip zero rows to keep the sheet clean
      if (vals.damaged === 0 && vals.destroyed === 0) continue;

      const outcome = vals.destroyed > 0
        ? `${vals.destroyed} destroyed, ${vals.damaged} damaged`
        : `${vals.damaged} damaged`;

      const notes = `Daily USF Grouping total. Damaged: ${vals.damaged}. Destroyed: ${vals.destroyed}.`;

      rows.push([
        date,                    // date (YYYY-MM-DD)
        'FPV / UAV (USF)',       // system
        category,                // target
        categoriseTarget(category), // type
        'Eastern Front',         // loc
        outcome,                 // outcome
        notes,                   // notes
        DATA_URL,                // src
        SOURCE_LABEL,            // srcl
      ]);
    }

    console.log(`\nRows with activity today: ${rows.length}`);
    await browser.close();
    return rows;

  } catch (err) {
    console.error('Scrape error:', err.message);
    await page.screenshot({ path: 'error.png' }).catch(() => {});
    await browser.close();
    throw err;
  }
}

// ── CATEGORISE TARGET TYPE ────────────────────────────────
function categoriseTarget(category) {
  const c = category.toLowerCase();
  if (c.includes('personnel') || c.includes('killed') || c.includes('wounded')) return 'Personnel';
  if (c.includes('tank'))          return 'Tank / AFV';
  if (c.includes('apc') || c.includes('ifv') || c.includes('acv')) return 'Tank / AFV';
  if (c.includes('artillery') || c.includes('gun') || c.includes('howitzer') || c.includes('mortar') || c.includes('mrls')) return 'Artillery';
  if (c.includes('sam') || c.includes('spad') || c.includes('radar') || c.includes('ew')) return 'Air defence';
  if (c.includes('shahed') || c.includes('gerbera') || c.includes('drone') || c.includes('wing') || c.includes('copter')) return 'Drone / Aircraft';
  if (c.includes('vehicle') || c.includes('motorcycle') || c.includes('buggy') || c.includes('truck')) return 'Logistics';
  if (c.includes('depot') || c.includes('ammo') || c.includes('fuel')) return 'Logistics';
  if (c.includes('shelter') || c.includes('dugout') || c.includes('infrastructure')) return 'Fortification';
  if (c.includes('antenna') || c.includes('network') || c.includes('camera')) return 'Electronics';
  if (c.includes('launch')) return 'Drone / Aircraft';
  return 'Other';
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
