// /scrape orchestrator.
//
// 1. Validate input.
// 2. Pull enabled sources from settings.
// 3. Run each source's multiSearch in parallel with per-source budget.
// 4. Merge + dedup by infoHash.
// 5. Rank against the requested promotion (see applyRanking).
// 6. Record per-source stats + history entry.
// 7. Return { candidates }.
//
// Sources are a recall stage; step 5 is the precision stage. Ranking is
// promotion-aware and defaults to 'sort', which reorders without dropping
// anything — the metadata addon still receives every candidate and applies its
// own per-promotion relevance + TorBox-cache check downstream. RANK_MODE=off
// restores the previous pass-through behaviour; RANK_MODE=filter drops what
// the promotion rejects.

const settings = require('./settings');
const registry = require('./sources/registry');
const stats = require('./stats');
const log = require('./log-buffer');
const config = require('../config');

// The client-facing scrape deadline and a source's working deadline are two
// different things. Nuvio needs a quick response, while aggregators such as
// Prowlarr may need longer for their indexers. Keep completed background work
// by exact source/query set so a refresh can consume it instead of starting
// from zero again.
const sourceCache = new Map();
const inFlight = new Map();

function sourceKey(source, searchTitles) {
  const titles = Array.from(new Set((searchTitles || [])
    .map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))).sort();
  const sourceShape = {
    id: source.id || source.type || 'source',
    type: source.type || '',
    url: source.config && source.config.url || '',
    categories: source.config && source.config.categories || '',
    limit: source.config && source.config.limit || '',
  };
  return JSON.stringify(sourceShape) + '\n' + JSON.stringify(titles);
}

function readCached(key) {
  const entry = sourceCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > config.sourceCacheTtlMs) {
    sourceCache.delete(key);
    return null;
  }
  // Refresh insertion order for the small LRU.
  sourceCache.delete(key);
  sourceCache.set(key, entry);
  return entry;
}

function writeCached(key, candidates) {
  sourceCache.delete(key);
  sourceCache.set(key, { candidates, storedAt: Date.now() });
  while (sourceCache.size > config.sourceCacheMax) {
    sourceCache.delete(sourceCache.keys().next().value);
  }
}

function tagLog(sourceName) {
  return {
    info:  (cat, msg) => log.info(cat,  msg, sourceName),
    warn:  (cat, msg) => log.warn(cat,  msg, sourceName),
    error: (cat, msg) => log.error(cat, msg, sourceName),
    debug: (cat, msg) => log.debug(cat, msg, sourceName),
  };
}

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ timedOut: true }); } }, ms);
    promise.then((result) => { if (!done) { done = true; clearTimeout(t); resolve({ result }); } })
           .catch((err) => { if (!done) { done = true; clearTimeout(t); resolve({ error: err }); } });
  });
}

