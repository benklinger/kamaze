# כמה עולה? (Kamaze)

A daily Hebrew price-guessing game. Every morning a GitHub Action pulls real shelf prices
from Israeli supermarket price-transparency feeds (Shufersal, Rami Levy), picks a product of
the day and a 3-item basket, and publishes them to GitHub Pages. No manual work required.

**Play:** https://benklinger.github.io/kamaze/

## How it works

- `index.html`, `app.js`, `style.css` – static game (hash router: home, play, result, archive, stats).
  Results, streaks and stats live in the browser's `localStorage`. Share button copies a Wordle-style summary.
- `pipeline/build_day.py` – stdlib-only Python. Downloads today's `PriceFull` XML for one store,
  matches it against `pipeline/staples.json` (108 everyday products with photos) and
  `pipeline/baskets.json` (themed 3-item baskets), picks the day's items with a date-seeded RNG,
  builds slider ranges, downloads missing product photos from Open Food Facts into `images/`,
  and writes `data/days/YYYY-MM-DD.json` + `data/index.json`.
- `.github/workflows/daily.yml` – runs the pipeline every day at 04:45 UTC and commits the result.
  Chains alternate day by day; if one feed fails the other is used. If both fail the workflow fails
  and GitHub emails you.

## Run locally

```bash
python3 pipeline/build_day.py --chain shufersal --force   # build today's game
python3 -m http.server 8765                                # then open http://localhost:8765
```

## Manual rebuild

GitHub → Actions → "Build today's game" → Run workflow (optionally with a date and `force`).

## Adding products

Add `{ "barcode": "...", "name": "..." }` to `pipeline/staples.json` (the barcode must have a photo on
Open Food Facts, or drop a `images/<barcode>.jpg` in yourself) and, optionally, a basket to
`pipeline/baskets.json`.
