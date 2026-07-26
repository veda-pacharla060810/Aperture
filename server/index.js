import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import * as cheerio from 'cheerio';

const PORT = process.env.PORT || 3001;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const CLAUDE_MODEL = 'claude-sonnet-4-6';

const CATEGORY_NAMES = ['Identity', 'Location', 'Device', 'Activity', 'Preferences'];
const STAGE_NAMES = ['User', 'Website', 'Analytics', 'Service Providers', 'Advertising / Partners'];

const CANDIDATE_PATHS = [
  '/privacy', '/privacy-policy', '/privacy-notice', '/legal/privacy',
  '/policies/privacy', '/about/privacy', '/privacy.html', '/en/privacy'
];

const FETCH_TIMEOUT_MS = 9000;
const MAX_POLICY_CHARS = 14000;

// simple in-memory cache so re-analyzing the same domain in one server
// session doesn't re-spend API calls
const cache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 30;

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN.split(',') }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'aperture-server' });
});

app.post('/api/analyze', async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'server_misconfigured', message: 'ANTHROPIC_API_KEY is not set on the server.' });
    }

    const rawUrl = (req.body && req.body.url || '').trim();
    if (!rawUrl) {
      return res.status(400).json({ error: 'missing_url', message: 'No URL was provided.' });
    }

    let target;
    try {
      target = normalizeUrl(rawUrl);
    } catch (e) {
      return res.status(400).json({ error: 'invalid_url', message: 'That does not look like a valid website address.' });
    }

    const cacheKey = target.hostname;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
      return res.json(cached.data);
    }

    // 1. fetch homepage
    const home = await fetchText(target.toString());
    if (!home) {
      return res.status(200).json({ error: 'unreachable', message: "We couldn't reach this website. It may be down, blocking automated requests, or the address may be incorrect." });
    }

    // 2. find the privacy policy
    let policyUrl = findPolicyLink(home, target.toString());
    let policyHtml = null;

    if (policyUrl) {
      policyHtml = await fetchText(policyUrl);
    }
    if (!policyHtml) {
      for (const path of CANDIDATE_PATHS) {
        const candidate = new URL(path, target.origin).toString();
        const html = await fetchText(candidate);
        if (html && looksLikePolicy(html)) {
          policyUrl = candidate;
          policyHtml = html;
          break;
        }
      }
    }

    if (!policyHtml) {
      return res.status(200).json({ error: 'not_found', message: "We couldn't find a published privacy policy or cookie notice on this site." });
    }

    const policyText = extractReadableText(policyHtml, MAX_POLICY_CHARS);
    if (!policyText || policyText.length < 200) {
      return res.status(200).json({ error: 'not_found', message: "This site links to a privacy policy, but it didn't contain enough readable text to analyze." });
    }

    // 3. analyze with Claude
    const analysis = await analyzeWithClaude(target.hostname, policyText);
    const result = { url: target.hostname, policyUrl, ...analysis };

    cache.set(cacheKey, { data: result, time: Date.now() });
    return res.json(result);
  } catch (err) {
    console.error('analyze error:', err);
    return res.status(200).json({ error: 'analysis_failed', message: "Something went wrong while analyzing this site's policy. Please try again." });
  }
});

app.listen(PORT, () => {
  console.log(`Aperture server listening on http://localhost:${PORT}`);
  if (!ANTHROPIC_API_KEY) {
    console.warn('WARNING: ANTHROPIC_API_KEY is not set. Requests to /api/analyze will fail until it is configured in .env');
  }
});

// ---------------- helpers ----------------

function normalizeUrl(raw) {
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  if (!/^https?:$/.test(u.protocol)) throw new Error('bad protocol');
  return u;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ApertureBot/1.0; +https://github.com/veda-pacharla060810/Aperture)',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
    if (!resp.ok) return null;
    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain') && contentType !== '') {
      return null;
    }
    return await resp.text();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function findPolicyLink(html, baseUrl) {
  try {
    const $ = cheerio.load(html);
    const candidates = [];
    $('a').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const text = ($(el).text() || '').trim().toLowerCase();
      const hrefLower = href.toLowerCase();
      const isPrivacy = /privacy/.test(text) || /privacy/.test(hrefLower);
      const isCookie = /cookie/.test(text) || /cookie/.test(hrefLower);
      if (isPrivacy || isCookie) {
        let abs;
        try { abs = new URL(href, baseUrl).toString(); } catch { return; }
        candidates.push({ abs, score: isPrivacy ? 2 : 1 });
      }
    });
    candidates.sort((a, b) => b.score - a.score);
    return candidates.length ? candidates[0].abs : null;
  } catch (e) {
    return null;
  }
}

function looksLikePolicy(html) {
  const lower = html.toLowerCase();
  return lower.includes('privacy') && (lower.includes('collect') || lower.includes('personal information') || lower.includes('data'));
}

