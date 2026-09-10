'use strict';

// Promotion engine tests.
//
// The interesting assertions here are the negative ones. A real Bitmagnet
// report for "epl" returned 16,985 rows, of which ~1,150 were genuine football
// and the rest were three noise families: adult releases containing
// "roleplay"/"foreplay"/"replay", EpubLibre books tagged "(r1.0 EPL).epub",
// and "EPL@<ip>" spam. Any matcher that cannot reject those is unusable
// against a real index, so representatives of each are asserted here.

const assert = require('assert');
const promotions = require('../lib/promotions');
const { compile } = require('../lib/promotions/compile');

// ---------------------------------------------------------------------------
// Registry loads and every shipped definition compiles.
// ---------------------------------------------------------------------------
const listed = promotions.list();
assert.ok(listed.length >= 5, 'expected several promotions, got ' + listed.length);
assert.ok(promotions.get('epl'), 'epl definition should load');
assert.ok(promotions.get('ufc'), 'ufc definition should load');
assert.equal(promotions.get('nope'), null);

const epl = promotions.get('epl');
const ufc = promotions.get('ufc');

// ---------------------------------------------------------------------------
// Real EPL naming shapes, taken verbatim from the report.
// ---------------------------------------------------------------------------
const EPL_POSITIVE = [
  '20260203_EPL_25.26_R.24_MUN_vs_MCI_[rgfootball.net]_720p.50.mkv',
  'EPL 2025-26. MD16. Review [16.12.2025].mkv',
  'EPL.25_26.27th.round.WHU_BOU_21.02.26_720.mkv',
  'EPL.2020-2021.36tour.Newcastle.United.vs.Manchester.City.1080p50.RGSport.mkv',
  'EPL - Southampton vs Crystal Palace 30.01.19',
  '2020-2021. EPL. 27. Man City - Man United.mkv',
  'EPL.2014.09.27.Manchester United vs West Ham.DANISH.720p.x264',
  'EPL 2024-25. Goals of the Season.mkv',
  'www.SceneTime.com - EPL 2020 06 23 Tottenham Hotspur vs West Ham United XviD-AFG',
];
for (const title of EPL_POSITIVE) {
  assert.ok(epl.test(title), 'should match EPL: ' + title);
}

const EPL_NEGATIVE = [
  'New.Carly.Kiss.Horny.Little.Step.Sister.2026.Hardcore.Roleplay.Family.ILUVY.mp4',
  'Skip The Foreplay - Nightlife (2012)',
  'Applian Replay Music 8.0.1.13 - SeuPirate',
  'Offutt, Chris - Noche cerrada [55743] (r1.3 EPL).epub',
  'Tabucchi, Antonio - La linea del horizonte [68626] (r1.0 EPL EPL).epub',
  'EPL@38.100.22.211 bbss@絶・潮吹き昇天痙攣地獄',
  'Custom Reido F Special Edition v301 (DeepL 2022-07-03)',
];
for (const title of EPL_NEGATIVE) {
  assert.ok(!epl.test(title), 'should NOT match EPL: ' + title);
}

// The \b trap: "_EPL_" has no word boundary because "_" is a word character.
assert.ok(epl.test('20241110_EPL_24.25_R.11_NFO_vs_NEW_720p.50.mkv'),
  'underscore-delimited token must still match');

// ---------------------------------------------------------------------------
// Parsing.
// ---------------------------------------------------------------------------
const p1 = epl.parse('20260203_EPL_25.26_R.24_MUN_vs_MCI_[rgfootball.net]_720p.50.mkv');
assert.equal(p1.season, '2025/26');
assert.equal(p1.round, 24);
assert.deepEqual(p1.competitors, ['MUN', 'MCI']);
assert.equal(p1.quality, '720p');

// Both three-letter codes must survive even though they share one separator.
const p2 = epl.parse('EPL.25_26.27th.round.WHU_BOU_21.02.26_720.mkv');
assert.deepEqual(p2.competitors, ['WHU', 'BOU']);
assert.equal(p2.round, 27);
// "25_26.27" is date-shaped but not a valid calendar date; the real one wins.
assert.equal(p2.date, '2026-02-21');

// Separator normalisation: "Manchester.City" is the same club as "Manchester City".
const p3 = epl.parse('EPL.2020-2021.36tour.Newcastle.United.vs.Manchester.City.1080p50.mkv');
assert.ok(p3.competitors.includes('Manchester City'), JSON.stringify(p3.competitors));
assert.equal(p3.season, '2020/21');

const p4 = ufc.parse('UFC.291.PPV.1080p.WEB-DL');
assert.equal(p4.eventNo, 291);
assert.equal(p4.quality, '1080p');

// ---------------------------------------------------------------------------
// Ambiguity classes behave differently.
// ---------------------------------------------------------------------------
assert.equal(epl.tokenAmbiguity, 'high');
assert.equal(ufc.tokenAmbiguity, 'low');
// A low-ambiguity token stands on its own...
assert.ok(ufc.test('UFC 291'));
// ...a high-ambiguity one does not.
assert.ok(!epl.test('Bolero EPL'), 'bare high-ambiguity token must not match');

