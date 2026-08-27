// Prowlarr source — fans queries out across whatever indexers the operator
// has added in Prowlarr. Returns torrent candidates. Many indexers return
// infoHash=null and the hash is only reachable by following Prowlarr's
// /download proxy redirect, so we hydrate those in a bounded-concurrency
// second pass.
//
// Lifted from the metadata addon's lib/sources/prowlarr.js and adapted
// to the scraper's registry contract.

const fetch = require('node-fetch');
const crypto = require('crypto');
const httpAgent = require('../http-agent');
const config = require('../../config');   // 0.2.3 — honor SOURCE_TIMEOUT_MS

// Base32 (RFC 4648) -> bytes. Some trackers encode btih as 32 chars b32.
function base32ToBytes(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  s = s.toUpperCase().replace(/=+$/, '');
  const out = [];
  let buf = 0, bits = 0;
  for (const ch of s) {
    const v = alphabet.indexOf(ch);
    if (v < 0) return null;
    buf = (buf << 5) | v; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
  }
  return out;
}

function extractInfoHash(result) {
  if (result.infoHash && /^[a-f0-9]{40}$/i.test(result.infoHash)) {
    return result.infoHash.toLowerCase();
  }
  const candidates = [result.magnetUrl, result.downloadUrl, result.guid, result.infoUrl];
  for (const c of candidates) {
    if (!c || typeof c !== 'string') continue;
    const m = c.match(/urn:btih:([A-Fa-f0-9]{40}|[A-Z2-7]{32})/i);
    if (m) {
      const h = m[1];
      if (/^[a-f0-9]{40}$/i.test(h)) return h.toLowerCase();
      try {
        const bin = base32ToBytes(h);
        if (bin && bin.length === 20) {
          return Array.from(bin).map((b) => b.toString(16).padStart(2, '0')).join('');
        }
      } catch (_) { /* fall through */ }
    }
    const m2 = c.match(/\b([A-Fa-f0-9]{40})\b/);
    if (m2) return m2[1].toLowerCase();
  }
  return '';
}

function extractMagnetTrackers(magnetUrl) {
  if (!magnetUrl) return [];
  const out = [];
  const re = /[?&]tr=([^&]+)/g;
  let m;
  while ((m = re.exec(magnetUrl))) {
    try { out.push(decodeURIComponent(m[1])); } catch (_) { out.push(m[1]); }
  }
  return out;
}

async function singleSearch(query, sourceConfig, log) {
  if (!sourceConfig.url) return [];
  const limit = sourceConfig.limit || 100;
  const params = new URLSearchParams({ query, type: 'search', limit: String(limit) });
  const cats = (sourceConfig.categories || '2000,5000,8000').split(',').map((s) => s.trim()).filter(Boolean);
  for (const c of cats) params.append('categories', c);

  const url = sourceConfig.url.replace(/\/$/, '') + '/api/v1/search?' + params.toString();
  let res;
  try {
    const remainingMs = sourceConfig._requestDeadlineAt
      ? Math.max(250, sourceConfig._requestDeadlineAt - Date.now()) : Infinity;
    const timeoutMs = Math.min(
      Number(sourceConfig.timeoutMs) || config.defaultSourceTimeoutMs || 15000,
      remainingMs);
    res = await fetch(url, httpAgent.fetchOpts({
      headers: { 'X-Api-Key': sourceConfig.apiKey || '', Accept: 'application/json' },
      timeout: timeoutMs,
    }, url));
  } catch (err) { log.error('source', 'prowlarr network error: ' + err.message); return []; }
  if (!res.ok) { log.warn('source', 'prowlarr HTTP ' + res.status); return []; }
  let body;
  try { body = await res.json(); }
  catch (err) { log.warn('source', 'prowlarr bad JSON: ' + err.message); return []; }
  return Array.isArray(body) ? body : [];
}

