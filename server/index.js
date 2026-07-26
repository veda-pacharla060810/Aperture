import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import * as cheerio from 'cheerio';

const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const CATEGORY_NAMES = ['Identity', 'Location', 'Device', 'Activity', 'Preferences'];

const CANDIDATE_PATHS = [
  '/privacy', '/privacy-policy', '/privacy-notice', '/legal/privacy',
  '/policies/privacy', '/about/privacy', '/privacy.html', '/en/privacy'
];

const FETCH_TIMEOUT_MS = 9000;
const MAX_POLICY_CHARS = 20000;

// in-memory cache so re-analyzing the same domain doesn't re-fetch every time
const cache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 30;

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN.split(',') }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'aperture-server', engine: 'heuristic (no AI, no external API calls)' });
});

app.post('/api/analyze', async (req, res) => {
  try {
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

    // 3. analyze — pure keyword/pattern rules over the real policy text. No AI, no external API call.
    const analysis = heuristicAnalyze(policyText);
    const result = { url: target.hostname, policyUrl, engine: 'heuristic', ...analysis };

    cache.set(cacheKey, { data: result, time: Date.now() });
    return res.json(result);
  } catch (err) {
    console.error('analyze error:', err);
    return res.status(200).json({ error: 'analysis_failed', message: "Something went wrong while analyzing this site's policy. Please try again." });
  }
});

app.listen(PORT, () => {
  console.log(`Aperture server listening on http://localhost:${PORT}`);
  console.log('Analysis engine: local keyword/pattern heuristic — no AI model, no external API calls, no cost.');
});

// ---------------- fetching + text extraction ----------------

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

// ---------------- heuristic analyzer (no AI, no external API, all local) ----------------
//
// This reads the real, fetched policy text and scores it with plain keyword and
// pattern matching — the same category of technique used by readability checkers
// and keyword-based text classifiers. It won't catch nuance the way a language
// model would, but every number it produces is derived directly and deterministically
// from that site's actual policy text, with no model call and no cost.

const CATEGORY_KEYWORDS = {
  Identity: ['name', 'email', 'account', 'sign up', 'sign-up', 'username', 'identify you', 'personal information', 'date of birth', 'phone number', 'full name'],
  Location: ['location', 'gps', 'geolocat', 'ip address', 'zip code', 'postal code', 'your region', 'your city'],
  Device: ['device', 'browser', 'operating system', 'device identifier', 'advertising id', 'device information', 'mac address', 'ip address'],
  Activity: ['browsing', 'usage data', 'log data', 'clickstream', 'pages you visit', 'interactions', 'analytics', 'activity on our', 'session', 'search queries'],
  Preferences: ['preferences', 'personalization', 'personalisation', 'your interests', 'settings', 'recommendation', 'favorite']
};

const STAGE_KEYWORDS = {
  Analytics: ['analytics', 'google analytics', 'usage statistics', 'measurement partners'],
  'Service Providers': ['third party', 'third-party', 'service provider', 'vendors', 'processors', 'business partners'],
  'Advertising / Partners': ['advertis', 'marketing partner', 'ad network', 'ad partner', 'advertising partners']
};

const POSITIVE_INDICATORS = [
  'opt out', 'opt-out', 'unsubscribe', 'delete your data', 'delete your account', 'right to access',
  'right to delete', 'do not sell', 'gdpr', 'ccpa', 'data protection officer', 'retention period',
  'contact us at', 'privacy@', 'your rights', 'request a copy', 'export your data'
];
const VAGUE_INDICATORS = [
  'may include', 'may share', 'at our discretion', 'from time to time', 'as necessary',
  'reasonable measures', 'without limitation', 'among other things', 'subject to change',
  'business purposes', 'legitimate interest'
];

