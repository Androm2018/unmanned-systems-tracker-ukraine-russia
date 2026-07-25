# Ukraine War Unmanned Systems Tracker

**Live site:** [unmannedsystemstracker.com](https://unmannedsystemstracker.com)

Open-source database tracking drone warfare, USV strikes, UGV operations, and Russian losses in Ukraine. Original analysis by a King's College London War Studies researcher.

---

## What this is

A public OSINT intelligence product tracking unmanned systems and related data from the Russia-Ukraine war since 2022. The tracker covers:

- **USV Strikes** — Ukrainian Unmanned Surface Vehicle operations against Russian naval assets in the Black Sea
- **UGV Operations** — Ground robot combat missions logged via Ukraine's DELTA battlefield management system
- **UAV Kill Board** — USF Pidrakhuyka-verified FPV strike flights, personnel hits, and vehicle destructions
- **Air Defence** — 100,000+ aerial attacks on Ukraine tracked by weapon type, with daily auto-updating
- **Russian Losses & Advance** — Confirmed KIA (Mediazona/BBC), equipment losses (Oryx), and territorial advance (Black Bird Group / DeepState)
- **Original Analyses** — Six data-driven research analyses on interception rates, saturation thresholds, targeting doctrine, and more
- **Deep Strike Research** — Password-protected working research on Ukrainian long-range corridor analysis and Logistics Lockdown campaign

---

## Stack

```
GitHub Pages (static hosting)
    ↓
Cloudflare CDN (caching + security)
    ↓
Google Apps Script (API proxy, 6-hour cache)
    ↓
Google Sheets (data backend)
```

- **Frontend:** Single-page application — `index.html` with vanilla JavaScript
- **Charts:** Chart.js 4.4
- **Fonts:** Syne, DM Mono, DM Sans, Barlow Condensed, Share Tech Mono
- **Air defence data:** Auto-updates daily via Apps Script fetching the Petro Ivaniuk Kaggle dataset
- **Deployment:** GitHub Actions on push to main

---

## Data sources

| Dataset | Source | Update cadence |
|---|---|---|
| UAV kill board | USF Pidrakhuyka | Manual — quarterly |
| Air defence | Petro Ivaniuk / Ukrainian Air Force | Daily (automated) |
| Territorial advance | Black Bird Group / DeepState | Manual — quarterly |
| Russian KIA | Mediazona / BBC News | Manual — as published |
| Equipment losses | Oryx | Manual — as published |
| USV/UGV events | Compiled from OSINT sources | Manual — ongoing |

---

## Repository structure

```
/
├── index.html              # Main single-page application
├── Code.gs                 # Google Apps Script (API proxy + LockService)
├── LICENSE.md              # CC BY-NC 4.0
├── sitemap.xml
├── explainer/
│   └── index.html          # Plain-language guide to UAVs, FPVs, USVs, UGVs
├── usv-strikes/
│   └── index.html          # SEO landing page
├── ugv-operations/
│   └── index.html
├── air-defence/
│   └── index.html
├── uav-strikes/
│   └── index.html
├── russian-losses/
│   └── index.html
├── analyses/
│   └── index.html
└── about/
    └── index.html
```

---

## License

This work is licensed under **Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)**.

You are free to share and adapt this material for non-commercial purposes with attribution. Commercial use requires explicit written permission.

**What you can copyright:** Original code, analyses, curation methodology, and written content.  
**What you cannot:** Raw third-party data (Ukrainian Air Force figures, Mediazona counts, Oryx entries) — these remain subject to their originators' terms.

See [LICENSE.md](LICENSE.md) for full terms.

---

## About the author

**Andro Mathewson** — PhD Candidate in War Studies, King's College London. Dissertation: *The Strategic Impact of Emerging Military Technologies*. Junior Associate Fellow, NATO Defense College. 2024 Bellingcat Tech Fellow. Project Manager, Center for Information Resilience.

Published in: Bellingcat · Military Times · Modern War Institute at West Point · Bulletin of the Atomic Scientists · The National Interest · Wavell Room

**Contact & media enquiries:** [unmannedsystemstracker.com/#sources](https://unmannedsystemstracker.com/#sources)

---

## Disclaimer

Data compiled from public open-source intelligence. Not affiliated with any government or military organisation. Provided for research and educational purposes. All entries carry source citations for independent verification.
