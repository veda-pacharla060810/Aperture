# Aperture

"See what websites see." A privacy-transparency tool: paste a URL, and Aperture finds
that site's real privacy policy, sends it to Claude for analysis, and turns it into a
plain-language report.

This project has two parts:

- **`index.html`** — the whole frontend (single static file, no build step). Can be hosted
  anywhere static, e.g. GitHub Pages.
- **`server/`** — a small Node/Express backend. It fetches a site's homepage, locates its
  privacy policy, extracts the readable text, and asks the Claude API to analyze it. This
  needs somewhere that can run Node — GitHub Pages can't run it.

## Running the backend locally

```
cd server
npm install
cp .env.example .env
# edit .env and paste in your Anthropic API key (https://console.anthropic.com)
npm start
```

This starts the API on `http://localhost:3001`.

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
  host that runs Node — e.g. Render, Railway, Fly.io, or a small VPS. Set the
  `ANTHROPIC_API_KEY` environment variable there, and set `ALLOWED_ORIGIN` to your
  GitHub Pages URL so the API only accepts requests from your frontend.
- Once the backend is deployed, update the frontend's default `API_BASE` (or always
  link people to `index.html?api=https://your-backend-url`).

## How the analysis works

1. The backend fetches the target site's homepage and looks for a link to its privacy
   policy (falling back to a few common paths like `/privacy`, `/privacy-policy`).
2. It strips the HTML down to readable text.
3. That text is sent to Claude with a strict instruction to return a structured JSON
   analysis: a transparency score, per-category collection levels (Identity, Location,
   Device, Activity, Preferences), a data-flow map, two "digital afterlife" callouts,
   three legal→human translated clauses, and clarity/control sub-scores.
4. If no privacy policy can be found or the site can't be reached, the frontend shows
   the "No Access" screen with the real reason instead of a fabricated report.

Because the analysis is grounded in each site's actual published policy, results will
change if a site updates its policy, and two different sites will get genuinely
different reports (previously this was simulated locally in the browser; it's now the
real thing).

## Notes / limits

- Some sites block automated requests entirely, require JavaScript to render their
  policy page, or publish their policy as a PDF — in those cases Aperture will report
  it couldn't find enough public information rather than guessing.
- The in-memory cache in `server/index.js` is per-process and resets on restart; swap
  in Redis or a database if you need it to persist or scale across multiple instances.
- There's no rate limiting yet — add some (e.g. `express-rate-limit`) before exposing
  this publicly at scale, since every request costs an API call.
