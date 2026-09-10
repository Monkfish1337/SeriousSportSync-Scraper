'use strict';

// Bitmagnet, queried directly over Postgres.
//
// The existing `bitmagnet` source type talks to Bitmagnet's Torznab endpoint,
// which is the right thing for a Bitmagnet on someone else's host. But Torznab
// is a lowest-common-denominator wire format designed for remote trackers, and
// when the index is your own database on your own box it throws away
// everything that matters:
//
//   * one `q=` string per request, so N aliases are N round trips
//   * no offset, so a noisy alias silently truncates at `limit`
//   * no ordering, so truncation cuts the head rather than the tail
//   * no access to size/seeders as filter predicates
//
// Against the real EPL corpus, a broad query had ~1,146 genuine hits inside
// 16,985 rows; a 100-row Torznab page surfaced about 0.6% of them. Over here
// we can ask for every alias in one statement, over-fetch by an order of
// magnitude, order by seeders, and let the promotion engine do precision.
//
// SCHEMA NOTES (bitmagnet-io/bitmagnet, migrations/00001, 00006, 00017)
//
//   torrents(info_hash bytea PK, name, size, private, single_file, extension,
//            created_at, updated_at)
//   torrent_contents(info_hash, content_type, title, video_resolution,
//            release_group, tsv tsvector, seeders, leechers, published_at, ...)
//   torrents_torrent_sources(source, info_hash, seeders, leechers, published_at)
//
// Two of those are easy to get wrong:
//
//  1. `torrents.tsv` and `torrents.search_string` DO NOT EXIST on any current
//     schema. Migration 00006 dropped both. The only GIN-indexed full-text
//     column is `torrent_contents.tsv`, so that is what we search — querying
//     `torrents` by name with ILIKE would sequential-scan the whole table.
//  2. `info_hash` is `bytea`, not text. It must be `encode(info_hash,'hex')`
//     on the way out, which is why a raw report shows `\x2210bd10...`.
//
// Seeders/leechers/published_at were denormalised onto torrent_contents by
// migration 00017 and are indexed there, so no join to
// torrents_torrent_sources is needed for ordering.

let pgModule = null;          // lazily required; see loadPg()
const pools = new Map();      // connection string -> pool, reused across calls

const DEFAULT_LIMIT = 300;
const DEFAULT_CANDIDATE_MULTIPLIER = 4;

function loadPg() {
  if (pgModule) return pgModule;
  try {
    pgModule = require('pg');
  } catch (err) {
    throw new Error('the "pg" package is not installed — run `pnpm add pg` to '
      + 'use the Bitmagnet (Postgres) source, or use the Torznab-based '
      + '"bitmagnet" source instead');
  }
  return pgModule;
}

function connectionString(sourceConfig) {
  if (sourceConfig.connectionString) return String(sourceConfig.connectionString);
  const user = encodeURIComponent(sourceConfig.user || 'postgres');
  const password = encodeURIComponent(sourceConfig.password || '');
  const host = sourceConfig.host || 'localhost';
  const port = Number(sourceConfig.port) || 5432;
  const database = sourceConfig.database || 'bitmagnet';
  const auth = password ? user + ':' + password : user;
  return 'postgres://' + auth + '@' + host + ':' + port + '/' + database;
}

function getPool(sourceConfig) {
  // Tests inject a client rather than opening a socket.
  if (sourceConfig._client) return sourceConfig._client;
  const key = connectionString(sourceConfig);
  if (!pools.has(key)) {
    const { Pool } = loadPg();
    pools.set(key, new Pool({
      connectionString: key,
      max: Math.max(1, Math.min(10, Number(sourceConfig.poolSize) || 4)),
      connectionTimeoutMillis: Number(sourceConfig.timeoutMs) || 12000,
      idleTimeoutMillis: 30000,
      // Both of these are connection parameters rather than statements.
      //
      // read_only: anything that tries to write is a bug, and this makes it
      // fail loudly rather than mutating the user's index.
      //
      // statement_timeout: keeps a pathological query from outliving the
      // scrape budget and holding a connection open behind it. It MUST be set
      // here and not by prefixing "SET statement_timeout" onto the query text:
      // node-postgres returns an ARRAY of results for multi-statement text, so
      // `result.rows` is undefined and every row is silently discarded. SET
      // LOCAL outside an explicit transaction is a no-op anyway.
      options: '-c default_transaction_read_only=on'
        + ' -c statement_timeout=' + Math.max(1000, Number(sourceConfig.timeoutMs) || 12000),
    }));
  }
  return pools.get(key);
}

