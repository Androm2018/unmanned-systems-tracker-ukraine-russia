/**
 * USF 2025 Annual Scraper
 * Scrapes https://sbs-group.army/en/subdivision/usf_grouping/?period=yearly_2025
 * and writes ALL label+number pairs to the UAV sheet.
 */

const { chromium } = require('@playwright/test');
const { google }   = require('googleapis');

const URL_2025       = 'https://sbs-group.army/en/subdivision/usf_grouping/?period=yearly_2025';
const SHEET_TAB      = 'UAV';
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// ── SHEETS ────────────────────────────────────────────────
async function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function writeRows(sheets, rows) {
  // Clear existing yearly_2025 rows first
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TAB}!A:I`,
  });
  const allRows = existing.data.values || [];
  
  // Find rows that are NOT yearly_2025 to keep
  const keepRows = allRows.filter(r => r[0] !== 'yearly_2025');
  
  // Rewrite sheet with headers + kept rows + new rows
  const headers = ['date','system','target','type','loc','outcome','notes','src','srcl'];
  const newData = [headers, ...keepRows.slice(1), ...rows];
  
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TAB}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: newData },
  });
  console.log(`Wrote ${rows.length} yearly_2025 rows`);
}

function categoriseTarget(label) {
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
    console.log(`Loading: ${URL_2025}`);
    await page.goto(URL_2025, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(4000);

    // Dismiss cookie banner
    const gotIt = page.locator('button:has-text("Got it")');
    if (await gotIt.isVisible().catch(() => false)) {
      await gotIt.click();
      await page.waitForTimeout(500);
    }

    // Log full page text so we can see what's there
    const fullText = await page.evaluate(() => document.body.innerText);
    console.log('\n=== FULL PAGE TEXT ===');
    console.log(fullText);
    console.log('=== END ===\n');

    // Strategy: read ALL span text in document order.
    // The page structure is: label span followed by two number spans (damaged, destroyed)
    // We collect every (label, num1, num2) triplet we can find.
    const allData = await page.evaluate(() => {
      const spans = [...document.querySelectorAll('span')];
      const texts = spans.map(s => (s.innerText || '').trim()).filter(t => t.length > 0);
      
      const results = [];
      const numericLabels = new Set([
        'damaged targets', 'incl. destroyed', 'strike flights', 'recon flights',
        'enemy personnel', 'including killed', 'incl. killed', 'incl. wounded',
      ]);

      // Walk through all spans looking for patterns
      for (let i = 0; i < texts.length; i++) {
        const t = texts[i];
        
        // Skip clock digits, dates, etc.
        if (/^\d{1,2}$/.test(t) && texts[i+1] === ':') continue; // clock
        if (/^\d{2}\.\d{2}\.\d{4}$/.test(t)) continue; // date
        if (t === ':') continue;
        
        // Is this a label we know?
        const lower = t.toLowerCase();
        if (numericLabels.has(lower)) {
          // Find the number before this label
          const prevNum = texts[i-1];
          if (/^\d+$/.test(prevNum)) {
            results.push({ label: t, value: parseInt(prevNum, 10) });
          }
          continue;
        }

        // Is this a category label followed by two numbers?
        const militaryTerms = [
          'enemy personnel', 'drone launch positions', 'antennas', 'sams, spads',
          'radars (system)', 'radars (portable)', 'ew (system)', 'ew (car + portable)',
          'enemy wings', 'shaheds and gerberas', 'tanks', 'apcs, ifvs, acvs',
          'guns, howitzers', 'self-propelled artillery', 'mortars', 'mrls',
          'light, heavy, special-purpose vehicles', 'motorcycles and military buggies',
          'ammo, fuel and equipment depots', 'strategic infrastructure',
          'tactical infrastructure', 'shelters', 'dugouts', 'network equipment',
          'cameras', 'enemy copter drones', 'enemy unmanned robotic complexes', 'other'
        ];
        
        if (militaryTerms.includes(lower)) {
          // Look ahead for two numbers
          let damaged = null, destroyed = null, numsFound = 0;
          for (let j = i + 1; j < Math.min(i + 20, texts.length); j++) {
            if (/^\d+$/.test(texts[j])) {
              if (numsFound === 0) damaged   = parseInt(texts[j], 10);
              if (numsFound === 1) destroyed = parseInt(texts[j], 10);
              numsFound++;
              if (numsFound >= 2) break;
            }
            // Stop if we hit another category
            if (militaryTerms.includes((texts[j] || '').toLowerCase()) && numsFound > 0) break;
          }
          if (damaged !== null) {
            results.push({ label: t, damaged, destroyed: destroyed || 0 });
          }
        }
      }
      
      return results;
    });

    console.log('\n=== EXTRACTED DATA ===');
    allData.forEach(d => console.log(JSON.stringify(d)));
    console.log(`=== ${allData.length} items ===\n`);

    // Convert to sheet rows
    const rows = [];
    for (const item of allData) {
      if (item.damaged !== undefined) {
        // Category row with damaged/destroyed
        const outcome = item.destroyed > 0
          ? `${item.destroyed} destroyed, ${item.damaged} damaged`
          : `${item.damaged} damaged`;
        rows.push([
          'yearly_2025',
          'FPV / UAV (USF)',
          item.label,
          categoriseTarget(item.label),
          'Eastern Front',
          outcome,
          `2025 Annual Total. Damaged: ${item.damaged}. Destroyed: ${item.destroyed}.`,
          URL_2025,
          'USF Pidrakhuyka',
        ]);
      } else if (item.value !== undefined) {
        // Summary stat row
        rows.push([
          'yearly_2025',
          'FPV / UAV (USF)',
          item.label,
          categoriseTarget(item.label),
          'Eastern Front',
          String(item.value),
          `2025 Annual Total. Value: ${item.value}.`,
          URL_2025,
          'USF Pidrakhuyka',
        ]);
      }
    }

    console.log(`Built ${rows.length} sheet rows`);

    await browser.close();

    if (rows.length === 0) {
      console.log('No rows to write — check page text above for structure');
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

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
