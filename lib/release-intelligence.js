'use strict';

// Bounded local database of release-title metadata. It deliberately excludes
// download URLs, magnets, hashes, credentials and tracker details. The store
// exists solely to learn how sports releases are named.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const settings = require('./settings');
const registry = require('./sources/registry');
const log = require('./log-buffer');

const FILE = path.join(config.dataDir, 'release-intelligence.json');
let activeRun = null;
let lastRun = null;

function emptyState() { return { version: 1, updatedAt: null, items: [] }; }
function load() {
  try {
    if (!fs.existsSync(FILE)) return emptyState();
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return parsed && Array.isArray(parsed.items) ? parsed : emptyState();
  } catch (error) {
    log.warn('intelligence', 'database load failed: ' + error.message);
    return emptyState();
  }
}
function save(state) {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  state.updatedAt = new Date().toISOString();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}
function cleanText(value, max) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function safeDate(value) {
  const date = new Date(value || 0);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function itemId(title, size) {
  return crypto.createHash('sha256').update(title.toLowerCase() + '|' + (Number(size) || 0)).digest('hex').slice(0, 24);
}
function normalizeObservation(value, source) {
  const title = cleanText(value && value.title, 500);
  if (!title) return null;
  const protocol = /^(?:torrent|usenet)$/.test(String(value.protocol || value.type || '').toLowerCase())
    ? String(value.protocol || value.type).toLowerCase() : 'unknown';
  const size = Math.max(0, Number(value.size) || 0);
  return {
    id: itemId(title, size), title, size, protocol,
    publishedAt: safeDate(value.publishedAt || value.publishDate),
    indexer: cleanText(value.indexer || source.name || '', 100),
    sourceId: cleanText(source.id || '', 80),
    sourceName: cleanText(source.name || source.type || '', 100),
    categories: Array.from(new Set((Array.isArray(value.categories) ? value.categories : [])
      .map((category) => cleanText(category && (category.id || category.name) || category, 80)).filter(Boolean))).slice(0, 20),
  };
}
function ingest(observations, source) {
  const state = load();
  const now = new Date().toISOString();
  const byId = new Map(state.items.map((item) => [item.id, item]));
  let added = 0, updated = 0;
  for (const raw of observations || []) {
    const observation = normalizeObservation(raw, source);
    if (!observation) continue;
    const existing = byId.get(observation.id);
    const origin = {
      sourceId: observation.sourceId, sourceName: observation.sourceName,
      indexer: observation.indexer, protocol: observation.protocol,
    };
    if (!existing) {
      byId.set(observation.id, {
        id: observation.id, title: observation.title, size: observation.size,
        publishedAt: observation.publishedAt, firstSeenAt: now, lastSeenAt: now,
        categories: observation.categories, origins: [origin],
      });
      added++;
    } else {
      existing.lastSeenAt = now;
      if (!existing.publishedAt && observation.publishedAt) existing.publishedAt = observation.publishedAt;
      existing.categories = Array.from(new Set((existing.categories || []).concat(observation.categories))).slice(0, 30);
      existing.origins = Array.isArray(existing.origins) ? existing.origins : [];
      const key = JSON.stringify(origin);
      if (!existing.origins.some((entry) => JSON.stringify(entry) === key)) existing.origins.push(origin);
      existing.origins = existing.origins.slice(0, 20);
      updated++;
    }
  }
  const cutoff = Date.now() - Math.max(1, config.intelligenceRetentionDays) * 86400000;
  const items = Array.from(byId.values()).filter((item) => {
    const seen = new Date(item.lastSeenAt || item.firstSeenAt || 0).getTime();
    return Number.isFinite(seen) && seen >= cutoff;
  }).sort((a, b) => String(b.publishedAt || b.lastSeenAt).localeCompare(String(a.publishedAt || a.lastSeenAt)))
    .slice(0, Math.max(100, config.intelligenceMaxItems));
  save({ version: 1, updatedAt: now, items });
  return { added, updated, total: items.length };
}

function configuredCategories(source) {
  return String(source && source.config && source.config.intelligenceCategories || '5060')
    .split(',').map((value) => cleanText(value, 80)).filter(Boolean);
}
function pruneSourceCategories(source) {
  const sourceId = cleanText(source && source.id, 80);
  const allowed = new Set(configuredCategories(source));
  if (!sourceId || !allowed.size) return { removedOrigins: 0, removedItems: 0 };
  const state = load();
  let removedOrigins = 0, removedItems = 0;
  const items = [];
  for (const item of state.items) {
    const categories = new Set((item.categories || []).map((value) => cleanText(value, 80)));
    const accepted = Array.from(allowed).some((value) => categories.has(value));
    const origins = (item.origins || []).filter((origin) => {
      const remove = origin.sourceId === sourceId && !accepted;
      if (remove) removedOrigins++;
      return !remove;
    });
    if (!origins.length) { removedItems++; continue; }
    items.push(Object.assign({}, item, { origins }));
  }
  if (removedOrigins || removedItems) save({ version: 1, updatedAt: state.updatedAt, items });
  return { removedOrigins, removedItems };
}

function tokens(value) {
  return Array.from(new Set(String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().match(/[a-z0-9]+/g) || [])).filter((token) => token.length >= 2);
}
function queryScore(title, queries) {
  if (!queries.length) return 1;
  const titleTokens = new Set(tokens(title));
  let best = 0;
  for (const query of queries) {
    const wanted = tokens(query);
    if (!wanted.length) continue;
    const hits = wanted.filter((token) => titleTokens.has(token)).length;
    const threshold = Math.min(wanted.length, Math.max(2, Math.ceil(wanted.length * 0.45)));
    if (hits >= threshold) best = Math.max(best, hits / wanted.length);
  }
  return best;
}
function search(options) {
  const opts = options || {};
  const queries = Array.isArray(opts.queries) ? opts.queries.map(String).filter(Boolean)
    : String(opts.query || '').split(/[;\r\n]+/).map((part) => part.trim()).filter(Boolean);
  const protocol = /^(?:torrent|usenet)$/.test(String(opts.protocol || '').toLowerCase())
    ? String(opts.protocol).toLowerCase() : '';
  const sourceId = cleanText(opts.sourceId, 80);
  const limit = Math.max(1, Math.min(5000, Number(opts.limit) || 200));
  const matches = [];
  for (const item of load().items) {
    const origins = Array.isArray(item.origins) ? item.origins : [];
    if (protocol && !origins.some((origin) => origin.protocol === protocol)) continue;
    if (sourceId && !origins.some((origin) => origin.sourceId === sourceId)) continue;
    const score = queryScore(item.title, queries);
    if (!score) continue;
    matches.push(Object.assign({}, item, { score }));
  }
  matches.sort((a, b) => b.score - a.score
    || String(b.publishedAt || b.lastSeenAt).localeCompare(String(a.publishedAt || a.lastSeenAt)));
  return { queries, count: matches.length, results: matches.slice(0, limit), stats: stats() };
}
function stats() {
  const state = load();
  const sources = new Set(), protocols = { torrent: 0, usenet: 0, unknown: 0 };
  for (const item of state.items) for (const origin of item.origins || []) {
    sources.add(origin.sourceId || origin.sourceName);
    protocols[origin.protocol] = (protocols[origin.protocol] || 0) + 1;
  }
  return { total: state.items.length, updatedAt: state.updatedAt, sources: sources.size, protocols,
    retentionDays: config.intelligenceRetentionDays, maxItems: config.intelligenceMaxItems };
}
function exportSafe(options) {
  const result = search(Object.assign({}, options || {}, { limit: 5000 }));
  return {
    format: 'serioussportsync-release-intelligence', version: 1,
    exportedAt: new Date().toISOString(), query: result.queries, count: result.results.length,
    results: result.results.map((item) => ({
      title: item.title, size: item.size, publishedAt: item.publishedAt,
      firstSeenAt: item.firstSeenAt, lastSeenAt: item.lastSeenAt,
      categories: item.categories,
      sources: (item.origins || []).map((origin) => ({
        source: origin.sourceName, indexer: origin.indexer, protocol: origin.protocol,
      })),
    })),
  };
}
async function runCollection() {
  if (activeRun) return activeRun;
  activeRun = (async () => {
    const startedAt = new Date().toISOString();
    const outcomes = [];
    for (const source of settings.enabledSources()) {
      const adapter = registry.get(source.type);
      if (!adapter || typeof adapter.recent !== 'function') {
        outcomes.push({ sourceId: source.id, name: source.name, supported: false, count: 0 });
        continue;
      }
      try {
        const rows = await adapter.recent(source.config || {}, {
          info: (category, message) => log.info(category, message, source.name),
          warn: (category, message) => log.warn(category, message, source.name),
          error: (category, message) => log.error(category, message, source.name),
          debug: (category, message) => log.debug(category, message, source.name),
        });
        const pruned = pruneSourceCategories(source);
        const result = ingest(rows, source);
        outcomes.push({ sourceId: source.id, name: source.name, supported: true,
          count: Array.isArray(rows) ? rows.length : 0, added: result.added,
          removed: pruned.removedItems, total: result.total });
      } catch (error) {
        log.warn('intelligence', source.name + ' collection failed: ' + error.message, source.name);
        outcomes.push({ sourceId: source.id, name: source.name, supported: true, count: 0, error: 'collection failed' });
      }
    }
    lastRun = { startedAt, completedAt: new Date().toISOString(), outcomes };
    log.info('intelligence', 'collection complete: ' + stats().total + ' retained title(s)');
    return lastRun;
  })();
  try { return await activeRun; } finally { activeRun = null; }
}
function status() { return { running: !!activeRun, lastRun, stats: stats() }; }
function startScheduler() {
  if (!config.intelligenceEnabled) return;
  const run = () => runCollection().catch((error) => log.warn('intelligence', 'scheduled collection failed: ' + error.message));
  const startup = setTimeout(run, Math.max(1000, config.intelligenceStartupDelayMs));
  if (startup.unref) startup.unref();
  const interval = setInterval(run, Math.max(5 * 60000, config.intelligenceIntervalMs));
  if (interval.unref) interval.unref();
}

module.exports = { load, ingest, search, stats, exportSafe, runCollection, status, startScheduler,
  pruneSourceCategories, _normalizeObservation: normalizeObservation };
