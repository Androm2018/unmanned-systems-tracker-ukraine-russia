/**
 * USF Pidrakhuyka Kill Board Scraper
 * -----------------------------------
 * Scrapes https://sbs-group.army/en/ using Playwright (headless Chromium)
 * then writes new entries to the UAV tab of your Google Sheet.
 *
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

// ── READ EXISTING ROWS ────────────────────────────────────
async function getExistingRows(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TAB}!A:C`,
  });
  const rows = res.data.values || [];
  return new Set(rows.slice(1).map(r => `${r[0]}|${r[2]}`));
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

// ── SCRAPE ONE UNIT PAGE ──────────────────────────────────
async function scrapeUnit(page, unitName) {
  console.log(`\n--- Scraping unit: ${unitName} ---`);
  const results = [];

  // Wait for content to load after navigation
  await page.waitForTimeout(3000);

  // Log the page text to understand structure
  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log(`Page text sample (${unitName}):\n`, bodyText.slice(0, 1500));

  // Try to find any stats/kill data — look for numbers and target words
  // Common patterns: tank, APC, personnel, artillery, drone, helicopter
  const targetKeywords = ['tank', 'apc', 'personnel', 'artillery', 'drone',
    'helicopter', 'vehicle', 'destroyed', 'damaged', 'armored', 'infantry'];

  const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (targetKeywords.some(kw => lower.includes(kw))) {
      console.log('Potential kill data line:', line);
    }
  }

  // Take screenshot per unit
  await page.screenshot({
    path: `screenshot-${unitName.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.png`,
    fullPage: true
  });

  // Log all visible text blocks with numbers
  const numberedBlocks = await page.evaluate(() => {
    const all = [...document.querySelectorAll('*')];
    return all
      .filter(el => el.children.length === 0 && /\d/.test(el.innerText))
      .map(el => ({
        tag: el.tagName,
        classes: el.className,
        text: el.innerText.trim().slice(0, 200)
      }))
      .filter(el => el.text.length > 0)
      .slice(0, 50);
  });

  console.log('Numbered elements found:');
  numberedBlocks.forEach(b => console.log(`  [${b.tag}] "${b.text}" (${b.classes})`));

  return results;
}

// ── MAIN SCRAPE ───────────────────────────────────────────
async function scrape() {
  console.log(`Launching browser...`);

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
    // Load main page
    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    console.log('Main page loaded. Looking for unit links...');

    // Find all clickable unit links/buttons
    const unitLinks = await page.evaluate(() => {
      const links = [...document.querySelectorAll('a')];
      return links
        .map(a => ({ href: a.href, text: a.innerText.trim() }))
        .filter(l => l.href && l.text && l.href !== window.location.href)
        .slice(0, 30);
    });

    console.log('Unit links found:');
    unitLinks.forEach(l => console.log(`  "${l.text}" -> ${l.href}`));

    // Also log all buttons
    const buttons = await page.evaluate(() => {
      return [...document.querySelectorAll('button, [role="button"], [class*="btn"]')]
        .map(b => ({ text: b.innerText.trim(), classes: b.className }))
        .filter(b => b.text)
        .slice(0, 20);
    });
    console.log('Buttons found:');
    buttons.forEach(b => console.log(`  "${b.text}" (${b.classes})`));

    // Try clicking the first unit that looks like a brigade/regiment
    const unitKeywords = ['birds', 'achilles', 'rarog', 'k-2', 'fenix', 'nemesis',
      'hawks', 'svarog', 'raid', 'brigade', 'regiment', 'battalion'];

    let clicked = false;
    for (const link of unitLinks) {
      const lower = link.text.toLowerCase();
      if (unitKeywords.some(kw => lower.includes(kw))) {
        console.log(`\nClicking unit: "${link.text}" -> ${link.href}`);
        await page.goto(link.href, { waitUntil: 'networkidle', timeout: 30000 });
        const unitRows = await scrapeUnit(page, link.text);
        allRows.push(...unitRows);
        clicked = true;
        break; // just one unit for now to understand the structure
      }
    }

    if (!clicked) {
      console.log('No unit link clicked — scraping main page directly');
      await scrapeUnit(page, 'main');
    }

    await browser.close();
    return allRows;

  } catch (err) {
    console.error('Scrape error:', err.message);
    await page.screenshot({ path: 'error-screenshot.png' }).catch(() => {});
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