async function scrape(input) {
  const { promotion, event, searchTitles } = input || {};
  if (!Array.isArray(searchTitles) || searchTitles.length === 0) {
    log.warn('scrape', 'rejected: missing searchTitles');
    return { candidates: [], error: 'searchTitles required' };
  }
  const sources = settings.enabledSources();
  if (sources.length === 0) {
    log.warn('scrape', 'no sources configured');
    return { candidates: [], note: 'no sources configured' };
  }

  const evLabel = event && event.name ? '"' + event.name + '"' : (event && event.id ? event.id : '?');
  // Callers may request a shorter budget than the operator ceiling. SSS uses
  // this to reserve time for filtering and its TorBox cache check before the
  // client-facing stream deadline. A caller can never extend the ceiling.
  const requestedBudget = Number(input && input.budgetMs);
  const researchMode = input && input.researchMode === true;
  const budgetCeiling = researchMode ? config.researchBudgetMs : config.scrapeBudgetMs;
  const scrapeBudgetMs = Math.max(1000, Math.min(budgetCeiling,
    Number.isFinite(requestedBudget) && requestedBudget > 0
      ? requestedBudget : budgetCeiling));
  const deadlineAt = Date.now() + scrapeBudgetMs;
  log.info('scrape', '/scrape ' + evLabel + ' titles=' + JSON.stringify(searchTitles)
    + ' sources=' + sources.length + ' budget=' + scrapeBudgetMs + 'ms'
    + (researchMode ? ' mode=research' : ''));

  const perSourceResults = [];
  const tasks = sources.map(async (s) => {
    const mod = registry.get(s.type);
    if (!mod) {
      log.warn('scrape', 'unknown source type: ' + s.type, s.name);
      return { sourceId: s.id, sourceName: s.name, candidates: [], error: 'unknown type' };
    }
    const start = Date.now();
    const tlog = tagLog(s.name);
    const key = sourceKey(s, searchTitles);
    const cached = readCached(key);
    if (cached) {
      const ageMs = Date.now() - cached.storedAt;
      log.info('scrape', s.name + ' cache hit: ' + cached.candidates.length
        + ' candidate(s), age ' + ageMs + 'ms', s.name);
      return { sourceId: s.id, sourceName: s.name, candidates: cached.candidates,
        latencyMs: Date.now() - start, cached: true, cacheAgeMs: ageMs };
    }

    const sourceBudget = (s.config && Number(s.config.timeoutMs))
      || Number(mod.defaultTimeoutMs) || config.defaultSourceTimeoutMs;
    const sourceDeadlineAt = Date.now() + sourceBudget;
    const sourceConfig = Object.assign({}, s.config || {}, {
      timeoutMs: sourceBudget,
      _requestDeadlineAt: sourceDeadlineAt,
    });
    let work = inFlight.get(key);
    if (!work) {
      work = Promise.resolve().then(() => mod.multiSearch(searchTitles, sourceConfig, tlog));
      inFlight.set(key, work);
      work.then((result) => {
        const candidates = Array.isArray(result) ? result : [];
        // Do not freeze a transient upstream/network failure as an empty
        // result for the whole TTL. Positive result sets are safe to reuse.
        if (candidates.length > 0) writeCached(key, candidates);
        if (Date.now() >= deadlineAt) {
          log.info('scrape', s.name + ' background search retained '
            + candidates.length + ' candidate(s) for Refresh Links', s.name);
        }
      }).catch(() => {}).finally(() => {
        if (inFlight.get(key) === work) inFlight.delete(key);
      });
    } else {
      log.info('scrape', s.name + ' joining search already running in background', s.name);
    }
    const responseBudget = Math.max(1, deadlineAt - Date.now());
    const wrapped = withTimeout(work, responseBudget);
    const outcome = await wrapped;
    const latencyMs = Date.now() - start;
    if (outcome.timedOut) {
      log.warn('scrape', s.name + ' exceeded the ' + latencyMs
        + 'ms response window; search continues in background', s.name);
      stats.recordError(s.id, 'timeout');
      return { sourceId: s.id, sourceName: s.name, candidates: [], timedOut: true,
        background: true, latencyMs };
    }
    if (outcome.error) {
      log.error('scrape', s.name + ' failed: ' + outcome.error.message, s.name);
      stats.recordError(s.id, outcome.error);
      return { sourceId: s.id, sourceName: s.name, candidates: [], error: outcome.error.message, latencyMs };
    }
    const candidates = Array.isArray(outcome.result) ? outcome.result : [];
    // A source that returns exactly its configured limit did not tell us what
    // it had — it told us where it stopped counting. That is a different
    // failure from "nothing indexed", and until it is recorded separately the
    // two are indistinguishable in History and pull-rate work is guesswork.
    const configuredLimit = Number(s.config && s.config.limit) || 0;
    const truncated = candidates._truncated === true
      || (configuredLimit > 0 && candidates.length >= configuredLimit);
    if (truncated) {
      log.warn('scrape', s.name + ' result set is truncated at ' + candidates.length
        + ' — real matches may be sitting beyond the limit', s.name);
    }
    stats.recordCall(s.id, { latencyMs, candidates: candidates.length });
    log.info('scrape', s.name + ' returned ' + candidates.length + ' candidate(s) in ' + latencyMs + 'ms', s.name);
    return { sourceId: s.id, sourceName: s.name, candidates, latencyMs, truncated };
  });

  const perSource = await Promise.all(tasks);
  for (const ps of perSource) perSourceResults.push(ps);

  // Merge + dedupe by infoHash.
  //
  // We strip the per-candidate `indexer` field on the way out. The metadata
  // addon is supposed to stay source-agnostic — knowing only "the scraper
  // gave me these hashes" — so the internal source attribution stays
  // scraper-side (it's still in our per-source stats + history records for
  // ops visibility on this side of the wire).
  const seen = new Set();
  const merged = [];
  for (const ps of perSource) {
    for (const c of ps.candidates) {
      if (!c || !c.infoHash || seen.has(c.infoHash)) continue;
      seen.add(c.infoHash);
      merged.push({
        infoHash: c.infoHash,
        title: c.title || '',
        size: Number(c.size) || 0,
        seeders: Number(c.seeders) || 0,
        magnetTrackers: Array.isArray(c.magnetTrackers) ? c.magnetTrackers : [],
        publishDate: c.publishDate || null,
        // intentionally no `indexer` — kept scraper-private.
      });
    }
  }
  log.info('scrape', 'merged ' + merged.length + ' unique candidate(s) across ' + sources.length + ' source(s)');

  // Promotion-aware ranking.
  //
  // Sources are a recall stage: they over-fetch deliberately, because a local
  // database can afford it and because a noisy alias buries real hits when the
  // result set is truncated. Precision happens here, using the promotion
  // definition the caller named.
  //
  // A worked example from a real index: the bare alias "EPL" returned 300 rows
  // from Bitmagnet and 100 from its Torznab endpoint. Both were truncated;
  // the Torznab slice was unordered and led with a 2013 season pack, an
  // EpubLibre .epub and a Korean audiobook. Ordering by relevance is what makes
  // truncation cut the tail instead of the head.
  //
  // Default is 'sort', which drops nothing — the addon still gets every
  // candidate and can apply its own pass. 'filter' is opt-in because a
  // candidate dropped here is invisible downstream, and a wrong promotion
  // definition would look like "the release isn't indexed".
  const ranked = applyRanking(merged, promotion, event, input, log);

  // History entry (in-memory only at this layer; lib/history persists).
  try {
    const history = require('./history');
    history.record({
      requestedAt: new Date().toISOString(),
      eventLabel: evLabel,
      searchTitles,
      sourceResults: perSourceResults.map((ps) => ({
        sourceId: ps.sourceId, sourceName: ps.sourceName,
        latencyMs: ps.latencyMs || 0, count: ps.candidates.length,
        timedOut: !!ps.timedOut, background: !!ps.background,
        truncated: !!ps.truncated,
        cached: !!ps.cached, cacheAgeMs: ps.cacheAgeMs || 0,
        error: ps.error || null,
      })),
      mergedCount: merged.length,
      rankMode: ranked.mode,
      rankedCount: ranked.candidates.length,
      rankedDropped: merged.length - ranked.candidates.length,
    });
  } catch (err) {
    log.warn('scrape', 'history persist failed: ' + err.message);
  }

  return { candidates: ranked.candidates };
}

