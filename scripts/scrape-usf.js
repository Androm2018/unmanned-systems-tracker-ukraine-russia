/**
 * USF Pidrakhuyka Kill Board Scraper
 * -----------------------------------
 * Scrapes https://sbs-group.army/en/subdivision/usf_grouping
 * then writes entries to the UAV tab of your Google Sheet.
 * Runs daily via GitHub Actions.
 */

const { chromium } = require('@playwright/test');
const { google }   = require('googleapis');

const TARGET_URL     = 'https://sbs-group.army/en/subdivision/usf_grouping';
const SHEET_TAB      = 'UAV';
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
async function getExistingRows(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TAB}!A:C`,
  });
  const rows = res.data.values || [];
  return new Set(rows.slice(1).map(r => `${r[0]}|${r[2]}`));
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

// ── SCRAPE ────────────────────────────────────────────────
async function scrape() {
  console.log(`Navigating to: ${TARGET_URL}`);

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
    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60000 });

    // Extra wait for JS-rendered content
    await page.waitForTimeout(5000);

    // Dismiss cookie banner if present
    const gotIt = page.locator('button:has-text("Got it")');
    if (await gotIt.isVisible()) {
      await gotIt.click();
      await page.waitForTimeout(1000);
    }

    console.log('Page title:', await page.title());
    console.log('URL after load:', page.url());

    // ── Full page text ──────────────────────────────────
    const bodyText = await page.evaluate(() => document.body.innerText);
    console.log('\n=== FULL PAGE TEXT ===');
    console.log(bodyText.slice(0, 5000));
    console.log('=== END PAGE TEXT ===\n');

    // ── All leaf elements with content ──────────────────
    const allElements = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('*').forEach(el => {
        if (el.children.length > 0) return;
        const text = el.innerText?.trim() || '';
        if (!text || text.length > 500 || text.length < 1) return;
        results.push({
          tag: el.tagName,
          classes: el.className?.toString().slice(0, 100) || '',
          text: text.slice(0, 300),
        });
      });
      return results.slice(0, 100);
    });

    console.log(`\n=== ALL LEAF ELEMENTS (${allElements.length}) ===`);
    allElements.forEach(e => console.log(`[${e.tag}] "${e.text}" :: ${e.classes}`));

    // ── Screenshot ──────────────────────────────────────
    await page.screenshot({ path: 'usf-grouping.png', fullPage: true });
    console.log('\nScreenshot saved: usf-grouping.png');

    // ── Try to find any table, list, or grid of kills ───
    const tables = await page.$$eval('table', ts =>
      ts.map(t => t.innerText?.trim().slice(0, 500))
    );
    if (tables.length) {
      console.log('\n=== TABLES FOUND ===');
      tables.forEach((t, i) => console.log(`Table ${i}:`, t));
    }

    // ── Check for any data attributes ───────────────────
    const dataAttrs = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('[data-*]').forEach(el => {
        const attrs = [...el.attributes]
          .filter(a => a.name.startsWith('data-'))
          .map(a => `${a.name}="${a.value}"`)
          .join(' ');
        if (attrs) results.push({ tag: el.tagName, attrs, text: el.innerText?.trim().slice(0, 100) });
      });
      return results.slice(0, 30);
    });
    if (dataAttrs.length) {
      console.log('\n=== DATA ATTRIBUTES ===');
      dataAttrs.forEach(d => console.log(`[${d.tag}] ${d.attrs} :: "${d.text}"`));
    }

    // ── Check network requests for API calls ────────────
    console.log('\n=== INTERCEPTED API CALLS ===');
    const apiCalls = [];
    page.on('request', req => {
      const url = req.url();
      if (url.includes('api') || url.includes('json') || url.includes('data') ||
          url.includes('kill') || url.includes('stat') || url.includes('report')) {
        apiCalls.push({ method: req.method(), url });
      }
    });

    // Reload with network interception active
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);

    apiCalls.forEach(c => console.log(`${c.method} ${c.url}`));
    if (!apiCalls.length) console.log('No obvious API calls detected');

    await browser.close();
    return []; // Return empty for now — will fill in once we see the structure

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
  console.log(`\nTotal rows scraped: ${rows.length}`);

  const sheets = await getSheetsClient();
  await ensureHeaders(sheets);

  const existing = await getExistingRows(sheets);
  const toAppend = rows.filter(r => !existing.has(`${r[0]}|${r[2]}`));
  await appendRows(sheets, toAppend);
  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
