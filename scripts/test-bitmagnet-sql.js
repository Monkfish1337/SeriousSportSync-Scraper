'use strict';

// Bitmagnet (Postgres) source tests.
//
// A fake client is injected via `_client`, so these run with no database and
// no `pg` package installed. What is actually being asserted is the SQL shape,
// because the schema traps here are silent ones: `torrents.tsv` was dropped by
// migration 00006 and querying it would only fail at runtime against a real
// index, and `info_hash` is bytea, so forgetting encode() yields hashes that
// look plausible and match nothing.

const assert = require('assert');
const source = require('../lib/sources/bitmagnet-sql');
const registry = require('../lib/sources/registry');

const log = { info() {}, warn() {}, error() {}, debug() {} };
const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);

function fakeClient(rows, capture) {
  return {
    async query(text, params) {
      if (capture) { capture.text = text; capture.params = params; }
      return { rows: typeof rows === 'function' ? rows(text, params) : rows };
    },
  };
}

// ---------------------------------------------------------------------------
// Registered and discoverable by the GUI.
// ---------------------------------------------------------------------------
assert.ok(registry.get('bitmagnet-sql'), 'bitmagnet-sql should be registered');
assert.ok(registry.listTypes().includes('bitmagnet-sql'));
// Requiring the registry must not require `pg` — the dependency is optional and
// loaded only when a query actually runs.
assert.ok(!Object.keys(require.cache).some((k) => /[\\/]node_modules[\\/]pg[\\/]/.test(k)),
  'pg must not be required at registry load time');

// ---------------------------------------------------------------------------
// Schema declaration must match what views/sources.js can actually render.
// ---------------------------------------------------------------------------
const fieldTypes = new Set(['text', 'url', 'secret', 'csv', 'number', 'bool']);
for (const field of source.schema) {
  assert.ok(fieldTypes.has(field.type),
    'unsupported field type "' + field.type + '" on ' + field.name
    + ' — renderField falls back to a text input, so a boolean would save the '
    + 'STRING "false", which is truthy');
  // renderForm() already emits a built-in "Display name" input; declaring one
  // in the schema renders it twice.
  assert.notEqual(field.name, 'label', 'schema must not redeclare the name field');
}

// ---------------------------------------------------------------------------
// SQL shape.
// ---------------------------------------------------------------------------
const built = source._test.buildSearch(['EPL 2025-26 MD24', 'EPL MUN vs MCI'], {
  limit: 300, sizeFloorBytes: 300000000, excludePrivate: true,
});

// Every alias in ONE statement — the whole point of the source.
assert.equal((built.text.match(/websearch_to_tsquery/g) || []).length, 2);
assert.ok(built.text.includes(' OR '), 'aliases must be OR-ed into one query');
assert.deepEqual(built.params.slice(0, 2), ['EPL 2025-26 MD24', 'EPL MUN vs MCI']);

// Searches the GIN-indexed column that actually exists.
assert.ok(built.text.includes('tc.tsv @@'), 'must search torrent_contents.tsv');
assert.ok(!/torrents\.tsv|t\.tsv|search_string/.test(built.text),
  'torrents.tsv and search_string were dropped by migration 00006 — must not be referenced');

// bytea -> hex on the way out.
assert.ok(built.text.includes("encode(t.info_hash, 'hex')"), 'info_hash is bytea');

// One row per torrent even when several torrent_contents rows match.
assert.ok(built.text.includes('DISTINCT ON (t.info_hash)'));

