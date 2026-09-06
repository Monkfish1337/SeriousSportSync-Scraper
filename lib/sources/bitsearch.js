// bitsearch.eu source — direct GET to the public JSON search API.
//
// Long-tail tracker aggregator with strong overlap with TheRARBG/Knaben but
// occasionally surfaces verified releases (the `verified` flag) the others
// miss. Useful as a triangulation source.
//
// Endpoint:
//   GET https://bitsearch.eu/api/v1/search?q=<query>
//   (bitsearch.to redirects to bitsearch.eu — follow redirects)
//
// Response shape (fields actually used) — verified live 2026-09-06:
//   {
//     success: true,
//     query: '...',
//     results: [{
//       id:           '...',
//       infohash:     '40-HEX-HASH',
//       title:        '...',
//       size:         bytes,
//       category:     numeric (1=Movies, 2=TV, 3=Music, ...),
//       subCategory:  numeric,
//       seeders:      N,
//       leechers:     N,
//       downloads:    N,
//       verified:     bool,
//       createdAt:    ISO,
//       updatedAt:    ISO,
//     }],
//     pagination: {...},
//     took: N,
//   }
//
// Why this file is more defensive than its siblings:
//
// The GUI reported "bitsearch responding, 0 hit(s)" while the same query in a
// browser returned 17 results. That message was a lie of omission — every
// failure mode below returned an empty array, and test() reported ok:true on
// all of them. A blocked request, a Cloudflare interstitial served as 200
// HTML, a mistyped base URL and a genuinely empty index were indistinguishable
// from the health card. So the fetch now returns a reason, and test() reports
// it. "0 hits" should only ever mean the index had nothing.

const fetch = require('node-fetch');
const httpAgent = require('../http-agent');

const BITSEARCH_URL = 'https://bitsearch.eu';
const SEARCH_PATH = '/api/v1/search';
const DEFAULT_PROBE = 'UFC 300';

function normHash(h) {
  if (!h || typeof h !== 'string') return '';
  return /^[A-Fa-f0-9]{40}$/.test(h) ? h.toLowerCase() : '';
}

// Accept either the bare host or a URL that already carries the API path.
// Pasting the full endpoint out of a browser address bar is the obvious thing
// to do, and naive concatenation turned it into /api/v1/search/api/v1/search —
// a 404 that surfaced as "responding, 0 hits".
function endpointUrl(sourceConfig) {
  const base = String((sourceConfig && sourceConfig.url) || BITSEARCH_URL).trim();
  const trimmed = base.replace(/\/+$/, '');
  if (trimmed.toLowerCase().endsWith(SEARCH_PATH)) return trimmed;
  return trimmed + SEARCH_PATH;
}

function looksLikeChallenge(body) {
  if (!body) return false;
  const head = String(body).slice(0, 2000);
  return /just a moment|cf-browser-verification|challenge-platform|attention required/i.test(head);
}

// Returns a diagnostic result rather than a bare array, so callers can tell
// "the index has nothing" apart from "we never reached the index".
async function fetchSearch(query, sourceConfig, log) {
  const cfg = sourceConfig || {};
  const url = endpointUrl(cfg) + '?' + new URLSearchParams({ q: query }).toString();
  let res;
  try {
    res = await fetch(url, httpAgent.fetchOpts({
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
      timeout: Number(cfg.timeoutMs) || 10000,
      // bitsearch.to redirects to bitsearch.eu and node-fetch follows by default.
    }, url));
  } catch (err) {
    const reason = 'network: ' + err.message;
    log.error('source', 'bitsearch ' + reason);
    return { ok: false, reason, rows: [], raw: 0, dropped: 0 };
  }

  const body = await res.text().catch(() => '');

  if (!res.ok) {
    const reason = 'HTTP ' + res.status
      + (looksLikeChallenge(body) ? ' (bot challenge — the host is blocking this IP)' : '');
    log.warn('source', 'bitsearch ' + reason);
    return { ok: false, reason, rows: [], raw: 0, dropped: 0 };
  }

  let payload;
  try { payload = JSON.parse(body); }
  catch (err) {
    // A 200 that isn't JSON is nearly always an interstitial or a proxy's own
    // error page, not the API. Say which, because the fix differs.
    const reason = looksLikeChallenge(body)
      ? 'bot challenge served as HTTP 200 — the host is blocking this IP (check VPN/proxy egress)'
      : 'non-JSON response (content-type ' + (res.headers.get('content-type') || 'unknown')
        + ') — check the Base URL points at the site root';
    log.warn('source', 'bitsearch ' + reason);
    return { ok: false, reason, rows: [], raw: 0, dropped: 0 };
  }

  if (payload && payload.success === false) {
    const reason = 'API reported failure' + (payload.error ? ': ' + payload.error : '');
    log.warn('source', 'bitsearch ' + reason);
    return { ok: false, reason, rows: [], raw: 0, dropped: 0 };
  }

  const hits = Array.isArray(payload && payload.results) ? payload.results : [];
  if (!Array.isArray(payload && payload.results)) {
    const reason = 'unexpected payload shape (no results array; keys: '
      + Object.keys(payload || {}).join(', ') + ')';
    log.warn('source', 'bitsearch ' + reason);
    return { ok: false, reason, rows: [], raw: 0, dropped: 0 };
  }

  const limit = Number(sourceConfig && sourceConfig.limit) || 100;
  const rows = [];
  let dropped = 0;
  for (const h of hits.slice(0, limit)) {
    const hash = normHash(h && h.infohash);
    if (!hash) { dropped += 1; continue; }
    rows.push({
      infoHash: hash,
      title: (h && h.title) || '',
      size: Number((h && h.size) || 0) || 0,
      seeders: Number((h && h.seeders) || 0) || 0,
      // We surface the `verified` flag as part of indexer attribution so
      // it shows up in logs without expanding the candidate contract.
      indexer: 'bitsearch' + (h && h.verified ? ':verified' : ''),
      magnetTrackers: [],
      publishDate: (h && h.createdAt) || null,
    });
  }

  // Results came back but none survived: the API changed a field name, or is
  // returning entries without hashes. Silently returning [] here is how the
  // original bug hid.
  if (hits.length && !rows.length) {
    log.warn('source', 'bitsearch returned ' + hits.length
      + ' result(s) but none had a usable infohash — the API shape may have changed');
  }

  return { ok: true, reason: '', rows, raw: hits.length, dropped };
}