function skipBencodeValue(buf, start) {
  const marker = buf[start];
  if (marker === 0x69) {
    const end = buf.indexOf(0x65, start + 1);
    return end < 0 ? -1 : end + 1;
  }
  if (marker === 0x6c || marker === 0x64) {
    let pos = start + 1;
    while (pos < buf.length && buf[pos] !== 0x65) {
      pos = skipBencodeValue(buf, pos);
      if (pos < 0) return -1;
      if (marker === 0x64) {
        pos = skipBencodeValue(buf, pos);
        if (pos < 0) return -1;
      }
    }
    return pos < buf.length ? pos + 1 : -1;
  }
  if (marker >= 0x30 && marker <= 0x39) {
    const colon = buf.indexOf(0x3a, start);
    if (colon < 0) return -1;
    const len = parseInt(buf.slice(start, colon).toString('ascii'), 10);
    if (!Number.isFinite(len) || len < 0) return -1;
    const end = colon + 1 + len;
    return end <= buf.length ? end : -1;
  }
  return -1;
}

function extractTorrentInfoHash(body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
  if (buf.length < 2 || buf[0] !== 0x64) return '';
  let pos = 1;
  while (pos < buf.length && buf[pos] !== 0x65) {
    const keyStart = pos;
    const keyEnd = skipBencodeValue(buf, keyStart);
    if (keyEnd < 0) return '';
    const colon = buf.indexOf(0x3a, keyStart);
    if (colon < 0 || colon >= keyEnd) return '';
    const key = buf.slice(colon + 1, keyEnd).toString('utf8');
    const valueStart = keyEnd;
    const valueEnd = skipBencodeValue(buf, valueStart);
    if (valueEnd < 0) return '';
    if (key === 'info') {
      return crypto.createHash('sha1').update(buf.slice(valueStart, valueEnd)).digest('hex');
    }
    pos = valueEnd;
  }
  return '';
}

function absoluteDownloadUrl(value, base) {
  try { return new URL(String(value || ''), String(base || '')).toString(); }
  catch (_) { return ''; }
}

function hashFromMagnet(value) {
  const match = String(value || '').match(/urn:btih:([A-Fa-f0-9]{40}|[A-Z2-7]{32})/i);
  if (!match) return '';
  const token = match[1];
  if (/^[a-f0-9]{40}$/i.test(token)) return token.toLowerCase();
  const bytes = base32ToBytes(token);
  return bytes && bytes.length === 20
    ? Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
    : '';
}

async function hydrateHashViaDownloadProxy(result, sourceConfig, log) {
  if (!result.downloadUrl) return null;
  const prowlarrBase = String(sourceConfig.url || '').replace(/\/$/, '') + '/';
  let current = absoluteDownloadUrl(result.downloadUrl, prowlarrBase);
  if (!current) return null;
  let prowlarrHost = '';
  try { prowlarrHost = new URL(prowlarrBase).host; } catch (_) {}

  for (let hop = 0; hop < 4; hop++) {
    let res;
    try {
      const headers = new URL(current).host === prowlarrHost && sourceConfig.apiKey
        ? { 'X-Api-Key': sourceConfig.apiKey, Accept: 'application/x-bittorrent,*/*' }
        : { Accept: 'application/x-bittorrent,*/*' };
      res = await fetch(current, httpAgent.fetchOpts({
        headers, redirect: 'manual', timeout: 10000, method: 'GET',
      }, current));
    } catch (err) {
      log.debug('source', 'hydrate fail (' + (result.indexer || '?') + '): ' + err.message);
      return { error: true };
    }
    const loc = res.headers.get('location') || '';
    if (loc) {
      const hash = hashFromMagnet(loc);
      if (hash) return { hash, magnetUrl: loc };
      current = absoluteDownloadUrl(loc, current);
      if (!current) return null;
      continue;
    }
    if (res.ok) {
      const hash = extractTorrentInfoHash(await res.buffer());
      if (hash) return { hash, magnetUrl: null };
    }
    log.debug('source', 'hydrate no hash (' + (result.indexer || '?') + '): HTTP ' + res.status);
    return null;
  }
  return null;
}

async function hydrateAll(results, sourceConfig, log) {
  const HYDRATE_MAX = 50;
  const needs = results
    .filter((r) => !r._hash && r.downloadUrl && (r.seeders || 0) > 0)
    .sort((a, b) => (b.seeders || 0) - (a.seeders || 0))
    .slice(0, HYDRATE_MAX);
  if (needs.length === 0) return 0;
  if (sourceConfig._requestDeadlineAt && sourceConfig._requestDeadlineAt - Date.now() < 750) {
    log.info('source', 'skipping hash hydration near request deadline');
    return 0;
  }
  log.info('source', 'hydrating up to ' + needs.length + ' by seeders');
  const failedIndexers = new Set();
  let i = 0, hydrated = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= needs.length) return;
      const r = needs[idx];
      if (r.indexer && failedIndexers.has(r.indexer)) continue;
      const got = await hydrateHashViaDownloadProxy(r, sourceConfig, log);
      if (got && got.hash) { r._hash = got.hash; r._magnet = got.magnetUrl; hydrated++; }
      else if (got && got.error && r.indexer) failedIndexers.add(r.indexer);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
  return hydrated;
}