// Builds the search statement for every alias at once.
//
// One statement, one round trip, one planner pass — instead of one request per
// alias. Each alias becomes its own `tsv @@ websearch_to_tsquery(...)` so the
// GIN index on torrent_contents.tsv is usable for each branch of the OR.
//
// websearch_to_tsquery (not plainto_tsquery) because it tolerates the
// punctuation that turns up in generated search titles without throwing, and
// supports quoted phrases if an operator wants them in an alias.
function buildSearch(queries, sourceConfig) {
  const params = [];
  const clauses = [];
  for (const query of queries) {
    params.push(query);
    clauses.push('tc.tsv @@ websearch_to_tsquery(\'simple\', $' + params.length + ')');
  }

  const filters = [];
  const sizeFloor = Number(sourceConfig.sizeFloorBytes) || 0;
  if (sizeFloor > 0) {
    params.push(sizeFloor);
    filters.push('t.size >= $' + params.length);
  }
  if (sourceConfig.excludePrivate) {
    // Private torrents cannot be resolved from a hash by a public debrid
    // service, so for this pipeline they are noise.
    filters.push('t.private = false');
  }
  const maxAgeDays = Number(sourceConfig.maxAgeDays) || 0;
  if (maxAgeDays > 0) {
    params.push(maxAgeDays);
    filters.push('t.created_at >= now() - ($' + params.length + ' || \' days\')::interval');
  }

  const limit = Math.max(1, Math.min(5000, Number(sourceConfig.limit) || DEFAULT_LIMIT));
  const inner = limit * (Number(sourceConfig.candidateMultiplier)
    || DEFAULT_CANDIDATE_MULTIPLIER);
  params.push(inner);
  const innerLimitParam = '$' + params.length;
  params.push(limit);
  const outerLimitParam = '$' + params.length;

  // A torrent can carry several torrent_contents rows (one per content match),
  // so DISTINCT ON collapses to one row per info_hash, keeping the best-seeded.
  // DISTINCT ON forces its own ORDER BY, hence the outer re-sort.
  const text = [
    'SELECT * FROM (',
    '  SELECT DISTINCT ON (t.info_hash)',
    '    encode(t.info_hash, \'hex\') AS info_hash,',
    '    t.name          AS name,',
    '    t.size          AS size,',
    '    t.private       AS private,',
    '    tc.seeders      AS seeders,',
    '    tc.leechers     AS leechers,',
    '    tc.published_at AS published_at,',
    '    tc.video_resolution AS video_resolution,',
    '    tc.release_group    AS release_group,',
    '    t.created_at    AS created_at',
    '  FROM torrent_contents tc',
    '  JOIN torrents t ON t.info_hash = tc.info_hash',
    '  WHERE (' + clauses.join(' OR ') + ')',
    filters.length ? '    AND ' + filters.join('\n    AND ') : '',
    '  ORDER BY t.info_hash, tc.seeders DESC NULLS LAST',
    '  LIMIT ' + innerLimitParam,
    ') matches',
    'ORDER BY matches.seeders DESC NULLS LAST, matches.published_at DESC',
    'LIMIT ' + outerLimitParam,
  ].filter(Boolean).join('\n');

  return { text, params, limit };
}

function rowToCandidate(row, sourceConfig) {
  const hash = String(row.info_hash || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hash)) return null;
  let publishDate = null;
  if (row.published_at) {
    const date = new Date(row.published_at);
    // Migration 00017 defaults published_at to 1999-01-01 rather than null,
    // so treat that sentinel as "unknown" instead of surfacing a fake date.
    if (!Number.isNaN(date.getTime()) && date.getUTCFullYear() > 1999) {
      publishDate = date.toISOString();
    }
  }
  return {
    infoHash: hash,
    title: String(row.name || ''),
    size: Number(row.size) || 0,
    seeders: Number(row.seeders) || 0,
    indexer: sourceConfig.label || 'Bitmagnet (SQL)',
    magnetTrackers: [],
    publishDate,
  };
}