// A high-ambiguity definition with nothing to corroborate against is refused
// at load time rather than silently matching everything.
assert.throws(() => compile({
  id: 'bad', label: 'Bad', tokens: ['ONE'], tokenAmbiguity: 'high',
}), /requires contextTokens/);

// ---------------------------------------------------------------------------
// Query generation. Templates referencing a field the event lacks are skipped
// rather than emitting a half-filled query.
// ---------------------------------------------------------------------------
const queries = epl.queries({
  season: '2025/26', round: 24,
  competitors: ['Manchester United', 'Manchester City'], date: '2026-02-03',
});
assert.ok(queries.includes('EPL 2025-26 MD24'), queries.join(' | '));
assert.ok(queries.includes('EPL Manchester United vs Manchester City'), queries.join(' | '));
assert.ok(queries.every((q) => !q.includes('{')), 'no unfilled placeholders: ' + queries.join(' | '));

const sparse = ufc.queries({ eventNo: 291, name: 'UFC 291' });
assert.ok(sparse.includes('UFC 291'));
assert.ok(sparse.every((q) => !q.includes('{')));
// No competitors supplied, so the "{home} vs {away}" template is dropped.
assert.ok(!sparse.some((q) => /vs/i.test(q)), sparse.join(' | '));

// ---------------------------------------------------------------------------
// Ranking: the precision half of the two-stage design.
// ---------------------------------------------------------------------------
const candidates = [
  { infoHash: 'a', title: 'EPL 2025-26. MD24. Manchester United vs Manchester City 2160p', size: 5e9, seeders: 40 },
  { infoHash: 'b', title: 'EPL 2025-26. MD12. Arsenal vs Chelsea 720p', size: 2e9, seeders: 5 },
  { infoHash: 'c', title: 'Some.Random.Roleplay.Release.mp4', size: 3e8, seeders: 999 },
  { infoHash: 'd', title: 'EPL 2025-26 MD24 preview', size: 1e6, seeders: 100 },
];
const ranked = promotions.rank('epl', candidates, {
  season: '2025/26', round: 24, competitors: ['Manchester United', 'Manchester City'],
});
assert.equal(ranked[0].infoHash, 'a', 'exact event match should rank first');
assert.ok(!ranked.some((c) => c.infoHash === 'c'), 'noise must be dropped');
assert.ok(!ranked.some((c) => c.infoHash === 'd'), 'sub-size-floor entry must be dropped');
assert.ok(ranked[0]._score > ranked[1]._score);
assert.ok(Array.isArray(ranked[0]._scoreReasons) && ranked[0]._scoreReasons.length > 0);

// An unknown promotion passes candidates through rather than dropping them.
assert.equal(promotions.rank('unknown-promotion', candidates, {}).length, candidates.length);

// UFC event-number mismatch is a hard reject, not a low score.
const ufcRanked = promotions.rank('ufc', [
  { infoHash: 'x', title: 'UFC.291.PPV.1080p.WEB-DL', size: 5e9, seeders: 10 },
  { infoHash: 'y', title: 'UFC.292.PPV.1080p.WEB-DL', size: 5e9, seeders: 900 },
], { eventNo: 291 });
assert.equal(ufcRanked.length, 1);
assert.equal(ufcRanked[0].infoHash, 'x');

// ---------------------------------------------------------------------------
// classify() picks the least ambiguous promotion when several could claim a title.
// ---------------------------------------------------------------------------
const classified = promotions.classify('UFC.291.PPV.1080p.WEB-DL');
assert.equal(classified.promotion, 'ufc');

// ---------------------------------------------------------------------------
// Definition ids must match the ids the metadata addon actually sends.
//
// lib/sources/companion-scraper.js posts `promotion: promotion.id` verbatim, so
// a definition filed under a different slug silently never ranks anything. This
// list is the addon's own ids for the promotions we currently define.
// ---------------------------------------------------------------------------
const ADDON_IDS = ['epl', 'ucl', 'ufc', 'one', 'f1', 'nfl', 'nba', 'wwe', 'aew'];
for (const id of ADDON_IDS) {
  assert.ok(promotions.get(id),
    'no definition for addon promotion id "' + id + '" — ranking would no-op');
}
assert.equal(promotions.classify('Totally unrelated linux iso 2024'), null);

// ---------------------------------------------------------------------------
// Emitted patterns are RE2-safe so they can be pushed into Postgres/Go.
// ---------------------------------------------------------------------------
for (const listedPromotion of listed) {
  const compiled = promotions.get(listedPromotion.id);
  for (const source of [compiled.patterns.match, compiled.patterns.negative]) {
    if (!source) continue;
    assert.ok(!/\(\?[=!<]/.test(source),
      listedPromotion.id + ' pattern must not use lookaround: ' + source.slice(0, 80));
    assert.ok(!/\\[1-9]/.test(source),
      listedPromotion.id + ' pattern must not use backreferences');
    new RegExp(source, 'i');   // must be a valid regex
  }
}

console.log('Promotion engine tests passed (' + listed.length + ' definitions).');