async function multiSearch(queries, sourceConfig, log) {
  const seen = new Set();
  const collected = [];
  const unique = Array.from(new Set((queries || []).map((q) => String(q || '').trim())
    .filter(Boolean)));
  let next = 0;
  async function queryWorker() {
    while (true) {
      const index = next++;
      if (index >= unique.length) return;
      if (sourceConfig._requestDeadlineAt && Date.now() >= sourceConfig._requestDeadlineAt) return;
      const q = unique[index];
      log.info('source', 'prowlarr query "' + q + '"');
      const results = await singleSearch(q, sourceConfig, log);
      log.info('source', '  -> ' + results.length + ' raw');
      for (const r of results) {
        r._hash = extractInfoHash(r);
        collected.push(r);
      }
    }
  }
  const queryConcurrency = Math.max(1, Math.min(6,
    Number(sourceConfig.queryConcurrency) || 3, unique.length || 1));
  await Promise.all(Array.from({ length: queryConcurrency }, queryWorker));
  const hydrated = await hydrateAll(collected, sourceConfig, log);
  if (hydrated > 0) log.info('source', 'hydrated ' + hydrated + ' result(s) via download proxy');
  const out = [];
  for (const r of collected) {
    const hash = r._hash;
    if (!hash) continue;
    if (seen.has(hash)) continue;
    seen.add(hash);
    const magnet = r.magnetUrl || r._magnet || null;
    out.push({
      infoHash: hash,
      title: r.title || '',
      size: r.size || 0,
      seeders: r.seeders || 0,
      indexer: r.indexer || 'Prowlarr',
      magnetTrackers: extractMagnetTrackers(magnet),
      publishDate: r.publishDate || null,
    });
  }
  return out;
}

async function test(sourceConfig, log) {
  if (!sourceConfig.url) return { ok: false, message: 'URL not configured' };
  const start = Date.now();
  try {
    const url = sourceConfig.url.replace(/\/$/, '') + '/api/v1/health';
    const res = await fetch(url, httpAgent.fetchOpts({
      headers: { 'X-Api-Key': sourceConfig.apiKey || '', Accept: 'application/json' },
      timeout: 8000,
    }, url));
    const latencyMs = Date.now() - start;
    if (!res.ok) return { ok: false, latencyMs, message: 'HTTP ' + res.status };
    return { ok: true, latencyMs, message: 'Prowlarr health OK' };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, message: err.message };
  }
}

module.exports = {
  type: 'prowlarr',
  label: 'Prowlarr',
  description: 'Federates whatever indexers the operator has added in Prowlarr.',
  schema: [
    { name: 'url',        label: 'Prowlarr URL', type: 'url',    required: true, placeholder: 'http://prowlarr:9696' },
    { name: 'apiKey',     label: 'API key',      type: 'secret', required: true, hint: 'Prowlarr → Settings → General → API Key' },
    { name: 'categories', label: 'Categories',   type: 'csv',    default: '2000,5000,8000', hint: 'Comma-separated Newznab category IDs' },
    { name: 'limit',      label: 'Limit per query', type: 'number', default: 100 },
    { name: 'queryConcurrency', label: 'Concurrent queries', type: 'number', default: 3, hint: 'Aliases searched in parallel; 3 is a safe default' },
    { name: 'timeoutMs', label: 'Timeout (ms)', type: 'number', default: 15000, hint: 'Maximum for standalone/manual searches; SSS may request a shorter response budget' },
  ],
  // 0.2.4 — both names exported. `search` is the generic scraper-registry
  // contract; `multiSearch` is what lib/search.js calls directly by name.
  search: multiSearch,
  multiSearch,
  test,
  extractTorrentInfoHash,
  absoluteDownloadUrl,
};
