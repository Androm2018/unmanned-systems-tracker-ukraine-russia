/**
 * USF Pidrakhuyka Kill Board Scraper
 * -----------------------------------
 * Scrapes https://sbs-group.army/en/ using Playwright (headless Chromium)
 * then writes new entries to the UAV tab of your Google Sheet.
 * Runs daily via GitHub Actions.
 */

const { chromium } = require('@playwright/test');
const { google }   = require('googleapis');

const TARGET_URL     = 'https://sbs-group.army/en/';
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
    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(4000);

    // Dismiss cookie banner if present
    const gotIt = page.locator('button:has-text("Got it")');
    if (await gotIt.isVisible()) {
      await gotIt.click();
      await page.waitForTimeout(1000);
    }

    // ── Find unit cards ──────────────────────────────────
    // Cards are divs containing an H1 with the unit name
    const unitNames = await page.$$eval('h1', els =>
      els.map(el => el.innerText.trim()).filter(t => t.length > 0 && t.length < 40)
    );
    console.log('Unit H1s found:', unitNames);

    // Click each unit card and scrape the resulting data
    for (const unitName of unitNames) {
      try {
        console.log(`\n=== Clicking unit: ${unitName} ===`);

        // Re-find the h1 on the current page and click its parent card
        const h1 = page.locator(`h1`).filter({ hasText: unitName }).first();
        if (!await h1.isVisible()) {
          console.log(`  ${unitName}: h1 not visible, skipping`);
          continue;
        }

        // Click the card (parent element of h1)
        await h1.click();
        await page.waitForTimeout(3000);

        // Check if the page changed — look for new content
        const pageText = await page.evaluate(() => document.body.innerText);
        console.log(`  Page text after click (first 800 chars):\n`, pageText.slice(0, 800));

        // Log URL in case it navigated
        console.log('  Current URL:', page.url());

        // Look for any kill statistics — numbers next to target type words
        const statsBlocks = await page.evaluate(() => {
          const results = [];
          // Look for elements that contain both a number and a military target word
          const militaryWords = ['tank', 'apc', 'artillery', 'personnel', 'drone',
            'helicopter', 'vehicle', 'manpower', 'gun', 'mortar', 'radar',
            'truck', 'boat', 'aircraft', 'missile', 'launcher'];

          document.querySelectorAll('*').forEach(el => {
            if (el.children.length > 0) return;
            const text = el.innerText?.trim() || '';
            if (!text || text.length > 300) return;
            const lower = text.toLowerCase();
            const hasNumber = /\d/.test(text);
            const hasMilWord = militaryWords.some(w => lower.includes(w));
            if (hasNumber || hasMilWord) {
              results.push({
                tag: el.tagName,
                classes: el.className.slice(0, 80),
                text: text.slice(0, 200),
              });
            }
          });
          return results.slice(0, 60);
        });

        console.log(`  Stats blocks found (${statsBlocks.length}):`);
        statsBlocks.forEach(b => console.log(`    [${b.tag}] "${b.text}" (${b.classes})`));

        // Take a screenshot for this unit
        await page.screenshot({
          path: `unit-${unitName.replace(/[^a-z0-9]/gi,'_').toLowerCase()}.png`,
          fullPage: true,
        });

        // Navigate back to main page for next unit
        await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(2000);

        // Dismiss cookie banner again if it reappears
        const gotItAgain = page.locator('button:has-text("Got it")');
        if (await gotItAgain.isVisible()) await gotItAgain.click();
        await page.waitForTimeout(1000);

      } catch (unitErr) {
        console.error(`  Error scraping ${unitName}:`, unitErr.message);
      }
    }

    await browser.close();
    return allRows;

  } catch (err) {
    console.error('Fatal scrape error:', err.message);
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
  console.log(`New rows to append: ${toAppend.length}`);
  await appendRows(sheets, toAppend);
  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
