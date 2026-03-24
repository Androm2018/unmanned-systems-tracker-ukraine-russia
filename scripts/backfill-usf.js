/**
 * USF 2025 Annual Scraper — Final Version
 * Scrapes https://sbs-group.army/en/subdivision/usf_grouping/?period=yearly_2025
 * and writes all data to UAV sheet.
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
  // Get existing rows, remove any old yearly_2025 entries, re-write
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TAB}!A:I`,
  });
  const allRows = existing.data.values || [];
  const keepRows = allRows.filter(r => r[0] !== 'yearly_2025');
  const headers = ['date','system','target','type','loc','outcome','notes','src','srcl'];
  const newData = [headers, ...keepRows.slice(1), ...rows];
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TAB}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: newData },
  });
  console.log(`Wrote ${rows.length} rows`);
}

function parseNum(str) {
  // Handle numbers with spaces: "167 920" -> 167920
  return parseInt((str || '').replace(/\s/g, ''), 10) || 0;
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

    // Print full page text for verification
    const fullText = await page.evaluate(() => document.body.innerText);
    console.log('\n=== FULL PAGE TEXT ===\n' + fullText.slice(0, 3000) + '\n=== END ===\n');

    // Extract using innerText of the whole page split into lines
    // This avoids all the hidden-span duplication issues
    const extracted = await page.evaluate(() => {
      // Use the rendered page text, split by newline
      const lines = document.body.innerText
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0);

      // Remove duplicates while preserving order (hidden spans cause duplication)
      const seen = new Set();
      const deduped = [];
      for (const line of lines) {
        if (!seen.has(line)) {
          seen.add(line);
          deduped.push(line);
        }
      }

      return deduped;
    });

    console.log('\n=== DEDUPED LINES ===');
    extracted.forEach((l, i) => console.log(`${i}: ${l}`));
    console.log('=== END ===\n');

    // Now parse lines into label/value pairs
    // Numbers may have spaces (e.g. "167 920") - treat consecutive digit+space+digit as one number
    const isNum = (s) => /^[\d\s]+$/.test(s) && /\d/.test(s);
    const toNum = (s) => parseInt(s.replace(/\s/g, ''), 10);

    // Summary section labels (value comes BEFORE label in page order)
    const summaryLabels = {
      'damaged targets':  'total_damaged',
      'incl. destroyed':  'total_destroyed',
      'strike flights':   'strike_flights',
      'recon flights':    'recon_flights',
      'enemy personnel':  'personnel_total',
      'including killed': 'personnel_killed',
      'incl. killed':     'personnel_killed',
      'incl. wounded':    'personnel_wounded',
    };

    // Category labels (two values follow: damaged, destroyed)
    const categoryLabels = [
      'Enemy personnel', 'Drone launch positions', 'Antennas', 'SAMs, SPADs',
      'Radars (system)', 'Radars (portable)', 'EW (system)', 'EW (car + portable)',
      'Enemy wings', 'Shaheds and Gerberas', 'Tanks', 'APCs, IFVs, ACVs',
      'Guns, howitzers', 'Self-propelled artillery', 'Mortars', 'MRLS',
      'Light, Heavy, Special-purpose vehicles', 'Motorcycles and military buggies',
      'Ammo, fuel and equipment depots', 'Strategic infrastructure',
      'Tactical infrastructure', 'Shelters', 'Dugouts', 'Network equipment',
      'Cameras', 'Enemy copter drones', 'Enemy unmanned robotic complexes', 'Other',
    ];
    const catSet = new Set(categoryLabels.map(c => c.toLowerCase()));

    const summary = {};
    const categories = {};
    const seenCats = new Set();

    for (let i = 0; i < extracted.length; i++) {
      const line = extracted[i];
      const lower = line.toLowerCase();

      // Summary label — look back for a number
      if (summaryLabels[lower]) {
        const key = summaryLabels[lower];
        if (!summary[key]) {
          // Look backward up to 3 lines for a number
          for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
            if (isNum(extracted[j])) {
              summary[key] = toNum(extracted[j]);
              break;
            }
          }
        }
        continue;
      }

      // Category label — look forward for two numbers
      if (catSet.has(lower) && !seenCats.has(lower)) {
        seenCats.add(lower);
        let damaged = null, destroyed = null, found = 0;
        for (let j = i + 1; j < Math.min(i + 10, extracted.length); j++) {
          if (isNum(extracted[j])) {
            if (found === 0) damaged   = toNum(extracted[j]);
            if (found === 1) destroyed = toNum(extracted[j]);
            found++;
            if (found >= 2) break;
          }
          if (catSet.has((extracted[j] || '').toLowerCase()) && found > 0) break;
        }
        if (damaged !== null) {
          categories[line] = { damaged, destroyed: destroyed || 0 };
        }
      }
    }

    console.log('\n=== SUMMARY ===');
    console.log(JSON.stringify(summary, null, 2));
    console.log('\n=== CATEGORIES ===');
    Object.entries(categories).forEach(([k, v]) => console.log(`${k}: damaged=${v.damaged} destroyed=${v.destroyed}`));

    // Build sheet rows
    const rows = [];
    const src = URL_2025;
    const srcl = 'USF Pidrakhuyka';
    const period = 'yearly_2025';

    // Summary headline rows
    const summaryItems = [
      { label: 'Total damaged targets',    type: 'Summary',    value: summary.total_damaged,       note: `Total targets damaged in 2025` },
      { label: 'Total destroyed targets',  type: 'Summary',    value: summary.total_destroyed,     note: `Total targets destroyed in 2025` },
      { label: 'Strike flights',           type: 'Operations', value: summary.strike_flights,       note: `Total strike flights in 2025` },
      { label: 'Recon flights',            type: 'Operations', value: summary.recon_flights,        note: `Total reconnaissance flights in 2025` },
      { label: 'Enemy personnel hit',      type: 'Personnel',  value: summary.personnel_total,     note: `Total enemy personnel hit in 2025` },
      { label: 'Enemy personnel killed',   type: 'Personnel',  value: summary.personnel_killed,    note: `Enemy personnel confirmed killed in 2025` },
      { label: 'Enemy personnel wounded',  type: 'Personnel',  value: summary.personnel_wounded,   note: `Enemy personnel wounded in 2025` },
    ];

    for (const item of summaryItems) {
      if (!item.value) continue;
      rows.push([
        period, 'FPV / UAV (USF)', item.label, item.type,
        'Eastern Front', String(item.value), `2025 Annual Total. ${item.note}.`, src, srcl,
      ]);
    }

    // Category detail rows
    for (const [label, vals] of Object.entries(categories)) {
      if (vals.damaged === 0 && vals.destroyed === 0) continue;
      const outcome = vals.destroyed > 0
        ? `${vals.destroyed} destroyed, ${vals.damaged} damaged`
        : `${vals.damaged} damaged`;
      rows.push([
        period, 'FPV / UAV (USF)', label, categorise(label),
        'Eastern Front', outcome,
        `2025 Annual Total. Damaged: ${vals.damaged}. Destroyed: ${vals.destroyed}.`,
        src, srcl,
      ]);
    }

    console.log(`\nTotal rows to write: ${rows.length}`);
    await browser.close();

    if (rows.length === 0) {
      console.log('No rows extracted — see page text above');
      return;
    }

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
