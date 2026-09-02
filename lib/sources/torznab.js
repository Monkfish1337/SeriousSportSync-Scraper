// Generic Torznab source — talks directly to one indexer's Torznab feed.
//
// Useful for operators who want to query a single specific tracker without
// the Prowlarr aggregation layer (faster, less hop chain). The operator
// adds one of these per indexer they care about.
//
// Torznab is XML-only by spec (it's an RSS extension). We parse with a
// minimal regex extractor — same approach as the metadata addon's
// Newznab XML parser since the wire format is identical.

const fetch = require('node-fetch');
const httpAgent = require('../http-agent');

function normHash(h) {
  if (!h || typeof h !== 'string') return '';
  return /^[A-Fa-f0-9]{40}$/.test(h) ? h.toLowerCase() : '';
}

function extractTag(xml, tag) {
  const re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>', 'i');
  const m = xml.match(re);
  return m ? m[1] : null;
}
function cdataOrText(s) {
  if (s == null) return null;
  const m = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return (m ? m[1] : s).trim();
}
function extractAttrs(xml) {
  const re = /<(?:torznab:|newznab:)attr\b[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi;
  const out = {};
  let m;
  while ((m = re.exec(xml))) out[m[1].toLowerCase()] = m[2];
  return out;
}
function extractAttrValues(xml, name) {
  const re = /<(?:torznab:|newznab:)attr\b[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi;
  const out = [];
  let match;
  while ((match = re.exec(xml))) if (match[1].toLowerCase() === name) out.push(match[2]);
  return Array.from(new Set(out));
}
function extractEnclosureLength(itemXml) {
  const m = itemXml.match(/<enclosure\b[^>]*length="(\d+)"/i);
  return m ? Number(m[1]) || 0 : 0;
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

function parseItems(xml, sourceConfig, requireHash) {
  const out = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const inner = m[1];
    const attrs = extractAttrs(inner);
    const title = cdataOrText(extractTag(inner, 'title')) || '';
    if (!title) continue;
    const link = cdataOrText(extractTag(inner, 'link')) || '';
    const seeders = Number(attrs.seeders || 0) || 0;
    const size = Number(attrs.size || extractEnclosureLength(inner) || 0) || 0;
    const magnetUrl = attrs.magneturl || link || '';
    let hash = normHash(attrs.infohash);
    if (!hash) {
      const mh = magnetUrl.match(/urn:btih:([A-Fa-f0-9]{40})/i);
      if (mh) hash = mh[1].toLowerCase();
    }
    const publishDate = cdataOrText(extractTag(inner, 'pubDate'));
    if (!requireHash) {
      out.push({ title, size, publishedAt: publishDate,
        indexer: sourceConfig.label || 'Torznab', protocol: 'torrent',
        categories: extractAttrValues(inner, 'category') });
      continue;
    }
    if (!hash) continue;
    out.push({ infoHash: hash, title, size, seeders,
      indexer: sourceConfig.label || 'Torznab',
      magnetTrackers: extractMagnetTrackers(magnetUrl), publishDate });
  }
  return out;
}

function endpointUrl(sourceConfig) {
  const base = String(sourceConfig.url || '').replace(/\/+$/, '');
  const configuredPath = sourceConfig.apiPath == null ? '/api' : String(sourceConfig.apiPath).trim();
  if (!configuredPath) return base;
  const path = '/' + configuredPath.replace(/^\/+|\/+$/g, '');
  // Accept either a service base URL plus API path or a full endpoint URL.
  // This avoids accidental forms such as /torznab/torznab and makes imported
  // configurations from Prowlarr/Jackett less fragile.
  return base.toLowerCase().endsWith(path.toLowerCase()) ? base : base + path;
}

async function singleSearch(query, sourceConfig, log) {
  if (!sourceConfig.url) return [];
  const params = new URLSearchParams({
    t: 'search',
    q: query,
    limit: String(sourceConfig.limit || 100),
  });
  if (sourceConfig.apiKey) params.set('apikey', sourceConfig.apiKey);
  const cats = (sourceConfig.categories || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (cats.length) params.set('cat', cats.join(','));
  const url = endpointUrl(sourceConfig) + '?' + params.toString();
  let res;
  try {
    res = await fetch(url, httpAgent.fetchOpts({
      headers: { Accept: 'application/rss+xml, application/xml' },
      timeout: sourceConfig.timeoutMs || 12000,
    }, url));
  } catch (err) { log.error('source', 'torznab network error: ' + err.message); return []; }
  if (!res.ok) { log.warn('source', 'torznab HTTP ' + res.status); return []; }
  let xml = '';
  try { xml = await res.text(); }
  catch (err) { log.warn('source', 'torznab read error: ' + err.message); return []; }

  return parseItems(xml, sourceConfig, true);
}

async function recent(sourceConfig, log) {
  if (!sourceConfig.url) return [];
  const params = new URLSearchParams({ t: 'search',
    limit: String(Math.max(1, Math.min(500, Number(sourceConfig.intelligenceLimit) || 250))) });
  if (sourceConfig.apiKey) params.set('apikey', sourceConfig.apiKey);
  const cats = (sourceConfig.intelligenceCategories || '5060').split(',').map((value) => value.trim()).filter(Boolean);
  if (cats.length) params.set('cat', cats.join(','));
  const url = endpointUrl(sourceConfig) + '?' + params.toString();
  let response;
  try {
    response = await fetch(url, httpAgent.fetchOpts({
      headers: { Accept: 'application/rss+xml, application/xml' },
      timeout: sourceConfig.timeoutMs || 12000,
    }, url));
  } catch (error) {
    log.error('intelligence', 'torznab recent feed network error: ' + error.message);
    throw new Error('Torznab recent feed network error');
  }
  if (!response.ok) {
    log.warn('intelligence', 'torznab recent feed HTTP ' + response.status);
    throw new Error('Torznab recent feed HTTP ' + response.status);
  }
  const rows = parseItems(await response.text(), sourceConfig, false);
  const filtered = rows.filter((row) => cats.some((category) => row.categories.includes(category)));
  if (rows.length !== filtered.length) log.info('intelligence', 'discarded '
    + (rows.length - filtered.length) + ' title(s) outside configured sport categories');
  return filtered;
}

async function multiSearch(queries, sourceConfig, log) {
  const seen = new Set();
  const out = [];
  for (const q of queries) {
    log.info('source', (sourceConfig.label || 'torznab') + ' query "' + q + '"');
    const results = await singleSearch(q, sourceConfig, log);
    log.info('source', '  -> ' + results.length + ' hits');
    for (const r of results) {
      if (seen.has(r.infoHash)) continue;
      seen.add(r.infoHash);
      out.push(r);
    }
  }
  return out;
}

async function test(sourceConfig, log) {
  if (!sourceConfig.url) {
    return { ok: false, message: 'URL not configured' };
  }
  const start = Date.now();
  try {
    // t=caps is the Torznab capabilities call — cheap and tells us the
    // indexer is reachable + the API key is accepted.
    const params = new URLSearchParams({ t: 'caps' });
    if (sourceConfig.apiKey) params.set('apikey', sourceConfig.apiKey);
    const url = endpointUrl(sourceConfig) + '?' + params.toString();
    const res = await fetch(url, httpAgent.fetchOpts({ timeout: 6000 }, url));
    const latencyMs = Date.now() - start;
    if (!res.ok) return { ok: false, latencyMs, message: 'HTTP ' + res.status };
    return { ok: true, latencyMs, message: 'Torznab caps reachable' };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, message: err.message };
  }
}

module.exports = {
  type: 'torznab',
  label: 'Torznab (direct)',
  description: 'Direct Torznab feed for a single indexer — bypass Prowlarr.',
  schema: [
    { name: 'label',      label: 'Display name', type: 'text', required: true,
      placeholder: 'e.g. MagnetDL', hint: 'How this source appears in the GUI and on results.' },
    { name: 'url',        label: 'Base URL or full endpoint', type: 'url', required: true,
      placeholder: 'http://prowlarr:9696/1',
      hint: 'Must be a Torznab API, not a tracker website. Configure private tracker credentials in Prowlarr or Jackett.' },
    { name: 'apiKey',     label: 'API key',      type: 'secret',
      hint: 'Required by Prowlarr/Jackett; optional for services such as Bitmagnet.' },
    { name: 'apiPath',    label: 'API path',     type: 'text',
      default: '/api', hint: 'Usually /api; sometimes /torznab/api.' },
    { name: 'categories', label: 'Categories',   type: 'csv',
      placeholder: '5070,5080', hint: 'Optional. Comma-separated indexer-specific category IDs.' },
    { name: 'limit',      label: 'Limit per query', type: 'number', default: 100 },
    { name: 'timeoutMs',  label: 'Timeout (ms)', type: 'number', default: 12000 },
    { name: 'intelligenceCategories', label: 'Recent-feed categories', type: 'csv', default: '5060', hint: 'Naming collector only. TV/Sport by default; returned titles are checked against this list.' },
    { name: 'intelligenceLimit', label: 'Recent titles per collection', type: 'number', default: 250 },
  ],
  multiSearch,
  recent,
  test,
  endpointUrl,
};