// Returns { candidates, mode }. Never throws: ranking is an improvement, not a
// dependency, so any failure falls back to the unranked merge.
function applyRanking(merged, promotionId, event, input, log) {
  const requested = input && typeof input.rank === 'string' ? input.rank : null;
  const mode = ['off', 'sort', 'filter'].includes(requested) ? requested : config.rankMode;
  if (mode === 'off' || merged.length === 0) return { candidates: merged, mode: 'off' };

  if (!promotionId) {
    log.debug('scrape', 'ranking skipped: request named no promotion');
    return { candidates: merged, mode: 'off' };
  }
  let promotions;
  try {
    promotions = require('./promotions');
  } catch (err) {
    log.warn('scrape', 'ranking unavailable: ' + err.message);
    return { candidates: merged, mode: 'off' };
  }
  // An unknown promotion must not silently empty the response. The addon's
  // ids are its own; ours come from lib/promotions/definitions.
  if (!promotions.get(promotionId)) {
    log.info('scrape', 'ranking skipped: no definition for promotion "'
      + promotionId + '" (known: ' + promotions.list().map((p) => p.id).join(', ') + ')');
    return { candidates: merged, mode: 'off' };
  }

  try {
    const kept = promotions.rank(promotionId, merged, event || {});
    const dropped = merged.length - kept.length;
    if (mode === 'filter') {
      log.info('scrape', 'ranked ' + kept.length + ' candidate(s) for "' + promotionId
        + '", dropped ' + dropped + ' the promotion rejected');
      return { candidates: kept.map(stripScoring), mode };
    }
    // 'sort': keep everything, but lead with what the promotion recognises.
    // Rejected candidates keep their relative order behind the ranked ones.
    const rankedHashes = new Set(kept.map((c) => c.infoHash));
    const rest = merged.filter((c) => !rankedHashes.has(c.infoHash));
    log.info('scrape', 'ranked ' + kept.length + ' of ' + merged.length
      + ' candidate(s) for "' + promotionId + '"; ' + dropped
      + ' unrecognised kept at the tail');
    return { candidates: kept.map(stripScoring).concat(rest), mode };
  } catch (err) {
    log.warn('scrape', 'ranking failed, returning unranked: ' + err.message);
    return { candidates: merged, mode: 'off' };
  }
}

// Scoring internals stay scraper-side, like `indexer`. The addon gets an
// ordered list and a single score it can use as a tiebreak.
function stripScoring(candidate) {
  const out = Object.assign({}, candidate);
  out.score = out._score;
  delete out._score;
  delete out._scoreReasons;
  delete out._parsed;
  return out;
}

module.exports = { scrape, _sourceCache: sourceCache, _inFlight: inFlight };
