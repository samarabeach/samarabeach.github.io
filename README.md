# samarabeach.github.io

Personal website of Samara Beach, served by GitHub Pages at samarabea.ch.

- `index.html`, `research.html`: Home and Research
- `chart_portfolio.html`: Economic Chart Portfolio, the Economy page from Smardash
- `assets/site.css`: the Swiss grid look (light and dark), shared by every page
- `assets/economy.css`, `assets/economy.js`: chart styles and code, from Smardash
- `data/economy.json`: a saved copy of the FRED data the charts use
- `data/metro_series.json`: FRED series IDs for each metro area on the map
- `data/shapes/`: state and metro map shapes

## Updating the chart data

The page reads `data/economy.json`. A GitHub Action
(`.github/workflows/update-economy-data.yml`) refreshes it every Saturday and
commits it to `main`. To run it now, open the **Actions** tab, pick
**Update economy data**, and click **Run workflow**.

To refresh it by hand instead:

    python3 scripts/update_economy_data.py

It uses FRED's public CSV download, which needs **no API key**, and only the
Python standard library. It takes a minute or two. Commit and push
`data/economy.json` afterwards; the "Data from FRED as of" date on the page
updates by itself.

To add or change an indicator, edit the `INDICATORS` list in the script.
`data/metro_series.json` is built once from FRED's release tables; run with
`--refresh-metros` to rebuild it if BLS redraws metro areas.