const TRIGGER_BANK = [
  { keywords: ['personaliz', 'customi'], legal: 'The policy states information may be used for personalization.', human: 'This may mean your activity is used to customize what you see.' },
  { keywords: ['third part', 'third-part'], legal: 'The policy discloses that data may be shared with third parties.', human: 'Your information can be passed to outside companies the site works with.' },
  { keywords: ['retain', 'retention'], legal: 'The policy mentions a data retention practice.', human: 'Some of your data can be kept for a while — or indefinitely — after you stop using the site.' },
  { keywords: ['cookie'], legal: 'The policy discusses the use of cookies or similar tracking technologies.', human: 'Small trackers follow what you do on the site, sometimes across other sites too.' },
  { keywords: ['aggregat', 'de-identif', 'deidentif', 'anonymiz'], legal: 'The policy allows sharing of aggregated or de-identified data.', human: "Your data can be bundled with others' and shared freely, even without your name attached." },
  { keywords: ['consent', 'by using our', 'by using the service'], legal: 'The policy treats continued use of the site as consent.', human: 'Just visiting the site counts as agreeing, whether you read this or not.' },
  { keywords: ['update this policy', 'change this policy', 'modify this policy', 'without notice'], legal: 'The policy reserves the right to change without direct notice.', human: 'The rules can change later, and you may not be told when they do.' },
  { keywords: ['other countries', 'international transfer', 'transferred internationally', 'cross-border', 'cross border'], legal: 'The policy discloses that data may be processed in other countries.', human: 'Your data might leave your country, where different privacy laws may apply.' },
  { keywords: ['reasonable measures', 'reasonable security', 'commercially reasonable'], legal: 'The policy commits only to "reasonable" security measures.', human: "There's no guarantee of security here — just an effort, not a promise." },
  { keywords: ['contacts', 'microphone', 'camera', 'media library', 'photo library'], legal: 'The policy mentions access to device contacts or media.', human: "Certain features won't work unless you let the site into parts of your device beyond what's needed." }
];

const AFTERLIFE_WHY = {
  Identity: 'Account creation & sign-in access',
  Location: 'Location-based features',
  Device: 'Fraud prevention & device recognition',
  Activity: 'Personalization & analytics',
  Preferences: 'Customizing your experience'
};
const AFTERLIFE_CONSIDERATION = {
  Identity: 'May remain linked to your identity across sessions and future visits.',
  Location: 'Creates location-based activity patterns over time.',
  Device: 'Can be used to recognize you across visits, even without an account.',
  Activity: 'Builds a behavioral profile that can outlast a single visit.',
  Preferences: 'Usually lower-risk, but may still be shared with partners.'
};

function countMatches(lowerText, keywords) {
  let n = 0;
  for (const kw of keywords) if (lowerText.includes(kw)) n++;
  return n;
}
function levelFromCount(n) {
  if (n >= 2) return 'High';
  if (n === 1) return 'Moderate';
  return 'Low';
}
function levelRank(l) { return l === 'High' ? 2 : (l === 'Moderate' ? 1 : 0); }
function clampNum(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function heuristicAnalyze(policyText) {
  const lower = policyText.toLowerCase();

  const categories = CATEGORY_NAMES.map((name) => ({
    name,
    level: levelFromCount(countMatches(lower, CATEGORY_KEYWORDS[name]))
  }));

  const stages = ['User', 'Website'];
  if (STAGE_KEYWORDS.Analytics.some((kw) => lower.includes(kw))) stages.push('Analytics');
  if (STAGE_KEYWORDS['Service Providers'].some((kw) => lower.includes(kw))) stages.push('Service Providers');
  if (STAGE_KEYWORDS['Advertising / Partners'].some((kw) => lower.includes(kw))) stages.push('Advertising / Partners');

  const posCount = countMatches(lower, POSITIVE_INDICATORS);
  const vagueCount = countMatches(lower, VAGUE_INDICATORS);

  const score = Math.round(clampNum(50 + posCount * 5 - vagueCount * 4, 15, 95));

  const sentences = policyText.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  const avgWordsPerSentence = sentences.length
    ? sentences.reduce((sum, s) => sum + s.split(/\s+/).length, 0) / sentences.length
    : 18;
  const clarity = Math.round(clampNum(100 - Math.max(0, avgWordsPerSentence - 14) * 2.5 - vagueCount * 2, 15, 95));

  const control = Math.round(clampNum(30 + posCount * 8 - vagueCount * 3, 5, 95));

  const ranked = categories.slice().sort((a, b) => levelRank(b.level) - levelRank(a.level));
  const afterlife = ranked.slice(0, 2).map((c) => ({
    name: c.name,
    why: AFTERLIFE_WHY[c.name],
    consideration: AFTERLIFE_CONSIDERATION[c.name]
  }));

  const matchedTriggers = TRIGGER_BANK.filter((t) => t.keywords.some((kw) => lower.includes(kw)));
  let translations = matchedTriggers.slice(0, 3).map((t) => ({ legal: t.legal, human: t.human }));
  if (translations.length < 3) {
    const remaining = TRIGGER_BANK.filter((t) => !matchedTriggers.includes(t));
    for (const t of remaining) {
      if (translations.length >= 3) break;
      translations.push({ legal: t.legal, human: t.human });
    }
  }

  const descriptor = score >= 75
    ? 'This site is generally clear about what it collects and why.'
    : score >= 50
      ? 'This site discloses some practices, but leaves real gaps unstated.'
      : "This site's disclosures are thin — much of its practice is left unstated.";

  return { score, descriptor, categories, stages, afterlife, translations, clarity, control };
}
