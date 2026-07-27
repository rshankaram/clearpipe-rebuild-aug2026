// Optional prospect-website enrichment.
//
// Fired the instant Step 1 is submitted and NOT awaited before the rep moves
// to Step 2 -- nothing on Step 2 depends on the result. It resolves quietly in
// the background while the rep fills in Step 2 (which reliably takes longer
// than this can take), and gets picked up only when the final read is
// generated. That removed the need to squeeze this into a tight, UI-facing
// timeout budget, which is what lets this version do more than the first pass:
// a same-request pull of any structured company data on the homepage, plus one
// follow-up fetch of a discovered news/press page if the time budget allows.
//
// Still fails silently end to end. Bad URL, timeout, blocked bot, empty page,
// no news page found -- all resolve to { context: null } and the read proceeds
// on the form answers alone, exactly as if nothing were fetched.
//
// WHAT THIS IS FOR, AND WHAT IT IS NOT FOR
// The read needs one thing from a website above all others: signal about WHO
// CAN APPROVE SPEND. A company that is listed, or is a subsidiary of a parent,
// or is a holding group, has a different decision path from an owner-run firm
// -- and that is exactly the question the tool is worst at when it has nothing
// to go on. So this version deliberately hunts for parent/subsidiary/ticker
// relationships in the structured data, and labels every segment it returns so
// the prompt can tell self-description apart from published fact apart from
// announcement. A marketing tagline and a filed corporate structure are not
// the same kind of evidence and should not arrive looking the same.

const TOTAL_BUDGET_MS = 8500; // stay well under typical serverless function limits
const HOMEPAGE_TIMEOUT_MS = 5000;
const NEWS_TIMEOUT_MS = 3000;
const MAX_BYTES_READ = 60000; // enough to reach </head> and early <body> on virtually any page
const MAX_CONTEXT_LENGTH = 900;

function normalizeUrl(raw) {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    const parsed = new URL(value);
    if (!parsed.hostname || !parsed.hostname.includes('.')) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClearPipeBot/1.0)' }
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readLimited(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    return text.slice(0, maxBytes);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let result = '';
  while (received < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    result += decoder.decode(value, { stream: true });
  }
  try { await reader.cancel(); } catch { /* no-op */ }
  return result;
}

// Title + meta/og description. The baseline signal, always attempted.
function extractTitleDescription(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]) : '';

  const descPatterns = [
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i,
    /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i,
    /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i,
    /<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:description["']/i
  ];
  let description = '';
  for (const pattern of descPatterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      description = decodeEntities(match[1]);
      break;
    }
  }

  return [title, description].filter(Boolean).join(' — ');
}

function firstString(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return firstString(value[0]);
  if (typeof value === 'object') return String(value.name || value['@id'] || '').trim();
  return '';
}

// schema.org Organization data, if the site publishes it. Built for search
// engines, but factual when present.
//
// Returns two separately-labelled things, because they are different kinds of
// evidence:
//   scale    -- employees, founding year, location. Background colour.
//   structure-- parent, subsidiaries, ticker, legal name. This is the one that
//               bears on who can approve spend, so it is pulled out on its own
//               rather than being buried in a list of demographics.
function extractOrgData(html) {
  const scriptMatches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);

  for (const m of scriptMatches) {
    let data;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const candidates = Array.isArray(data)
      ? data
      : (Array.isArray(data['@graph']) ? data['@graph'] : [data]);

    for (const item of candidates) {
      if (!item || typeof item !== 'object') continue;
      const type = item['@type'];
      const typeStr = Array.isArray(type) ? type.join(',') : (type || '');
      if (!/organization|corporation|localbusiness/i.test(typeStr)) continue;

      const scale = [];
      if (item.numberOfEmployees) {
        const emp = item.numberOfEmployees;
        const val = typeof emp === 'object' ? (emp.value || emp.minValue || '') : emp;
        if (val) scale.push(`${val} employees`);
      }
      if (item.foundingDate) scale.push(`founded ${String(item.foundingDate).slice(0, 4)}`);
      if (item.address) {
        const addr = item.address;
        const locality = typeof addr === 'object'
          ? [addr.addressLocality, addr.addressCountry].filter(Boolean).join(', ')
          : addr;
        if (locality) scale.push(String(locality));
      }

      // The who-decides signals.
      const structure = [];
      const parent = firstString(item.parentOrganization);
      if (parent) structure.push(`a subsidiary of ${parent}`);

      const subs = Array.isArray(item.subOrganization) ? item.subOrganization : (item.subOrganization ? [item.subOrganization] : []);
      if (subs.length) {
        const names = subs.map(firstString).filter(Boolean).slice(0, 3);
        if (names.length) structure.push(`parent of ${names.join(', ')}`);
      }

      if (item.tickerSymbol || item.hasOccupation === 'PublicCompany' || /publiccompany/i.test(typeStr)) {
        const t = firstString(item.tickerSymbol);
        structure.push(t ? `publicly listed (${t})` : 'publicly listed');
      }

      const legal = firstString(item.legalName);
      const name = firstString(item.name);
      if (legal && name && legal.toLowerCase() !== name.toLowerCase()) {
        structure.push(`legal name ${legal}`);
      }

      if (scale.length || structure.length) {
        return { scale: scale.join(', '), structure: structure.join('; ') };
      }
    }
  }
  return { scale: '', structure: '' };
}