function extractReadableText(html, maxChars) {
  try {
    const $ = cheerio.load(html);
    $('script, style, noscript, header, footer, nav, svg').remove();
    let text = $('body').text() || '';
    text = text.replace(/\s+/g, ' ').trim();
    return text.slice(0, maxChars);
  } catch (e) {
    return '';
  }
}

async function analyzeWithClaude(hostname, policyText) {
  const systemPrompt = `You are a privacy-policy analyst for a product called Aperture. You will be given the raw extracted text of a website's privacy policy (or related legal disclosure) and the site's domain.

Analyze the text and respond with ONLY a single JSON object — no markdown code fences, no commentary before or after — matching exactly this shape:

{
  "score": <integer 0-100, how clearly and specifically the policy discloses its actual data practices>,
  "descriptor": <one plain-language sentence describing the overall transparency level>,
  "categories": [
    {"name": "Identity", "level": "Low"|"Moderate"|"High"},
    {"name": "Location", "level": "Low"|"Moderate"|"High"},
    {"name": "Device", "level": "Low"|"Moderate"|"High"},
    {"name": "Activity", "level": "Low"|"Moderate"|"High"},
    {"name": "Preferences", "level": "Low"|"Moderate"|"High"}
  ],
  "stages": <array chosen only from this ordered list: ["User","Website","Analytics","Service Providers","Advertising / Partners"]. Always include "User" and "Website" first. Include later stages only if the text discloses that data actually flows there>,
  "afterlife": <array of exactly 2 objects, each {"name": one of the 5 category names above (pick the ones judged most sensitive or persistent given the text), "why": short phrase for why it's collected, "consideration": one sentence on the long-term implication}>,
  "translations": <array of exactly 3 objects, each {"legal": a short paraphrase under 20 words representative of a clause actually present in the text (do not copy verbatim, restate in your own words), "human": a plain-language translation of that clause}>,
  "clarity": <integer 0-100, how easy the policy is to read and understand>,
  "control": <integer 0-100, how much real choice or control the policy gives users over their own data>
}

Base every field only on what the provided text actually supports. Do not invent specifics that are not in the text. If a category is not discussed at all, mark its level "Low" rather than fabricating detail. Never reproduce long verbatim passages from the source text — always paraphrase.`;

  const userMessage = `Site: ${hostname}\n\nExtracted privacy policy text:\n${policyText}`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Claude API error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('No text content in Claude response');

  const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error('Could not parse Claude response as JSON');
  }

  return normalizeAnalysis(parsed);
}

function normalizeAnalysis(parsed) {
  const score = clampInt(parsed.score, 0, 100, 50);
  const clarity = clampInt(parsed.clarity, 0, 100, score);
  const control = clampInt(parsed.control, 0, 100, Math.max(0, score - 15));

  let categories = Array.isArray(parsed.categories) ? parsed.categories : [];
  categories = CATEGORY_NAMES.map((name) => {
    const found = categories.find((c) => c && c.name === name);
    const level = found && ['Low', 'Moderate', 'High'].includes(found.level) ? found.level : 'Low';
    return { name, level };
  });

  let stages = Array.isArray(parsed.stages) ? parsed.stages.filter((s) => STAGE_NAMES.includes(s)) : [];
  if (!stages.includes('User')) stages.unshift('User');
  if (!stages.includes('Website')) stages.splice(1, 0, 'Website');
  stages = STAGE_NAMES.filter((s) => stages.includes(s));
  if (stages.length < 2) stages = ['User', 'Website'];

  let afterlife = Array.isArray(parsed.afterlife) ? parsed.afterlife.slice(0, 2) : [];
  afterlife = afterlife.map((a) => ({
    name: CATEGORY_NAMES.includes(a && a.name) ? a.name : 'Identity',
    why: (a && a.why) || 'Not specified by the policy',
    consideration: (a && a.consideration) || 'This data may persist beyond a single visit.'
  }));
  while (afterlife.length < 2) {
    afterlife.push({ name: 'Identity', why: 'Account access', consideration: 'May remain connected to your digital identity.' });
  }

  let translations = Array.isArray(parsed.translations) ? parsed.translations.slice(0, 3) : [];
  translations = translations.map((t) => ({
    legal: (t && t.legal) || 'Policy language on this point was unclear.',
    human: (t && t.human) || 'This point was not stated plainly enough to translate confidently.'
  }));
  while (translations.length < 3) {
    translations.push({ legal: 'No further specific clauses were clearly extractable.', human: 'The policy did not go into more detail here.' });
  }

  return {
    score,
    descriptor: typeof parsed.descriptor === 'string' ? parsed.descriptor : 'This site\'s transparency could not be fully characterized.',
    categories,
    stages,
    afterlife,
    translations,
    clarity,
    control
  };
}

function clampInt(n, lo, hi, fallback) {
  const v = Math.round(Number(n));
  if (Number.isNaN(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
}
