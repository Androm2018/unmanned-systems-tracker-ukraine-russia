/**
 * USF Pidrakhuyka Kill Board — HISTORICAL BACKFILL
 * -------------------------------------------------
 * Run this ONCE manually to populate all historical data
 * from June 2025 (when the system launched) to today.
 *
 * Run with: node backfill-usf.js
 *
 * After this completes, the daily scrape-usf.js handles new days.
 */

const { chromium } = require('@playwright/test');
const { google }   = require('googleapis');

const BASE_URL       = 'https://sbs-group.army/en/subdivision/usf_grouping';
const SOURCE_LABEL   = 'USF Pidrakhuyka';
const SHEET_TAB      = 'UAV';
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// Date range — site launched June 2025, adjust START_DATE if needed
const START_DATE = new Date('2025-06-01');
const END_DATE   = new Date(); // today

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

// ── HELPERS ───────────────────────────────────────────────
function formatDate(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function toDDMMYYYY(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function categoriseTarget(category) {
  const c = category.toLowerCase();
  if (c.includes('personnel'))                                                return 'Personnel';
  if (c.includes('tank'))                                                     return 'Tank / AFV';
  if (c.includes('apc') || c.includes('ifv') || c.includes('acv'))           return 'Tank / AFV';
  if (c.includes('artillery') || c.includes('gun') || c.includes('howitzer')
    || c.includes('mortar') || c.includes('mrls'))                           return 'Artillery';
  if (c.includes('sam') || c.includes('spad') || c.includes('radar')
    || c.includes('ew'))                                                      return 'Air defence';
  if (c.includes('shahed') || c.includes('gerbera') || c.includes('wing')
    || c.includes('copter') || c.includes('drone') || c.includes('launch'))  return 'Drone / Aircraft';
  if (c.includes('vehicle') || c.includes('motorcycle') || c.includes('buggy')) return 'Logistics';
  if (c.includes('depot') || c.includes('ammo') || c.includes('fuel'))       return 'Logistics';
  if (c.includes('shelter') || c.includes('dugout')
    || c.includes('infrastructure'))                                          return 'Fortification';
  if (c.includes('antenna') || c.includes('network') || c.includes('camera')) return 'Electronics';
  return 'Other';
}

// ── GOOGLE SHEETS ─────────────────────────────────────────
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
  if (!rows.length) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TAB}!A:I`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });
}

// ── SCRAPE ONE DATE ───────────────────────────────────────
async function scrapeDate(page, date) {
  // Try URL patterns the site might use for historical dates
  // Pattern 1: query param  ?date=DD.MM.YYYY
  // Pattern 2: query param  ?period=daily&date=YYYY-MM-DD
  // Pattern 3: page shows "Previous Period" button — click it

  const ddmmyyyy = toDDMMYYYY(date);
  const yyyymmdd = formatDate(date);

  // Try the direct URL with date param first
  const urlsToTry = [
    `${BASE_URL}?date=${ddmmyyyy}`,
    `${BASE_URL}?period=daily&date=${yyyymmdd}`,
    `${BASE_URL}?day=${ddmmyyyy}`,
  ];

  for (const url of urlsToTry) {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Check what date the page shows
    const pageDate = await page.evaluate(() => {
      const els = [...document.querySelectorAll('p, span')];
      for (const el of els) {
        const t = (el.innerText || '').trim();
        if (/^\d{2}\.\d{2}\.\d{4}$/.test(t)) return t;
      }
      return null;
    });

    if (pageDate === ddmmyyyy) {
      // Correct date loaded — extract data
      return await extractData(page, yyyymmdd);
    }
  }

  // If URL params didn't work, try clicking "Previous Period" on the page
  // This is a fallback — navigate from current page backwards
  return null;
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
      date,
      'FPV / UAV (USF)',
      category,
      categoriseTarget(category),
      'Eastern Front',
      outcome,
      `Damaged: ${vals.damaged}. Destroyed: ${vals.destroyed}. Source: USF Pidrakhuyka daily report.`,
      BASE_URL,
      SOURCE_LABEL,
    ]);
  }
  return rows;
}

// ── NAVIGATE USING PREVIOUS PERIOD BUTTON ────────────────
async function scrapeByNavigation(page, sheets, existingKeys) {
  // Navigate to today's page first then step backwards
  console.log('\nTrying navigation approach (Previous Period button)...');
  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);

  // Dismiss cookie banner
  const gotIt = page.locator('button:has-text("Got it")');
  if (await gotIt.isVisible().catch(() => false)) {
    await gotIt.click();
    await page.waitForTimeout(500);
  }

  const allRows = [];
  let consecutiveFailures = 0;
  const MAX_FAILURES = 5;

  while (consecutiveFailures < MAX_FAILURES) {
    // Get current date on page
    const rawDate = await page.evaluate(() => {
      const els = [...document.querySelectorAll('p, span')];
      for (const el of els) {
        const t = (el.innerText || '').trim();
        if (/^\d{2}\.\d{2}\.\d{4}$/.test(t)) return t;
      }
      return null;
    });

    if (!rawDate) {
      console.log('  No date found on page, stopping.');
      break;
    }

    const parts = rawDate.split('.');
    const isoDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
    const pageDateTime = new Date(isoDate);

    // Stop if we've gone past our start date
    if (pageDateTime < START_DATE) {
      console.log(`  Reached start date (${rawDate}), stopping.`);
      break;
    }

    console.log(`  Processing: ${rawDate} (${isoDate})`);

    // Check if we already have this date
    const sampleKey = `${isoDate}|Enemy personnel`;
    if (existingKeys.has(sampleKey)) {
      console.log(`  Already have ${isoDate}, skipping.`);
    } else {
      // Extract data
      const rows = await extractData(page, isoDate);
      if (rows.length > 0) {
        console.log(`  Found ${rows.length} rows for ${isoDate}`);
        allRows.push(...rows);

        // Write to sheet in batches of 50 rows
        if (allRows.length >= 50) {
          const toWrite = allRows.splice(0, 50).filter(r => !existingKeys.has(`${r[0]}|${r[2]}`));
          if (toWrite.length > 0) {
            await appendRows(sheets, toWrite);
            toWrite.forEach(r => existingKeys.add(`${r[0]}|${r[2]}`));
            console.log(`  Wrote batch of ${toWrite.length} rows`);
          }
        }
        consecutiveFailures = 0;
      } else {
        console.log(`  No data for ${isoDate}`);
        consecutiveFailures++;
      }
    }

    // Click "Previous Period" — it's an H2 on this site
    // Confirmed from diagnostic logs: [H2] "Previous Period"
    const prevEl = page.locator('h2, button, a, div, span').filter({ hasText: 'Previous Period' }).first();
    const prevVisible = await prevEl.isVisible().catch(() => false);

    if (prevVisible) {
      console.log('  Clicking Previous Period...');
      await prevEl.click();
      await page.waitForTimeout(3000);
    } else {
      // Log all h2s for debugging
      const h2s = await page.evaluate(() =>
        [...document.querySelectorAll('h2')].map(el => el.innerText?.trim())
      );
      console.log('  H2s on page:', h2s.join(' | '));

      // Broader search for any element with backward navigation text
      const anyPrev = page.locator('h2, h3, button, a, div').filter({ hasText: /previous period/i }).first();
      if (await anyPrev.isVisible().catch(() => false)) {
        await anyPrev.click();
        await page.waitForTimeout(3000);
      } else {
        console.log('  No Previous Period element found — stopping.');
        break;
      }
    }
  }

  // Write any remaining rows
  if (allRows.length > 0) {
    const toWrite = allRows.filter(r => !existingKeys.has(`${r[0]}|${r[2]}`));
    if (toWrite.length > 0) {
      await appendRows(sheets, toWrite);
      console.log(`Wrote final batch of ${toWrite.length} rows`);
    }
  }

  return allRows;
}

// ── MAIN ──────────────────────────────────────────────────
async function main() {
  if (!SPREADSHEET_ID) throw new Error('SPREADSHEET_ID not set');
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');

  console.log(`Backfill: ${formatDate(START_DATE)} to ${formatDate(END_DATE)}`);

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
  const sheets = await getSheetsClient();
  await ensureHeaders(sheets);
  const existingKeys = await getExistingKeys(sheets);
  console.log(`Already have ${existingKeys.size} rows in sheet`);

  try {
    // First try: URL parameter approach for individual dates
    console.log('\n=== Phase 1: Testing URL date parameters ===');
    const testDate = new Date();
    testDate.setDate(testDate.getDate() - 1); // yesterday
    const testRows = await scrapeDate(page, testDate);

    if (testRows && testRows.length > 0) {
      console.log('URL params work! Iterating all dates...');
      const allRows = [];
      let current = new Date(START_DATE);
      while (current <= END_DATE) {
        const isoDate = formatDate(current);
        const sampleKey = `${isoDate}|Enemy personnel`;
        if (!existingKeys.has(sampleKey)) {
          const rows = await scrapeDate(page, current);
          if (rows && rows.length > 0) {
            console.log(`  ${isoDate}: ${rows.length} rows`);
            allRows.push(...rows);
          }
        } else {
          console.log(`  ${isoDate}: already exists, skipping`);
        }
        // Batch write every 100 rows
        if (allRows.length >= 100) {
          const toWrite = allRows.splice(0, 100).filter(r => !existingKeys.has(`${r[0]}|${r[2]}`));
          await appendRows(sheets, toWrite);
          toWrite.forEach(r => existingKeys.add(`${r[0]}|${r[2]}`));
          console.log(`  Wrote batch of ${toWrite.length} rows`);
        }
        await page.waitForTimeout(1000); // be polite to the server
        current = addDays(current, 1);
      }
      if (allRows.length > 0) {
        const toWrite = allRows.filter(r => !existingKeys.has(`${r[0]}|${r[2]}`));
        await appendRows(sheets, toWrite);
        console.log(`Wrote final ${toWrite.length} rows`);
      }
    } else {
      // Phase 2: Navigate using Previous Period button
      console.log('URL params did not work. Trying navigation approach...');
      await scrapeByNavigation(page, sheets, existingKeys);
    }

    await browser.close();
    console.log('\nBackfill complete!');

  } catch (err) {
    console.error('Error:', err.message);
    await browser.close();
    throw err;
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
