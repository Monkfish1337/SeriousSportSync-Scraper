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

async function singleSearch(query, sourceConfig, log, options) {
  const strict = !!(options && options.throwOnError);
  if (!sourceConfig.url) return [];
  const limit = sourceConfig.limit || 100;
  const params = new URLSearchParams({ query, type: 'search', limit: String(limit) });
  const cats = (sourceConfig.categories || '2000,5000,8000').split(',').map((s) => s.trim()).filter(Boolean);
  for (const c of cats) params.append('categories', c);
  for (const id of sourceConfig._indexerIds || []) params.append('indexerIds', String(id));

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
  } catch (err) {
    log.error('source', 'prowlarr network error: ' + err.message);
    if (strict) throw new Error('Prowlarr recent feed network error');
    return [];
  }
  if (!res.ok) {
    log.warn('source', 'prowlarr HTTP ' + res.status);
    if (strict) throw new Error('Prowlarr recent feed HTTP ' + res.status);
    return [];
  }
  let body;
  try { body = await res.json(); }
  catch (err) {
    log.warn('source', 'prowlarr bad JSON: ' + err.message);
    if (strict) throw new Error('Prowlarr recent feed returned invalid JSON');
    return [];
  }
  return Array.isArray(body) ? body : [];
}

async function listIndexers(sourceConfig) {
  const base = String(sourceConfig.url || '').replace(/\/$/, '');
  const url = base + '/api/v1/indexer';
  let response;
  try {
    response = await fetch(url, httpAgent.fetchOpts({
      headers: { 'X-Api-Key': sourceConfig.apiKey || '', Accept: 'application/json' },
      timeout: Math.max(1000, Math.min(30000, Number(sourceConfig.timeoutMs) || 15000)),
    }, url));
  } catch (_) {
    throw new Error('could not list configured Prowlarr indexers');
  }
  if (!response.ok) throw new Error('Prowlarr indexer inventory HTTP ' + response.status);
  let body;
  try { body = await response.json(); }
  catch (_) { throw new Error('Prowlarr indexer inventory returned invalid JSON'); }
  if (!Array.isArray(body)) throw new Error('Prowlarr indexer inventory was not a list');
  return body;
}

function categoryIds(categories) {
  const ids = [];
  for (const category of categories || []) {
    const value = category && typeof category === 'object' ? category.id : category;
    if (value != null && String(value).trim()) ids.push(String(value).trim());
    if (category && Array.isArray(category.subCategories)) ids.push(...categoryIds(category.subCategories));
  }
  return Array.from(new Set(ids));
}

function resultCategoryIds(result) {
  return categoryIds(Array.isArray(result && result.categories) ? result.categories : []);
}

function fallbackQueries(sourceConfig, indexerId, now) {
  const configured = String(sourceConfig.intelligenceFallbackQueries
    || 'UFC;ONE Friday Fights;ONE Fight Night;WWE;AEW;Formula 1;MLB;UEFA Champions League')
    .split(/[;\r\n]+/).map((value) => value.trim()).filter(Boolean);
  if (!configured.length) return [];
  const configuredCount = Number(sourceConfig.intelligenceFallbackQueriesPerRun);
  const count = Number.isFinite(configuredCount) ? Math.max(0, Math.min(3, configuredCount)) : 2;
  const cycle = Math.floor(Number(now || Date.now()) / 3600000);
  const start = Math.abs(cycle * Math.max(1, count) + Number(indexerId || 0)) % configured.length;
  return Array.from({ length: Math.min(count, configured.length) }, (_, offset) =>
    configured[(start + offset) % configured.length]);
}