// One statement per call. See the `options` note in getPool() for why the
// statement timeout is a connection parameter rather than a prefixed SET.
async function runQuery(sourceConfig, text, params, log) {
  const pool = getPool(sourceConfig);
  const result = await pool.query(text, params);
  // Defensive: node-postgres hands back an array of results if the text ever
  // does contain several statements. Taking .rows off the array yields
  // undefined, which reads downstream as "the database returned nothing" —
  // an empty result that is really a bug. Use the last statement's rows.
  if (Array.isArray(result)) {
    const last = result[result.length - 1];
    return (last && last.rows) || [];
  }
  return (result && result.rows) || [];
}

async function multiSearch(queries, sourceConfig, log) {
  const unique = Array.from(new Set((queries || [])
    .map((q) => String(q || '').trim()).filter(Boolean)));
  if (unique.length === 0) return [];

  const { text, params, limit } = buildSearch(unique, sourceConfig);
  const started = Date.now();
  let rows;
  try {
    rows = await runQuery(sourceConfig, text, params, log);
  } catch (err) {
    log.error('source', 'bitmagnet-sql query failed: ' + err.message);
    return [];
  }

  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const candidate = rowToCandidate(row, sourceConfig);
    if (!candidate || seen.has(candidate.infoHash)) continue;
    seen.add(candidate.infoHash);
    out.push(candidate);
  }

  log.info('source', 'bitmagnet-sql ' + unique.length + ' alias(es) in one query -> '
    + out.length + ' candidate(s) in ' + (Date.now() - started) + 'ms');
  if (out.length >= limit) {
    out._truncated = true;
    log.warn('source', 'bitmagnet-sql hit its row limit of ' + limit
      + ' — raise "Limit per query"; over-fetching against a local database is cheap');
  }
  return out;
}

// Recent-feed capability for Release Intelligence. Bitmagnet ingests thousands
// of rows an hour locally, so this is a far better naming corpus than a remote
// indexer's category feed — and it costs one indexed ORDER BY.
async function recent(sourceConfig, log) {
  const limit = Math.max(1, Math.min(5000,
    Number(sourceConfig.intelligenceLimit) || 500));
  const text = [
    'SELECT encode(t.info_hash, \'hex\') AS info_hash, t.name, t.size,',
    '       t.created_at, tc.published_at, tc.content_type',
    'FROM torrents t',
    'LEFT JOIN torrent_contents tc ON tc.info_hash = t.info_hash',
    'ORDER BY t.created_at DESC',
    'LIMIT $1',
  ].join('\n');
  let rows;
  try {
    rows = await runQuery(sourceConfig, text, [limit], log);
  } catch (err) {
    log.error('intelligence', 'bitmagnet-sql recent feed failed: ' + err.message);
    throw new Error('Bitmagnet SQL recent feed failed');
  }
  return rows.map((row) => ({
    title: String(row.name || ''),
    size: Number(row.size) || 0,
    publishedAt: row.published_at || row.created_at || null,
    indexer: sourceConfig.label || 'Bitmagnet (SQL)',
    protocol: 'torrent',
    categories: [],
  })).filter((row) => row.title);
}