// Filters are parameterised, never interpolated.
assert.ok(built.text.includes('t.size >= $3'));
assert.ok(built.params.includes(300000000));
assert.ok(built.text.includes('t.private = false'));
assert.ok(!/\$\{|'\s*\+\s*/.test(built.text), 'no string interpolation in SQL');

// Ordering exists, so truncation removes the tail rather than the head.
assert.ok(/ORDER BY matches\.seeders DESC/.test(built.text));

// A checkbox left unticked arrives as boolean false, and must not filter.
assert.ok(!source._test.buildSearch(['x'], { excludePrivate: false }).text
  .includes('t.private = false'));
assert.ok(source._test.buildSearch(['x'], { excludePrivate: true }).text
  .includes('t.private = false'));

// No filters configured -> no filter clauses, still valid.
const bare = source._test.buildSearch(['UFC 291'], {});
assert.equal((bare.text.match(/websearch_to_tsquery/g) || []).length, 1);
assert.ok(!bare.text.includes('t.private = false'));
assert.ok(!bare.text.includes('t.size >='));

// ---------------------------------------------------------------------------
// Row mapping.
// ---------------------------------------------------------------------------
const mapped = source._test.rowToCandidate({
  info_hash: HASH_A.toUpperCase(), name: 'EPL 2025-26 MD24 MUN vs MCI 2160p',
  size: '5400000000', seeders: '42', published_at: '2026-02-03T00:00:00Z',
}, { label: 'BM' });
assert.equal(mapped.infoHash, HASH_A, 'hash should be lowercased');
assert.equal(mapped.size, 5400000000);
assert.equal(mapped.seeders, 42);
assert.equal(mapped.indexer, 'BM');
assert.ok(Array.isArray(mapped.magnetTrackers));
assert.equal(mapped.publishDate, '2026-02-03T00:00:00.000Z');

// Migration 00017 defaults published_at to 1999-01-01 rather than NULL. That
// sentinel must not be surfaced as a real publication date.
const sentinel = source._test.rowToCandidate({
  info_hash: HASH_A, name: 'x', size: 1, published_at: '1999-01-01T00:00:00Z',
}, {});
assert.equal(sentinel.publishDate, null, '1999 sentinel must map to unknown');

// Malformed hashes are dropped rather than passed downstream.
assert.equal(source._test.rowToCandidate({ info_hash: 'nothex', name: 'x' }, {}), null);
assert.equal(source._test.rowToCandidate({ info_hash: '', name: 'x' }, {}), null);

// ---------------------------------------------------------------------------
// End-to-end through the injected client.
// ---------------------------------------------------------------------------
(async () => {
  const capture = {};
  const rows = [
    { info_hash: HASH_A, name: 'EPL 2025-26 MD24 MUN vs MCI 2160p', size: 5e9, seeders: 40 },
    { info_hash: HASH_B, name: 'EPL 2025-26 MD24 highlights 720p', size: 2e9, seeders: 5 },
    { info_hash: HASH_A, name: 'duplicate row from a second content match', size: 5e9, seeders: 40 },
    { info_hash: 'bogus', name: 'unusable', size: 1, seeders: 1 },
  ];
  const candidates = await source.multiSearch(
    ['EPL 2025-26 MD24', '  ', 'EPL 2025-26 MD24'],   // blank + duplicate alias
    { _client: fakeClient(rows, capture), label: 'BM' }, log);

  assert.equal(candidates.length, 2, 'duplicates and bad hashes dropped');
  assert.equal(candidates[0].infoHash, HASH_A);
  // Blank and duplicate aliases must not become extra tsquery branches.
  assert.equal((capture.text.match(/websearch_to_tsquery/g) || []).length, 1);
  // The query text must be a SINGLE statement. Prefixing "SET statement_timeout"
  // makes node-postgres return an ARRAY of results, so `result.rows` comes back
  // undefined and every row is silently dropped — a real bug that looked like an
  // empty database. The timeout is a connection parameter instead.
  assert.ok(!/statement_timeout|^\s*SET\s/im.test(capture.text),
    'query text must contain exactly one statement');
  assert.equal(capture.text.trim().split(';').filter((s) => s.trim()).length, 1);

  // An empty alias list is a no-op, not a query.
  const noQuery = {};
  assert.deepEqual(await source.multiSearch([], { _client: fakeClient([], noQuery) }, log), []);
  assert.equal(noQuery.text, undefined, 'no statement should be issued');

  // Truncation is flagged so lib/search.js can record it, same as Torznab.
  const many = Array.from({ length: 5 }, (_, i) => ({
    info_hash: i.toString(16).repeat(40).slice(0, 40), name: 'row ' + i, size: 1e9, seeders: i,
  }));
  const capped = await source.multiSearch(['EPL'], { _client: fakeClient(many), limit: 5 }, log);
  assert.equal(capped._truncated, true, 'a full result set must report truncation');

  // If a driver ever does hand back an array of results, take the last one's
  // rows rather than reading .rows off the array and getting undefined.
  const arrayShaped = {
    async query() {
      return [{ command: 'SET', rows: [] }, { command: 'SELECT', rows: [
        { info_hash: HASH_B, name: 'EPL 2025-26 MD24', size: 2e9, seeders: 3 },
      ] }];
    },
  };
  const fromArray = await source.multiSearch(['EPL'], { _client: arrayShaped }, log);
  assert.equal(fromArray.length, 1, 'array-shaped results must not be discarded');
  assert.equal(fromArray[0].infoHash, HASH_B);

  // A failing query degrades to an empty result rather than killing the scrape.
  const broken = { async query() { throw new Error('connection terminated'); } };
  assert.deepEqual(await source.multiSearch(['EPL'], { _client: broken }, log), []);

  // test() reports schema and scale, and explains common failures in English.
  const probeCapture = {};
  const probe = await source.test({ _client: fakeClient([
    { has_torrents: true, has_contents: true,
      torrents: 41234567, contents: 39000000, version: '16.2' },
  ], probeCapture) }, log);
  assert.equal(probe.ok, true);
  assert.ok(/Postgres 16\.2/.test(probe.message), probe.message);
  assert.ok(/41,234,567 torrents/.test(probe.message), probe.message);
  // count(*) on a multi-million-row table is a full scan (~9s measured on a
  // real index). The probe must use the planner's estimate instead.
  assert.ok(!/count\(\*\)/i.test(probeCapture.text), 'probe must not use count(*)');
  assert.ok(/reltuples/.test(probeCapture.text), 'probe should use reltuples');

  // A missing table is reported as "not a Bitmagnet database" rather than as
  // an empty one — an estimate alone cannot tell those apart.
  const wrongDb = await source.test({ _client: fakeClient([
    { has_torrents: false, has_contents: false, torrents: 0, contents: 0, version: '16.2' },
  ]) }, log);
  assert.equal(wrongDb.ok, false);
  assert.ok(/not a Bitmagnet database/.test(wrongDb.message), wrongDb.message);

  // A genuinely empty but valid Bitmagnet database still reports ok.
  const emptyDb = await source.test({ _client: fakeClient([
    { has_torrents: true, has_contents: true, torrents: 0, contents: 0, version: '16.2' },
  ]) }, log);
  assert.equal(emptyDb.ok, true);
  assert.ok(/0 torrents/.test(emptyDb.message), emptyDb.message);

  // Connection failures are translated into something an operator can act on.
  // These assert the message mapping only — no test here touches the network.
  const failures = [
    ['connect ECONNREFUSED 10.0.0.5:5432', /connection refused/],
    ['getaddrinfo ENOTFOUND postgres', /host not found.*same Docker network/s],
    ['connect ETIMEDOUT 10.0.0.5:5432', /connection timed out/],
    ['password authentication failed for user "ro"', /authentication failed/],
  ];
  for (const [raw, expected] of failures) {
    const probe = await source.test({
      _client: { async query() { throw new Error(raw); } },
    }, log);
    assert.equal(probe.ok, false, raw);
    assert.ok(expected.test(probe.message), raw + ' -> ' + probe.message);
  }

  // Recent feed for Release Intelligence.
  const feed = await source.recent({ _client: fakeClient([
    { info_hash: HASH_A, name: 'EPL 2025-26 MD24 MUN vs MCI', size: 5e9, created_at: '2026-02-03T00:00:00Z' },
    { info_hash: HASH_B, name: '', size: 0, created_at: '2026-02-03T00:00:00Z' },
  ]), intelligenceLimit: 500 }, log);
  assert.equal(feed.length, 1, 'untitled rows dropped');
  assert.equal(feed[0].protocol, 'torrent');

  // Connection string assembly, including passwords needing escaping.
  assert.equal(source._test.connectionString({
    host: 'postgres', database: 'bitmagnet', user: 'ro', password: 'p@ss word',
  }), 'postgres://ro:p%40ss%20word@postgres:5432/bitmagnet');
  assert.equal(source._test.connectionString({ connectionString: 'postgres://x/y' }),
    'postgres://x/y');

  console.log('Bitmagnet SQL source tests passed.');
})().catch((err) => { console.error(err); process.exit(1); });