function normalizeIntelligenceRows(results, indexer, requested) {
  const accepted = [];
  for (const result of results || []) {
    if (!requested.some((category) => resultCategoryIds(result).includes(category))) continue;
    const title = String(result.title || '').trim();
    if (!title) continue;
    accepted.push({
      title, size: Number(result.size) || 0, publishedAt: result.publishDate || null,
      indexer: result.indexer || indexer.name || 'Prowlarr',
      protocol: /usenet/i.test(String(result.protocol || indexer.protocol || '')) ? 'usenet' : 'torrent',
      categories: Array.isArray(result.categories) ? result.categories : [],
    });
  }
  return accepted;
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
    const remainingMs = sourceConfig._requestDeadlineAt
      ? sourceConfig._requestDeadlineAt - Date.now() : 10000;
    if (remainingMs < 300) return null;
    let res;
    try {
      const headers = new URL(current).host === prowlarrHost && sourceConfig.apiKey
        ? { 'X-Api-Key': sourceConfig.apiKey, Accept: 'application/x-bittorrent,*/*' }
        : { Accept: 'application/x-bittorrent,*/*' };
      res = await fetch(current, httpAgent.fetchOpts({
        headers, redirect: 'manual', timeout: Math.min(10000, remainingMs), method: 'GET',
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
      if (sourceConfig._requestDeadlineAt
        && sourceConfig._requestDeadlineAt - Date.now() < 300) return;
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

// Title-only recent feed used by Release Intelligence. Unlike the playback
// path this intentionally keeps rows without an info hash and never follows a
// download URL.
async function recent(sourceConfig, log) {
  log.info('intelligence', 'inventorying Prowlarr indexers');
  const requested = String(sourceConfig.intelligenceCategories || '5060')
    .split(',').map((value) => value.trim()).filter(Boolean);
  const feedConfig = Object.assign({}, sourceConfig, {
    categories: requested.join(','),
    limit: Math.max(1, Math.min(500, Number(sourceConfig.intelligenceLimit) || 100)),
  });
  let indexers;
  try { indexers = await listIndexers(sourceConfig); }
  catch (error) {
    log.warn('intelligence', error.message + '; using aggregate compatibility mode');
    const results = await singleSearch('', feedConfig, log, { throwOnError: true });
    const rows = normalizeIntelligenceRows(results, { name: 'Prowlarr' }, requested);
    rows.diagnostics = [{ name: 'Prowlarr aggregate', protocol: 'mixed', state: 'compatibility',
      mode: 'recent feed', raw: results.length, accepted: rows.length,
      rejected: Math.max(0, results.length - rows.length), durationMs: 0,
      reason: 'Indexer inventory unavailable' }];
    return rows;
  }

  const diagnostics = [];
  const collected = [];
  const enabled = indexers.filter((indexer) => indexer && indexer.enable !== false);
  for (const indexer of indexers.filter((entry) => entry && entry.enable === false)) {
    diagnostics.push({ id: indexer.id, name: indexer.name || 'Indexer ' + indexer.id,
      protocol: indexer.protocol || 'unknown', state: 'disabled', mode: 'skipped', raw: 0,
      accepted: 0, rejected: 0, durationMs: 0, reason: 'Disabled in Prowlarr' });
  }
  let next = 0;
  async function worker() {
    while (true) {
      const position = next++;
      if (position >= enabled.length) return;
      const indexer = enabled[position];
      const started = Date.now();
      const detail = { id: indexer.id, name: indexer.name || 'Indexer ' + indexer.id,
        protocol: indexer.protocol || 'unknown', state: 'working', mode: 'recent feed',
        raw: 0, accepted: 0, rejected: 0, durationMs: 0, reason: '' };
      const supported = categoryIds(indexer.capabilities && indexer.capabilities.categories);
      if (supported.length && !requested.some((category) => supported.includes(category))) {
        detail.state = 'unsupported';
        detail.mode = 'skipped';
        detail.reason = 'Sports category is not mapped by this indexer';
        detail.durationMs = Date.now() - started;
        diagnostics.push(detail);
        continue;
      }
      const disabledTill = new Date(indexer.status && indexer.status.disabledTill || 0).getTime();
      if (Number.isFinite(disabledTill) && disabledTill > Date.now()) {
        detail.state = 'unavailable';
        detail.mode = 'skipped';
        detail.reason = 'Temporarily disabled by Prowlarr until ' + new Date(disabledTill).toISOString();
        detail.durationMs = Date.now() - started;
        diagnostics.push(detail);
        continue;
      }
      try {
        const oneConfig = Object.assign({}, feedConfig, { _indexerIds: [indexer.id] });
        let results = [];
        if (indexer.supportsRss !== false) {
          results = await singleSearch('', oneConfig, log, { throwOnError: true });
        }
        let rows = normalizeIntelligenceRows(results, indexer, requested);
        detail.raw += results.length;
        detail.rejected += Math.max(0, results.length - rows.length);
        if (!rows.length && indexer.supportsSearch !== false) {
          const queries = fallbackQueries(sourceConfig, indexer.id);
          detail.mode = queries.length ? 'rotating search'
            : (indexer.supportsRss === false ? 'skipped' : 'recent feed');
          detail.queries = queries;
          for (const query of queries) {
            results = await singleSearch(query, oneConfig, log, { throwOnError: true });
            const queryRows = normalizeIntelligenceRows(results, indexer, requested);
            detail.raw += results.length;
            detail.rejected += Math.max(0, results.length - queryRows.length);
            rows = rows.concat(queryRows);
          }
        }
        const seen = new Set();
        rows = rows.filter((row) => {
          const key = row.title.toLowerCase() + '|' + row.size;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        detail.accepted = rows.length;
        detail.state = rows.length ? 'working' : 'empty';
        detail.reason = rows.length ? '' : (detail.mode === 'rotating search'
          ? 'Feed and this cycle’s fallback searches returned no sport titles'
          : indexer.supportsRss === false && indexer.supportsSearch === false
            ? 'Indexer exposes neither RSS nor interactive search'
            : 'Recent sport feed returned no titles');
        collected.push(...rows);
      } catch (error) {
        detail.state = 'error';
        detail.reason = error.message;
      }
      detail.durationMs = Date.now() - started;
      diagnostics.push(detail);
      log.info('intelligence', detail.name + ': ' + detail.accepted + ' accepted via ' + detail.mode);
    }
  }
  const concurrency = Math.max(1, Math.min(6, Number(sourceConfig.intelligenceIndexerConcurrency) || 3));
  await Promise.all(Array.from({ length: Math.min(concurrency, enabled.length || 1) }, worker));
  const rows = [];
  const seen = new Set();
  for (const row of collected) {
    const key = row.title.toLowerCase() + '|' + row.size + '|' + row.indexer;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  rows.diagnostics = diagnostics.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return rows;
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
  defaultTimeoutMs: 30000,
  schema: [
    { name: 'url',        label: 'Prowlarr URL', type: 'url',    required: true, placeholder: 'http://prowlarr:9696' },
    { name: 'apiKey',     label: 'API key',      type: 'secret', required: true, hint: 'Prowlarr → Settings → General → API Key' },
    { name: 'categories', label: 'Categories',   type: 'csv',    default: '2000,5000,8000', hint: 'Comma-separated Newznab category IDs' },
    { name: 'limit',      label: 'Limit per query', type: 'number', default: 100 },
    { name: 'queryConcurrency', label: 'Concurrent queries', type: 'number', default: 3, hint: 'Aliases searched in parallel; 3 is a safe default' },
    { name: 'timeoutMs', label: 'Background timeout (ms)', type: 'number', default: 30000, hint: 'Prowlarr may keep searching after SSS responds; completed results appear when links are refreshed' },
    { name: 'intelligenceCategories', label: 'Recent-feed categories', type: 'csv', default: '5060', hint: 'Naming collector only. TV/Sport by default; returned titles are checked against this list.' },
    { name: 'intelligenceLimit', label: 'Recent titles per indexer', type: 'number', default: 100, hint: 'Naming collector only. Applied independently to each configured Prowlarr indexer.' },
    { name: 'intelligenceIndexerConcurrency', label: 'Concurrent indexer feeds', type: 'number', default: 3, hint: 'How many Prowlarr indexers are collected at once.' },
    { name: 'intelligenceFallbackQueries', label: 'Rotating fallback searches', type: 'text', default: 'UFC;ONE Friday Fights;ONE Fight Night;WWE;AEW;Formula 1;MLB;UEFA Champions League', hint: 'Semicolon-separated. Used only when an indexer returns no recent sport titles.' },
    { name: 'intelligenceFallbackQueriesPerRun', label: 'Fallback searches per empty indexer', type: 'number', default: 2, hint: 'Bounded to 0–3. Terms rotate hourly so coverage grows without searching the full event catalogue.' },
  ],
  // 0.2.4 — both names exported. `search` is the generic scraper-registry
  // contract; `multiSearch` is what lib/search.js calls directly by name.
  search: multiSearch,
  multiSearch,
  recent,
  test,
  extractTorrentInfoHash,
  absoluteDownloadUrl,
  categoryIds,
  fallbackQueries,
};
