/**
 * USF Pidrakhuyka Kill Board Scraper
 * -----------------------------------
 * Scrapes https://sbs-group.army/en/ using Playwright (headless Chromium)
 * then writes new entries to the UAV tab of your Google Sheet.
 *
 * Runs daily via GitHub Actions. New rows are appended only —
 * existing data is never overwritten.
 */

const { chromium } = require('@playwright/test');
const { google }   = require('googleapis');

// ── CONFIG ────────────────────────────────────────────────
const TARGET_URL    = 'https://sbs-group.army/en/';
const SHEET_TAB     = 'UAV';   // must match your Google Sheet tab name exactly
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// ── GOOGLE SHEETS AUTH ────────────────────────────────────
async function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// ── READ EXISTING DATA (to avoid duplicates) ──────────────
async function getExistingRows(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TAB}!A:A`,  // just the date column
  });
  const rows = res.data.values || [];
  // Return a Set of existing row identifiers (date + target combined)
  return new Set(rows.slice(1).map(r => r[0]));
}

// ── APPEND NEW ROWS ───────────────────────────────────────
async function appendRows(sheets, rows) {
  if (!rows.length) {
    console.log('No new rows to append.');
    return;
  }
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TAB}!A:I`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });
  console.log(`Appended ${rows.length} new rows.`);
}

// ── ENSURE HEADERS EXIST ──────────────────────────────────
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

// ── SCRAPE THE SITE ───────────────────────────────────────
async function scrape() {
  console.log(`Launching browser and navigating to ${TARGET_URL}...`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
  });

  const page = await context.newPage();

  try {
    // Navigate and wait for content to load
    await page.goto(TARGET_URL, {
      waitUntil: 'networkidle',
      timeout: 60000,
    });

    // Give JS-rendered content extra time to appear
    await page.waitForTimeout(3000);

    // ── Try to extract table/list data ──
    // The site may render data as a table, cards, or list —
    // we try multiple selectors and log what we find
    console.log('Page loaded. Extracting data...');

    // Log the page structure to understand what's there
    const pageTitle = await page.title();
    console.log('Page title:', pageTitle);

    // Take a screenshot for debugging (saved as artifact)
    await page.screenshot({ path: 'screenshot.png', fullPage: true });
    console.log('Screenshot saved.');

    // Try to find any table rows
    const tableRows = await page.$$eval('table tbody tr', rows =>
      rows.map(row => {
        const cells = [...row.querySelectorAll('td')].map(td => td.innerText.trim());
        return cells;
      })
    ).catch(() => []);

    console.log(`Found ${tableRows.length} table rows`);

    // Try to find list items or cards
    const listItems = await page.$$eval('[class*="kill"], [class*="record"], [class*="hit"], [class*="item"], [class*="card"], [class*="entry"], [class*="row"]', items =>
      items.map(el => el.innerText.trim())
    ).catch(() => []);

    console.log(`Found ${listItems.length} list/card items`);

    // Log full page text for structure analysis
    const bodyText = await page.evaluate(() => document.body.innerText);
    console.log('--- PAGE TEXT SAMPLE (first 2000 chars) ---');
    console.log(bodyText.slice(0, 2000));
    console.log('-------------------------------------------');

    // Log all class names on the page to find data containers
    const allClasses = await page.evaluate(() => {
      const classes = new Set();
      document.querySelectorAll('*').forEach(el => {
        el.classList.forEach(c => classes.add(c));
      });
      return [...classes].slice(0, 100);
    });
    console.log('Classes found on page:', allClasses.join(', '));

    await browser.close();

    return { tableRows, listItems, bodyText };

  } catch (err) {
    console.error('Scrape error:', err.message);
    await page.screenshot({ path: 'error-screenshot.png' }).catch(() => {});
    await browser.close();
    throw err;
  }
}

// ── PARSE ROWS INTO SHEET FORMAT ──────────────────────────
// This function maps scraped data to the sheet columns:
// date | system | target | type | loc | outcome | notes | src | srcl
//
// You will likely need to adjust the field mapping below once
// we see the actual page structure from the first run.
function parseRows(scrapedData) {
  const { tableRows } = scrapedData;
  const parsed = [];

  for (const cells of tableRows) {
    if (!cells.length) continue;

    // ── ADJUST THIS MAPPING once you see the real column order ──
    // Current assumption: date | target | type | location | outcome
    // Update field indices after first run reveals real structure
    const row = [
      cells[0] || '',   // date
      'FPV/UAV',        // system (default until we know from data)
      cells[1] || '',   // target
      cells[2] || '',   // type
      cells[3] || '',   // loc
      cells[4] || '',   // outcome
      '',               // notes
      TARGET_URL,       // src
      'USF Pidrakhuyka',// srcl
    ];

    parsed.push(row);
  }

  return parsed;
}

// ── MAIN ──────────────────────────────────────────────────
async function main() {
  // Validate env vars
  if (!SPREADSHEET_ID) {
    throw new Error('SPREADSHEET_ID environment variable not set');
  }
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON environment variable not set');
  }

  // 1. Scrape the site
  const scrapedData = await scrape();

  // 2. Parse into sheet rows
  const newRows = parseRows(scrapedData);
  console.log(`Parsed ${newRows.length} rows from scrape`);

  // 3. Connect to Google Sheets
  const sheets = await getSheetsClient();

  // 4. Ensure headers are in place
  await ensureHeaders(sheets);

  // 5. Get existing row keys to avoid duplicates
  const existing = await getExistingRows(sheets);
  console.log(`${existing.size} existing rows in sheet`);

  // 6. Filter to only new rows
  const toAppend = newRows.filter(row => !existing.has(row[0]));
  console.log(`${toAppend.length} new rows to add`);

  // 7. Append new rows
  await appendRows(sheets, toAppend);

  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
