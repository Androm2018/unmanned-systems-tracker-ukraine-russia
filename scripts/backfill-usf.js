/**
 * USF Pidrakhuyka Kill Board — HISTORICAL BACKFILL v4
 * ---------------------------------------------------
 * Clicks "Previous Period" and waits for the date to actually
 * change before extracting data. Handles SPA navigation.
 */

const { chromium } = require('@playwright/test');
const { google }   = require('googleapis');

const DATA_URL       = 'https://sbs-group.army/en/subdivision/usf_grouping';
const SOURCE_LABEL   = 'USF Pidrakhuyka';
const SHEET_TAB      = 'UAV';
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// Site launched July 2025 — don't go further back than this
const START_DATE = new Date('2025-07-01');

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
  console.log(`  ✓ Wrote ${rows.length} rows to sheet`);
}

// ── HELPERS ───────────────────────────────────────────────
function convertDate(raw) {
  const p = raw.trim().split('.');
  return p.length === 3 ? `${p[2]}-${p[1]}-${p[0]}` : raw;
}

function categoriseTarget(category) {
  const c = category.toLowerCase();
  if (c.includes('personnel'))                                               return 'Personnel';
  if (c.includes('tank') || c.includes('apc') || c.includes('ifv') || c.includes('acv')) return 'Tank / AFV';
  if (c.includes('artillery') || c.includes('gun') || c.includes('howitzer') || c.includes('mortar') || c.includes('mrls')) return 'Artillery';
  if (c.includes('sam') || c.includes('spad') || c.includes('radar') || c.includes('ew')) return 'Air defence';
  if (c.includes('shahed') || c.includes('gerbera') || c.includes('wing') || c.includes('copter') || c.includes('drone') || c.includes('launch')) return 'Drone / Aircraft';
  if (c.includes('vehicle') || c.includes('motorcycle') || c.includes('buggy')) return 'Logistics';
  if (c.includes('depot') || c.includes('ammo') || c.includes('fuel'))      return 'Logistics';
  if (c.includes('shelter') || c.includes('dugout') || c.includes('infrastructure')) return 'Fortification';
  if (c.includes('antenna') || c.includes('network') || c.includes('camera')) return 'Electronics';
  return 'Other';
}

// ── GET DATE FROM PAGE ────────────────────────────────────
async function getPageDate(page) {
  return page.evaluate(() => {
    const els = [...document.querySelectorAll('p, span')];
    for (const el of els) {
      const t = (el.innerText || '').trim();
      if (/^\d{2}\.\d{2}\.\d{4}$/.test(t)) return t;
    }
    return null;
  });
}

// ── EXTRACT DATA FROM CURRENT PAGE ───────────────────────
async function extractData(page, date) {
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

  const rows = [];
  for (const category of TARGET_CATEGORIES) {
    const vals = extracted[category];
    if (!vals || (vals.damaged === 0 && vals.destroyed === 0)) continue;
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
  return rows;
}

// ── MAIN SCRAPE ───────────────────────────────────────────
async function scrape(sheets, existingKeys) {
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
    console.log(`Navigating to ${DATA_URL}...`);
    await page.goto(DATA_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Dismiss cookie banner
    const gotIt = page.locator('button:has-text("Got it")');
    if (await gotIt.isVisible().catch(() => false)) {
      await gotIt.click();
      await page.waitForTimeout(500);
    }

    let totalWritten = 0;
    let pagesProcessed = 0;
    const pendingRows = [];

    while (true) {
      // Get current date
      const rawDate = await getPageDate(page);
      if (!rawDate) { console.log('No date found, stopping.'); break; }

      const isoDate = convertDate(rawDate);
      const pageDate = new Date(isoDate);

      // Stop if we've gone past our start date
      if (pageDate < START_DATE) {
        console.log(`Reached ${rawDate} (before start date), stopping.`);
        break;
      }

      pagesProcessed++;
      const sampleKey = `${isoDate}|Enemy personnel`;

      if (existingKeys.has(sampleKey)) {
        console.log(`  ${rawDate}: already in sheet, skipping`);
      } else {
        const rows = await extractData(page, isoDate);
        if (rows.length > 0) {
          console.log(`  ${rawDate}: ${rows.length} categories with activity`);
          pendingRows.push(...rows);
          rows.forEach(r => existingKeys.add(`${r[0]}|${r[2]}`));
        } else {
          console.log(`  ${rawDate}: no activity recorded`);
        }
      }

      // Write to sheet every 20 pages
      if (pendingRows.length >= 100) {
        await appendRows(sheets, pendingRows.splice(0));
        totalWritten += pendingRows.length;
      }

      // ── Navigate to previous day ──────────────────────
      // Find the "Previous Period" H2 and click it
      const prevEl = page.locator('h2').filter({ hasText: 'Previous Period' }).first();
      const prevVisible = await prevEl.isVisible().catch(() => false);

      if (!prevVisible) {
        console.log('Previous Period element not found, stopping.');
        break;
      }

      // Click and wait for the DATE to change — this is the key fix
      await prevEl.click();

      // Wait up to 8 seconds for the date on the page to change
      let dateChanged = false;
      for (let i = 0; i < 16; i++) {
        await page.waitForTimeout(500);
        const newDate = await getPageDate(page);
        if (newDate && newDate !== rawDate) {
          dateChanged = true;
          break;
        }
      }

      if (!dateChanged) {
        console.log(`  Date did not change after clicking Previous Period (stuck on ${rawDate})`);
        console.log('  Trying to reload and navigate...');

        // Try reloading the page with a date parameter
        const parts = rawDate.split('.');
        const prevDay = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
        prevDay.setDate(prevDay.getDate() - 1);
        const pd = prevDay.toISOString().slice(0, 10).split('-');
        const prevDDMMYYYY = `${pd[2]}.${pd[1]}.${pd[0]}`;

        // Log current page HTML around "Previous Period" for debugging
        const h2Info = await page.evaluate(() => {
          const h2s = [...document.querySelectorAll('h2')];
          return h2s.map(h => ({
            text: h.innerText?.trim(),
            classes: h.className,
            onclick: h.getAttribute('onclick'),
            parent: h.parentElement?.tagName + '.' + h.parentElement?.className?.slice(0,50)
          }));
        });
        console.log('  H2 elements:', JSON.stringify(h2Info, null, 2));
        break;
      }
    }

    // Write any remaining rows
    if (pendingRows.length > 0) {
      await appendRows(sheets, pendingRows);
      totalWritten += pendingRows.length;
    }

    console.log(`\nBackfill complete. Pages processed: ${pagesProcessed}. Total rows written: ${totalWritten}`);
    await browser.close();

  } catch (err) {
    console.error('Error:', err.message);
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
  console.log(`Already have ${existingKeys.size} rows in sheet`);

  await scrape(sheets, existingKeys);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
