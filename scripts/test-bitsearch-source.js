'use strict';

// The bitsearch source used to answer "responding, 0 hit(s)" for every kind of
// failure: a blocked IP, a Cloudflare page served as 200 HTML, a base URL with
// the API path already on it, and an index that genuinely had nothing all
// produced the same green health card. These tests pin each apart.

const assert = require('assert');
const http = require('http');
const bitsearch = require('../lib/sources/bitsearch');

const { endpointUrl, retryAfterMs, resetPacing } = bitsearch._test;
const log = { info() {}, warn() {}, error() {}, debug() {} };

const HASH = 'b'.repeat(40);
const payload = (results) => JSON.stringify({ success: true, query: 'x', results, took: 1 });

// bitsearch.eu answered a real collection run with HTTP 429. Free endpoint, no
// key, one shared egress IP — so the source has to pace itself and back off
// when told to, and must not report a rate limit as "unreachable".
let limitedHits = 0;

// One server, several routes — each stands for a real failure mode.
const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/api/v1/search') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(payload([
      { infohash: HASH, title: 'UFC.300.1080p.WEB', size: 123, seeders: 9, verified: true, createdAt: '2026-01-01' },
      { infohash: 'not-a-hash', title: 'junk', size: 1, seeders: 0 },
    ]));
  }
  if (path === '/empty/api/v1/search') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(payload([]));
  }
  if (path === '/nohash/api/v1/search') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(payload([{ infoHash: HASH, title: 'renamed field', size: 1 }]));
  }
  if (path === '/limited/api/v1/search') {
    // Always limited — proves the retry happens and then gives up cleanly.
    limitedHits += 1;
    res.statusCode = 429;
    res.setHeader('Retry-After', '1');
    return res.end('rate limited');
  }
  if (path === '/recovers/api/v1/search') {
    // Limited once, then fine: the retry must actually rescue the search.
    limitedHits += 1;
    if (limitedHits === 1) {
      res.statusCode = 429;
      res.setHeader('Retry-After', '1');
      return res.end('rate limited');
    }
    res.setHeader('Content-Type', 'application/json');
    return res.end(payload([{ infohash: HASH, title: 'UFC.300.1080p.WEB', size: 1, seeders: 1 }]));
  }
  if (path === '/challenge/api/v1/search') {
    // A bot challenge is served as 200 text/html, not as an error status.
    res.setHeader('Content-Type', 'text/html');
    return res.end('<html><head><title>Just a moment...</title></head><body>cf-browser-verification</body></html>');
  }
  res.statusCode = 404;
  res.end('nope');
});

server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    // A pasted full endpoint must not become /api/v1/search/api/v1/search.
    assert.equal(endpointUrl({ url: base }), base + '/api/v1/search');
    assert.equal(endpointUrl({ url: base + '/' }), base + '/api/v1/search');
    assert.equal(endpointUrl({ url: base + '/api/v1/search' }), base + '/api/v1/search');
    assert.equal(endpointUrl({}), 'https://bitsearch.eu/api/v1/search');

    // Happy path: usable rows returned, junk hashes dropped and reported.
    resetPacing();
    const good = await bitsearch.test({ url: base, probeQuery: 'UFC 300', minIntervalMs: 0 }, log);
    assert.equal(good.ok, true, good.message);
    assert.ok(/1 hit\(s\)/.test(good.message), good.message);
    assert.ok(/1 dropped/.test(good.message), good.message);

    const rows = await bitsearch.multiSearch(['UFC 300'], { url: base, minIntervalMs: 0 }, log);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].infoHash, HASH);
    assert.equal(rows[0].indexer, 'bitsearch:verified');

    // Reached the API, index had nothing — honest, and says so.
    const empty = await bitsearch.test({ url: base + '/empty', minIntervalMs: 0 }, log);
    assert.equal(empty.ok, true, empty.message);
    assert.ok(/0 hit\(s\)/.test(empty.message), empty.message);
    assert.ok(/index empty/.test(empty.message), empty.message);

    // Results came back but the hash field was renamed: a failure, not "0 hits".
    const shape = await bitsearch.test({ url: base + '/nohash', minIntervalMs: 0 }, log);
    assert.equal(shape.ok, false, shape.message);
    assert.ok(/API shape may have changed/.test(shape.message), shape.message);

    // Bot challenge as 200 HTML: a failure naming the cause.
    const blocked = await bitsearch.test({ url: base + '/challenge', minIntervalMs: 0 }, log);
    assert.equal(blocked.ok, false, blocked.message);
    assert.ok(/blocking this IP/.test(blocked.message), blocked.message);

    // A 404 (wrong base URL) is a failure, not a green card.
    const missing = await bitsearch.test({ url: base + '/wrong/path/x', minIntervalMs: 0 }, log);
    assert.equal(missing.ok, false, missing.message);
    assert.ok(/HTTP 404/.test(missing.message), missing.message);

    // Host down: network error, reported as such.
    const dead = await bitsearch.test({ url: 'http://127.0.0.1:1', timeoutMs: 1500, minIntervalMs: 0 }, log);
    assert.equal(dead.ok, false, dead.message);
    assert.ok(/unreachable/.test(dead.message), dead.message);

    // Retry-After parsing: seconds, HTTP date, junk, and the cap.
    assert.equal(retryAfterMs('2', 30000), 2000);
    assert.equal(retryAfterMs('600', 30000), 30000, 'a long wait must be capped');
    assert.equal(retryAfterMs('', 30000), 0);
    assert.equal(retryAfterMs('nonsense', 30000), 0);
    assert.equal(retryAfterMs(null, 30000), 0);
    assert.ok(retryAfterMs(new Date(Date.now() + 3000).toUTCString(), 30000) > 1000);

    // Persistent 429: retried once, then reported as a rate limit — NOT as
    // unreachable, which would send you debugging DNS and the VPN instead.
    resetPacing();
    limitedHits = 0;
    const limited = await bitsearch.test({ url: base + '/limited', minIntervalMs: 0 }, log);
    assert.equal(limited.ok, false, limited.message);
    assert.equal(limitedHits, 2, 'a 429 must be retried exactly once');
    assert.ok(/rate limited/.test(limited.message), limited.message);
    assert.ok(!/unreachable/.test(limited.message), limited.message);

    // A transient 429 must be rescued by the retry, not surfaced as a failure.
    resetPacing();
    limitedHits = 0;
    const recovered = await bitsearch.test({ url: base + '/recovers', minIntervalMs: 0 }, log);
    assert.equal(recovered.ok, true, recovered.message);
    assert.ok(/1 hit\(s\)/.test(recovered.message), recovered.message);

    // Requests are spaced process-wide, so concurrent searches can't burst.
    resetPacing();
    const started = Date.now();
    await Promise.all([
      bitsearch.multiSearch(['a'], { url: base, minIntervalMs: 120 }, log),
      bitsearch.multiSearch(['b'], { url: base, minIntervalMs: 120 }, log),
      bitsearch.multiSearch(['c'], { url: base, minIntervalMs: 120 }, log),
    ]);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 240, 'three concurrent searches must be paced, took ' + elapsed + 'ms');

    console.log('bitsearch source tests passed');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