// Finds a same-origin news/press link on the homepage. Deliberately narrow:
// same hostname only, no following to third-party PR sites.
//
// Now ranks candidates instead of taking the first regex hit, because the
// first match on a large site is routinely a footer "Media Kit" or an
// "In the press" marketing page rather than the actual newsroom.
function findNewsLink(html, baseUrl) {
  const hrefMatches = [...html.matchAll(/<a[^>]+href=["']([^"'#][^"']*)["']/gi)].map(m => m[1]);
  const base = new URL(baseUrl);

  const score = (path) => {
    const p = path.toLowerCase();
    if (/\/(newsroom|press-releases|press-release)(\/|$)/.test(p)) return 5;
    if (/\/(news|press)(\/|$)/.test(p)) return 4;
    if (/(newsroom|press-releases)/.test(p)) return 3;
    if (/\/(news|press)/.test(p)) return 2;
    if (/(media|announcements)/.test(p)) return 1;
    return 0;
  };

  let best = null;
  let bestScore = 0;
  for (const href of hrefMatches) {
    try {
      const resolved = new URL(href, baseUrl);
      if (resolved.hostname !== base.hostname) continue;
      const s = score(resolved.pathname);
      if (s > bestScore) {
        bestScore = s;
        best = resolved.toString();
      }
    } catch {
      continue;
    }
  }
  return bestScore > 0 ? best : null;
}

// Navigation, cookie banners and section labels routinely occupy h2/h3 on a
// newsroom page and look exactly like short headlines. Filtering them out
// matters more than catching every real headline: a nav item passed through as
// "recent news" is actively misleading, whereas a missed headline is merely
// absent.
const NON_HEADLINE = /^(news|press|media|newsroom|latest news|press releases?|all news|read more|learn more|contact us?|careers?|about us?|our (products|services|solutions|team)|investor relations|events?|blog|resources|search|menu|navigation|cookie|privacy|subscribe|follow us|share this|related (articles|posts)|filter by|categories|archive|sitemap|quick links|get in touch|sign up|log ?in)$/i;

function looksLikeHeadline(text) {
  if (text.length < 20 || text.length > 160) return false;
  if (NON_HEADLINE.test(text)) return false;
  // A real headline is a clause, not a label. Two words is a nav item.
  if (text.split(/\s+/).length < 4) return false;
  // All-caps section banners.
  if (text === text.toUpperCase() && text.length > 24) return false;
  return true;
}

function extractHeadlines(html) {
  // Strip nav, header and footer regions before looking for headings at all --
  // that removes most of the junk at the source rather than by blocklist.
  const stripped = html
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ');

  const headings = [...stripped.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi)]
    .map(m => decodeEntities(m[1].replace(/<[^>]+>/g, ' ')))
    .filter(looksLikeHeadline);

  return [...new Set(headings)].slice(0, 3).join('; ');
}

// Every segment is labelled with what KIND of evidence it is. The prompt
// treats self-description, published company data and announcements
// differently, and it can only do that if they arrive distinguishable.
function buildCombinedContext({ titleDesc, scale, structure, newsSnippet }) {
  const segments = [];
  if (titleDesc) segments.push(`How they describe themselves: ${titleDesc}`);
  if (structure) segments.push(`Corporate structure they publish: ${structure}`);
  if (scale) segments.push(`Company data they publish: ${scale}`);
  if (newsSnippet) segments.push(`Announced on their own news page: ${newsSnippet}`);
  return segments.join(' | ').slice(0, MAX_CONTEXT_LENGTH);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(200).json({ context: null });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  const url = normalizeUrl(body && body.url);
  if (!url) {
    console.log('[ClearPipe enrich] no usable URL supplied -- skipping fetch.');
    res.status(200).json({ context: null });
    return;
  }

  const startedAt = Date.now();

  try {
    const homepageRes = await fetchWithTimeout(url, HOMEPAGE_TIMEOUT_MS);
    if (!homepageRes.ok) {
      console.log(`[ClearPipe enrich] homepage fetch for ${new URL(url).hostname} failed, status ${homepageRes.status}.`);
      res.status(200).json({ context: null });
      return;
    }

    const html = await readLimited(homepageRes, MAX_BYTES_READ);
    const titleDesc = extractTitleDescription(html);
    const { scale, structure } = extractOrgData(html);

    let newsSnippet = '';
    const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAt);
    if (remaining > 2500) {
      const newsUrl = findNewsLink(html, url);
      if (newsUrl) {
        try {
          const newsRes = await fetchWithTimeout(newsUrl, Math.min(NEWS_TIMEOUT_MS, remaining - 500));
          if (newsRes.ok) {
            const newsHtml = await readLimited(newsRes, MAX_BYTES_READ);
            newsSnippet = extractHeadlines(newsHtml);
          }
        } catch {
          // The homepage signal is still useful even if the news fetch fails.
        }
      }
    }

    const context = buildCombinedContext({ titleDesc, scale, structure, newsSnippet });
    const hostname = new URL(url).hostname;
    if (context) {
      console.log(
        `[ClearPipe enrich] ${hostname} -- ${context.length} chars. ` +
        `structure=${structure ? 'yes' : 'no'}, scale=${scale ? 'yes' : 'no'}, news=${newsSnippet ? 'yes' : 'no'}.`
      );
    } else {
      console.log(`[ClearPipe enrich] ${hostname} -- fetch succeeded but nothing usable was extracted.`);
    }
    res.status(200).json({ context: context || null });
  } catch (err) {
    console.log(`[ClearPipe enrich] threw and fell back to null context: ${err && err.message}`);
    res.status(200).json({ context: null });
  }
}
