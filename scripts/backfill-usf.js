/**
 * USF 2025 Annual Scraper — Final Correct Version
 * Parses the page text directly from the full text output.
 * Numbers with spaces (e.g. "3 949") are treated as single numbers.
 */

const { chromium } = require('@playwright/test');
const { google }   = require('googleapis');

const URL_2025       = 'https://sbs-group.army/en/subdivision/usf_grouping/?period=yearly_2025';
const SHEET_TAB      = 'UAV';
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

async function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function writeRows(sheets, rows) {
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID, range: `${SHEET_TAB}!A:I`,
  });
  const allRows = existing.data.values || [];
  const keepRows = allRows.filter(r => r[0] !== 'yearly_2025');
  const headers = ['date','system','target','type','loc','outcome','notes','src','srcl'];
  const newData = [headers, ...keepRows.slice(1), ...rows];
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID, range: `${SHEET_TAB}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: newData },
  });
  console.log(`Wrote ${rows.length} rows to sheet`);
}

function toNum(s) {
  return parseInt((s || '').replace(/\s/g, ''), 10) || 0;
}

function isNumLine(s) {
  // Matches lines that are purely digits and spaces e.g. "3 949" or "54082"
  return /^[\d\s]+$/.test(s.trim()) && /\d/.test(s);
}

function categorise(label) {
  const c = label.toLowerCase();
  if (c.includes('personnel') || c.includes('killed') || c.includes('wounded')) return 'Personnel';
  if (c.includes('tank') || c.includes('apc') || c.includes('ifv') || c.includes('acv')) return 'Tank / AFV';
  if (c.includes('artillery') || c.includes('gun') || c.includes('howitzer') || c.includes('mortar') || c.includes('mrls')) return 'Artillery';
  if (c.includes('sam') || c.includes('spad') || c.includes('radar') || c.includes('ew')) return 'Air defence';
  if (c.includes('shahed') || c.includes('gerbera') || c.includes('wing') || c.includes('copter') || c.includes('drone') || c.includes('launch')) return 'Drone / Aircraft';
  if (c.includes('vehicle') || c.includes('motorcycle') || c.includes('buggy')) return 'Logistics';
  if (c.includes('depot') || c.includes('ammo') || c.includes('fuel')) return 'Logistics';
  if (c.includes('shelter') || c.includes('dugout') || c.includes('infrastructure')) return 'Fortification';
  if (c.includes('antenna') || c.includes('network') || c.includes('camera')) return 'Electronics';
  if (c.includes('flight')) return 'Operations';
  return 'Summary';
}

async function main() {
  if (!SPREADSHEET_ID) throw new Error('SPREADSHEET_ID not set');
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');

  console.log('Launching browser...');
  const browser = await chromium.launch({
    headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US', viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  try {
    console.log(`Loading: ${URL_2025}`);
    await page.goto(URL_2025, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(4000);

    const gotIt = page.locator('button:has-text("Got it")');
    if (await gotIt.isVisible().catch(() => false)) { await gotIt.click(); await page.waitForTimeout(500); }

    const fullText = await page.evaluate(() => document.body.innerText);
    console.log('\n=== FULL PAGE TEXT ===\n' + fullText + '\n=== END ===\n');

    // ── Parse the page text directly ─────────────────────
    // Split into lines, deduplicate, then parse sequentially
    const rawLines = fullText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    // Deduplicate lines while preserving order
    const seen = new Set();
    const lines = [];
    for (const l of rawLines) {
      if (!seen.has(l)) { seen.add(l); lines.push(l); }
    }

    console.log('\n=== DEDUPED LINES ===');
    lines.forEach((l, i) => console.log(`${i.toString().padStart(3)}: ${l}`));
    console.log('=== END ===\n');

    // ── Known structure from page text ───────────────────
    // Summary section (number BEFORE label):
    //   "167 920" → "damaged targets"
    //   "54 082"  → "incl. destroyed"
    //   "427 328" → "strike flights"
    //   "404 705" → "recon flights"
    //   "50 238"  → "enemy personnel"
    //   "28 577"  → "including killed"
    //   "21 661"  → "incl. wounded"
    //
    // Category section (label THEN two numbers):
    //   "Enemy personnel" → "50 238" → "28 577"
    //   "Drone launch positions" → "3 949" → "192"
    //   etc.

    const SUMMARY_LABELS = new Map([
      ['damaged targets',  'Total damaged targets'],
      ['incl. destroyed',  'Total destroyed targets'],
      ['strike flights',   'Strike flights'],
      ['recon flights',    'Recon flights'],
      ['enemy personnel',  'Enemy personnel hit'],
      ['including killed', 'Enemy personnel killed'],
      ['incl. killed',     'Enemy personnel killed'],
      ['incl. wounded',    'Enemy personnel wounded'],
    ]);

    const CATEGORY_LABELS = new Set([
      'enemy personnel', 'drone launch positions', 'antennas', 'sams, spads',
      'radars (system)', 'radars (portable)', 'ew (system)', 'ew (car + portable)',
      'enemy wings', 'shaheds and gerberas', 'tanks', 'apcs, ifvs, acvs',
      'guns, howitzers', 'self-propelled artillery', 'mortars', 'mrls',
      'light, heavy, special-purpose vehicles', 'motorcycles and military buggies',
      'ammo, fuel and equipment depots', 'strategic infrastructure',
      'tactical infrastructure', 'shelters', 'dugouts', 'network equipment',
      'cameras', 'enemy copter drones', 'enemy unmanned robotic complexes', 'other',
    ]);

    const results = {};
    const seenLabels = new Set();

    for (let i = 0; i < lines.length; i++) {
      const line  = lines[i];
      const lower = line.toLowerCase();
      const prev  = i > 0 ? lines[i - 1] : '';

      // ── Summary: number appears on line before label ──
      if (SUMMARY_LABELS.has(lower) && isNumLine(prev)) {
        const key = SUMMARY_LABELS.get(lower);
        if (!results[key]) {
          results[key] = { type: 'summary', value: toNum(prev) };
          console.log(`  Summary: "${key}" = ${toNum(prev)}`);
        }
        continue;
      }

      // ── Category: label followed by two numbers ───────
      if (CATEGORY_LABELS.has(lower) && !seenLabels.has(lower)) {
        seenLabels.add(lower);

        // Collect the next number lines (skip non-numbers)
        const nums = [];
        for (let j = i + 1; j < Math.min(i + 8, lines.length) && nums.length < 2; j++) {
          const next = lines[j];
          if (isNumLine(next)) {
            nums.push(toNum(next));
          } else if (CATEGORY_LABELS.has(next.toLowerCase()) || SUMMARY_LABELS.has(next.toLowerCase())) {
            break; // hit another label, stop
          }
          // skip non-numeric, non-label lines (like "damaged", "incl. destroyed" headers)
        }

        const damaged   = nums[0] || 0;
        const destroyed = nums[1] || 0;
        results[line] = { type: 'category', damaged, destroyed };
        console.log(`  Category: "${line}" → damaged=${damaged}, destroyed=${destroyed}`);
      }
    }

    console.log('\n=== ALL RESULTS ===');
    console.log(JSON.stringify(results, null, 2));

    // ── Build sheet rows ──────────────────────────────────
    const rows = [];
    const period = 'yearly_2025';
    const src    = URL_2025;
    const srcl   = 'USF Pidrakhuyka';

    for (const [label, data] of Object.entries(results)) {
      if (data.type === 'summary') {
        rows.push([
          period, 'FPV / UAV (USF)', label, categorise(label),
          'Eastern Front', String(data.value),
          `2025 Annual Total (Jun–Dec 2025). ${label}: ${data.value}.`,
          src, srcl,
        ]);
      } else {
        if (data.damaged === 0 && data.destroyed === 0) continue;
        const outcome = data.destroyed > 0
          ? `${data.destroyed} destroyed, ${data.damaged} damaged`
          : `${data.damaged} damaged`;
        rows.push([
          period, 'FPV / UAV (USF)', label, categorise(label),
          'Eastern Front', outcome,
          `2025 Annual Total (Jun–Dec 2025). Damaged: ${data.damaged}. Destroyed: ${data.destroyed}.`,
          src, srcl,
        ]);
      }
    }

    console.log(`\nBuilt ${rows.length} rows`);
    await browser.close();

    if (!rows.length) { console.log('No rows — check output above'); return; }

    const sheets = await getSheetsClient();
    await writeRows(sheets, rows);
    console.log('Done!');

  } catch (err) {
    console.error('Error:', err.message);
    await page.screenshot({ path: 'error.png' }).catch(() => {});
    await browser.close();
    throw err;
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
