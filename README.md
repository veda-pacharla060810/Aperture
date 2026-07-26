# Aperture

"See what websites see." A privacy-transparency tool: paste a URL, and Aperture finds
that site's real, published privacy policy and turns it into a plain-language report.

**No AI model, no external API, no cost.** The analysis is done entirely with local
keyword and pattern matching over the actual fetched policy text — the same category
of technique used by readability checkers and rule-based text classifiers. There is
nothing to pay for and no API key of any kind to configure.

This project has two parts:

- **`index.html`** — the whole frontend (single static file, no build step). Can be
  hosted anywhere static, e.g. GitHub Pages.
- **`server/`** — a small Node/Express backend. It fetches a site's homepage, locates
  its privacy policy, extracts the readable text, and scores it locally. This needs
  somewhere that can run Node — GitHub Pages can't run it.

## Running the backend locally

```
cd server
npm install
npm start
```

That's it — no `.env` file or API key is required to run. This starts the API on
`http://localhost:3001`. (`.env.example` exists only for optional `PORT` /
`ALLOWED_ORIGIN` overrides.)

You can sanity-check it end to end with:

```
npm run smoketest
```

which spins the server up, hits it with a real domain, and prints the analysis.

## Running the frontend locally

Just open `index.html` in a browser. By default it talks to `http://localhost:3001`.
To point it at a different backend (e.g. once deployed), open it with a query string:

```
index.html?api=https://your-deployed-backend.example.com
```

Or edit the `API_BASE` fallback near the top of the `<script>` block in `index.html`.

## Deploying

- **Frontend**: push `index.html` to GitHub Pages (Settings → Pages → deploy from
  branch → root) as already set up in this repo.
- **Backend**: GitHub Pages only serves static files, so the `server/` folder needs a
  host that runs Node — e.g. Render, Railway, Fly.io, or a small VPS. No paid API is
  involved, so any free-tier Node host is enough. Set `ALLOWED_ORIGIN` there to your
  GitHub Pages URL so the API only accepts requests from your frontend.
- Once the backend is deployed, update the frontend's default `API_BASE` (or always
  link people to `index.html?api=https://your-backend-url`).

## How the analysis works

1. The backend fetches the target site's homepage and looks for a link to its privacy
   policy (falling back to a few common paths like `/privacy`, `/privacy-policy`).
2. It strips the HTML down to readable text.
3. That text is scanned locally against keyword lists:
   - **Category levels** (Identity, Location, Device, Activity, Preferences) — how
     many category-specific terms appear (e.g. "geolocation", "device identifier").
   - **Data-flow stages** — whether the text mentions analytics, third parties/service
     providers, or advertising partners at all.
   - **Transparency score** — boosted by concrete, rights-oriented language ("opt out",
     "delete your data", "GDPR", "retention period") and penalized by vague hedging
     ("may include", "at our discretion", "reasonable measures").
   - **Clarity** — a simple readability proxy based on average sentence length, further
     penalized by vague-language density.
   - **Control** — how much rights/choice language is present.
   - **Legal → Human translations** — a bank of common clause patterns (cookies, third-
     party sharing, retention, aggregated data, consent-by-use, policy changes,
     international transfer, security disclaimers, device/media access); whichever
     patterns are actually detected in the text are surfaced first.
4. If no privacy policy can be found or the site can't be reached, the frontend shows
   the "No Access" screen with the real reason instead of a fabricated report.

Because scoring is grounded in each site's actual published policy text, results
change if a site updates its policy, and different sites get genuinely different
reports.

## Notes / limits

- This is a rule-based approximation, not language understanding — it can't catch
  nuance, tone, or context the way reading the policy yourself (or an LLM) would. It's
  meant to give a fast, honest, zero-cost first read, not a legal audit.
- Some sites block automated requests entirely, require JavaScript to render their
  policy page, or publish their policy as a PDF — in those cases Aperture reports that
  it couldn't find enough public information rather than guessing.
- The in-memory cache in `server/index.js` is per-process and resets on restart; swap
  in Redis or a database if you need it to persist or scale across multiple instances.
- There's no rate limiting yet — consider adding `express-rate-limit` before exposing
  this publicly, since it makes outbound requests to whatever site is analyzed.
