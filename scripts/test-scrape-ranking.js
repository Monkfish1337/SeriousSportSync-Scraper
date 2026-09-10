'use strict';

// Promotion-aware ranking in the /scrape orchestrator.
//
// The candidate titles below are taken verbatim from a real Search run against
// a 10M-row Bitmagnet on the bare alias "EPL" — the hardest case, no
// corroborating context in the query at all. Both Bitmagnet sources truncated
// (100 and 300, exactly their limits); the difference was which rows survived.
// This asserts the ordering that makes truncation cut the tail.

const assert = require('assert');
const path = require('path');
const Module = require('module');

// lib/search pulls in settings/stats/log-buffer, which want a data dir. Point
// DATA_DIR at a scratch path before requiring anything.
process.env.DATA_DIR = path.join(require('os').tmpdir(), 'sss-rank-test-' + process.pid);
require('fs').mkdirSync(process.env.DATA_DIR, { recursive: true });

const settings = require('../lib/settings');
const registry = require('../lib/sources/registry');
const config = require('../config');

// Real titles, real seeder counts.
const GOOD = [
  { infoHash: '1'.repeat(40), title: '20260905_EPL_26.27_R.03_MCI_vs_COV_[rgfootball.net]_720p.25.mkv', size: 3.22e9, seeders: 28 },
  { infoHash: '2'.repeat(40), title: '20260829_EPL_26.27_R.02_TOT_vs_NEW_[rgfootball.net]_720p.25.mkv', size: 3.20e9, seeders: 27 },
  { infoHash: '3'.repeat(40), title: '20260830_EPL_26.27_R.02_MUN_vs_IPS_[rgfootball.net]_720p.50.mkv', size: 4.22e9, seeders: 26 },
];
const NOISE = [
  { infoHash: '4'.repeat(40), title: 'Tabucchi, Antonio - La linea del horizonte [68626] (r1.0 EPL EPL).epub', size: 304764, seeders: 4 },
  { infoHash: '5'.repeat(40), title: '오디오북', size: 25.05e9, seeders: 0 },
  { infoHash: '6'.repeat(40), title: 'hololive English 3rd Concert -All for One-「eplus」', size: 15.46e9, seeders: 21 },
  { infoHash: '7'.repeat(40), title: 'Башня смерти avi', size: 1.61e9, seeders: 0 },
];

// A fake source type returning that mix, in the worst possible order: the
// highest-seeded noise first, exactly as an unordered truncation would.
const FAKE = {
  type: '_ranktest',
  label: 'Rank test',
  description: 'test only',
  schema: [],
  async multiSearch() { return NOISE.concat(GOOD); },
  async test() { return { ok: true, message: 'fake' }; },
};
registry.register(FAKE);

settings.addSource({ type: '_ranktest', name: 'Rank test', enabled: true, config: {} });

const search = require('../lib/search');

function titles(candidates) { return candidates.map((c) => c.title); }

(async () => {
  // ---- default: 'sort' — reorders, drops nothing ----
  assert.equal(config.rankMode, 'sort', 'sort is the shipped default');
  const sorted = await search.scrape({
    promotion: 'epl',
    event: { name: 'Man City vs Coventry', season: '2026/27', round: 3,
      competitors: ['MCI', 'COV'] },
    searchTitles: ['EPL'],
  });
  assert.equal(sorted.candidates.length, GOOD.length + NOISE.length,
    'sort must not drop anything');
  // The exact-event match leads, ahead of noise that had more seeders.
  assert.ok(/MCI_vs_COV/.test(sorted.candidates[0].title), titles(sorted.candidates).join('\n'));
  assert.ok(typeof sorted.candidates[0].score === 'number' && sorted.candidates[0].score > 0);
  // All three real releases rank above every piece of noise.
  const firstNoise = sorted.candidates.findIndex((c) => !/rgfootball/.test(c.title));
  assert.equal(firstNoise, 3, 'all three genuine releases must precede the noise');
  // Scoring internals stay scraper-side.
  for (const c of sorted.candidates) {
    assert.equal(c._score, undefined);
    assert.equal(c._scoreReasons, undefined);
    assert.equal(c._parsed, undefined);
  }

  // ---- per-request 'filter' — drops what the promotion rejects ----
  const filtered = await search.scrape({
    promotion: 'epl', rank: 'filter',
    event: { season: '2026/27', round: 3, competitors: ['MCI', 'COV'] },
    searchTitles: ['EPL filter'],
  });
  assert.equal(filtered.candidates.length, GOOD.length, titles(filtered.candidates).join('\n'));
  assert.ok(!filtered.candidates.some((c) => /epub|eplus|오디오북/.test(c.title)));

  // ---- per-request 'off' — pass-through, merge order preserved ----
  const off = await search.scrape({
    promotion: 'epl', rank: 'off',
    event: {}, searchTitles: ['EPL off'],
  });
  assert.equal(off.candidates.length, GOOD.length + NOISE.length);
  assert.ok(/Tabucchi/.test(off.candidates[0].title), 'merge order untouched');

  // ---- an unknown promotion must NOT empty the response ----
  // The addon's promotion ids are its own; a mismatch has to degrade to
  // pass-through, never to zero candidates.
  const unknown = await search.scrape({
    promotion: 'not-a-real-promotion', rank: 'filter',
    event: {}, searchTitles: ['EPL unknown'],
  });
  assert.equal(unknown.candidates.length, GOOD.length + NOISE.length,
    'unknown promotion must fall back to pass-through');

  // ---- no promotion named at all ----
  const nameless = await search.scrape({ event: {}, searchTitles: ['EPL nameless'] });
  assert.equal(nameless.candidates.length, GOOD.length + NOISE.length);

  // ---- ranking must never be load-bearing ----
  // If the promotion engine throws, the scrape still returns candidates.
  const promotions = require('../lib/promotions');
  const realRank = promotions.rank;
  promotions.rank = () => { throw new Error('boom'); };
  try {
    const survived = await search.scrape({
      promotion: 'epl', event: {}, searchTitles: ['EPL throws'],
    });
    assert.equal(survived.candidates.length, GOOD.length + NOISE.length,
      'a ranking failure must not lose candidates');
  } finally {
    promotions.rank = realRank;
  }

  // History records what ranking did, so a thin event can be diagnosed later.
  const history = require('../lib/history');
  const recent = history.list ? history.list() : [];
  if (recent.length) {
    assert.ok(['sort', 'filter', 'off'].includes(recent[0].rankMode), JSON.stringify(recent[0]));
  }

  console.log('Scrape ranking tests passed.');
})().catch((err) => { console.error(err); process.exit(1); });