async function test(sourceConfig, log) {
  const start = Date.now();
  try {
    // Diagnostic, and deliberately NOT count(*). An exact count on a
    // multi-million-row table is a full scan — it measured ~9s on a real
    // index, which is most of a scrape budget spent proving the obvious.
    // reltuples is the planner's estimate, maintained by ANALYZE, and returns
    // instantly. to_regclass distinguishes "table is missing" from "table is
    // empty", which an estimate alone cannot.
    const rows = await runQuery(sourceConfig, [
      'SELECT',
      '  to_regclass(\'public.torrents\')         IS NOT NULL AS has_torrents,',
      '  to_regclass(\'public.torrent_contents\') IS NOT NULL AS has_contents,',
      '  coalesce((SELECT reltuples::bigint FROM pg_class',
      '            WHERE oid = to_regclass(\'public.torrents\')), 0)         AS torrents,',
      '  coalesce((SELECT reltuples::bigint FROM pg_class',
      '            WHERE oid = to_regclass(\'public.torrent_contents\')), 0) AS contents,',
      '  current_setting(\'server_version\') AS version',
    ].join('\n'), [], log);
    const latencyMs = Date.now() - start;
    const row = rows[0];
    if (!row) {
      return { ok: false, latencyMs,
        message: 'the probe returned no rows — this should not happen; check the logs' };
    }
    if (!row.has_torrents || !row.has_contents) {
      return { ok: false, latencyMs,
        message: 'connected, but this is not a Bitmagnet database (no '
          + (row.has_torrents ? 'torrent_contents' : 'torrents') + ' table)' };
    }
    return {
      ok: true, latencyMs,
      message: 'Postgres ' + (row.version || '?') + ' — ~'
        + Number(row.torrents || 0).toLocaleString() + ' torrents, ~'
        + Number(row.contents || 0).toLocaleString() + ' classified (estimated)',
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    let message = err.message;
    if (/relation "torrent_contents" does not exist/i.test(message)) {
      message = 'connected, but this is not a Bitmagnet database (no torrent_contents table)';
    } else if (/password authentication failed/i.test(message)) {
      message = 'authentication failed — check user and password';
    } else if (/ECONNREFUSED/i.test(message)) {
      message = 'connection refused — check host and port, and that Postgres accepts TCP connections';
    } else if (/ENOTFOUND|EAI_AGAIN/i.test(message)) {
      // Overwhelmingly a Docker service name that this container cannot see,
      // because the two stacks are not on a shared network.
      message = 'host not found — if Bitmagnet runs in Docker, use its service '
        + 'name and put this service on the same Docker network';
    } else if (/ETIMEDOUT|timeout expired/i.test(message)) {
      message = 'connection timed out — check the host is reachable and the port is open';
    }
    return { ok: false, latencyMs, message };
  }
}

async function shutdown() {
  const closing = Array.from(pools.values()).map((pool) => pool.end && pool.end());
  pools.clear();
  await Promise.all(closing);
}

module.exports = {
  type: 'bitmagnet-sql',
  label: 'Bitmagnet (Postgres)',
  description: 'Queries Bitmagnet\'s Postgres database directly. Every alias goes '
    + 'in one round trip and results can be over-fetched and ordered, which Torznab '
    + 'cannot do. Use this when Bitmagnet\'s database is reachable from this service.',
  schema: [
    // No 'label' field here: renderForm() already emits a built-in "Display
    // name" input, so declaring one duplicates it in the form.
    { name: 'host', label: 'Postgres host', type: 'text', required: true,
      placeholder: 'postgres', hint: 'Container or host name of Bitmagnet\'s database.' },
    { name: 'port', label: 'Port', type: 'number', default: 5432 },
    { name: 'database', label: 'Database', type: 'text', default: 'bitmagnet' },
    { name: 'user', label: 'User', type: 'text', default: 'postgres',
      hint: 'A read-only role is recommended; this source never writes.' },
    { name: 'password', label: 'Password', type: 'secret' },
    { name: 'limit', label: 'Limit per query', type: 'number', default: DEFAULT_LIMIT,
      hint: 'Rows returned after ranking. Local queries are cheap — over-fetch here and let filtering do precision.' },
    { name: 'sizeFloorBytes', label: 'Minimum size (bytes)', type: 'number', default: 0,
      hint: 'Optional. Drops samples, subtitle packs and stray documents before they reach the addon.' },
    // 'bool', not 'boolean' — renderField only recognises 'bool'. Anything
    // else renders as a text input whose value is the STRING "false", which is
    // truthy, so the filter would silently apply when switched off.
    { name: 'excludePrivate', label: 'Exclude private torrents', type: 'bool', default: false,
      hint: 'Private torrents cannot be resolved by hash through a debrid provider.' },
    { name: 'maxAgeDays', label: 'Max age (days)', type: 'number', default: 0,
      hint: 'Optional. 0 means no age limit.' },
    { name: 'timeoutMs', label: 'Timeout (ms)', type: 'number', default: 12000 },
    { name: 'intelligenceLimit', label: 'Recent titles per collection', type: 'number', default: 500 },
  ],
  multiSearch, recent, test, shutdown,
  _test: { buildSearch, rowToCandidate, connectionString },
};