async function singleSearch(query, sourceConfig, log) {
  const result = await fetchSearch(query, sourceConfig, log);
  return result.rows;
}

async function multiSearch(queries, sourceConfig, log) {
  const seen = new Set();
  const out = [];
  for (const q of queries) {
    log.info('source', 'bitsearch query "' + q + '"');
    const result = await fetchSearch(q, sourceConfig, log);
    log.info('source', '  -> ' + result.rows.length + ' hits'
      + (result.ok ? '' : ' (failed: ' + result.reason + ')')
      + (result.dropped ? ' [' + result.dropped + ' dropped: bad infohash]' : ''));
    for (const r of result.rows) {
      if (seen.has(r.infoHash)) continue;
      seen.add(r.infoHash);
      out.push(r);
    }
  }
  return out;
}

async function test(sourceConfig, log) {
  const cfg = sourceConfig || {};
  const probe = String(cfg.probeQuery || DEFAULT_PROBE).trim() || DEFAULT_PROBE;
  const start = Date.now();
  let result;
  try {
    result = await fetchSearch(probe, cfg, log);
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, message: err.message };
  }
  const latencyMs = Date.now() - start;

  if (!result.ok) {
    return { ok: false, latencyMs, message: 'bitsearch unreachable — ' + result.reason };
  }
  if (result.raw && !result.rows.length) {
    return {
      ok: false,
      latencyMs,
      message: 'bitsearch returned ' + result.raw + ' result(s) for "' + probe
        + '" but none had a usable infohash — API shape may have changed',
    };
  }
  if (!result.rows.length) {
    // Reached the API, it answered, the index simply had nothing. Not an error,
    // but not a clean bill of health either — a good probe should find hits.
    return {
      ok: true,
      latencyMs,
      message: 'bitsearch responding but 0 hit(s) for "' + probe
        + '" — index empty for this probe, try a different Probe query',
    };
  }
  return {
    ok: true,
    latencyMs,
    message: 'bitsearch responding, ' + result.rows.length + ' hit(s) for "' + probe + '"'
      + (result.dropped ? ' (' + result.dropped + ' dropped: bad infohash)' : ''),
  };
}

module.exports = {
  type: 'bitsearch',
  label: 'bitsearch.eu',
  description: 'Direct GET to bitsearch.eu /api/v1/search JSON endpoint. '
    + 'Long-tail aggregator that surfaces verified releases other sources miss.',
  schema: [
    { name: 'url',        label: 'Base URL',       type: 'url',    default: BITSEARCH_URL,
      hint: 'Site root — /api/v1/search is added automatically. bitsearch.to also works; it redirects to .eu.' },
    { name: 'limit',      label: 'Hits per query', type: 'number', default: 100 },
    { name: 'timeoutMs',  label: 'Timeout (ms)',   type: 'number', default: 10000 },
    { name: 'probeQuery', label: 'Probe query',    type: 'text',   default: DEFAULT_PROBE,
      hint: 'Used by the Test button only. Pick something with plenty of releases.' },
  ],
  multiSearch,
  test,
  // Exported for scripts/test-bitsearch-source.js.
  _test: { endpointUrl, fetchSearch, normHash },
};
