'use strict';

const assert = require('assert');
const http = require('http');
const prowlarr = require('../lib/sources/prowlarr');
const torznab = require('../lib/sources/torznab');

const requests = [];
const xml = '<?xml version="1.0"?><rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel>'
  + '<item><title>UFC.300.1080p</title><torznab:attr name="category" value="5060"/></item>'
  + '<item><title>Unrelated.Show.S02E09</title><torznab:attr name="category" value="5070"/></item>'
  + '</channel></rss>';
const server = http.createServer((req, res) => {
  requests.push(req.url);
  if (req.url === '/api/v1/indexer') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify([
      { id: 1, name: 'Torrent Feed', enable: true, protocol: 'torrent', supportsRss: true,
        supportsSearch: true, capabilities: { categories: [{ id: 5000, subCategories: [{ id: 5060 }] }] } },
      { id: 2, name: 'Usenet Search', enable: true, protocol: 'usenet', supportsRss: true,
        supportsSearch: true, capabilities: { categories: [{ id: 5060 }] } },
      { id: 3, name: 'Disabled', enable: false, protocol: 'torrent' },
      { id: 4, name: 'No Sports Mapping', enable: true, protocol: 'usenet', supportsRss: true,
        supportsSearch: true, capabilities: { categories: [{ id: 5070 }] } },
    ]));
  }
  if (req.url.startsWith('/api/v1/search?')) {
    const url = new URL(req.url, 'http://test');
    const id = url.searchParams.get('indexerIds');
    const query = url.searchParams.get('query') || '';
    res.setHeader('Content-Type', 'application/json');
    if (id === '1') return res.end(JSON.stringify([
      { title: 'UFC.300.1080p', categories: [{ id: 5060, name: 'TV/Sport' }], protocol: 'torrent' },
      { title: 'Unrelated.Show.S02E09', categories: [{ id: 5070, name: 'TV/Anime' }], protocol: 'torrent' },
    ]));
    if (id === '2' && query === 'UFC') return res.end(JSON.stringify([
      { title: 'UFC.301.1080p', categories: [{ id: 5060, name: 'TV/Sport' }], protocol: 'usenet' },
    ]));
    if (id === '4' && query === 'UFC') return res.end(JSON.stringify([
      { title: 'UFC.302.Prelims.1080p', categories: [{ id: 5000, name: 'TV' }], protocol: 'usenet' },
      { title: 'Unrelated.Show.S02E09', categories: [{ id: 5000, name: 'TV' }], protocol: 'usenet' },
    ]));
    return res.end('[]');
  }
  if (req.url.startsWith('/torznab?')) {
    res.setHeader('Content-Type', 'application/xml');
    return res.end(xml);
  }
  res.statusCode = 404;
  res.end('not found');
});
const log = { info() {}, warn() {}, error() {}, debug() {} };

assert.deepStrictEqual(prowlarr.categoryIds([{ id: 5000, subCategories: [{ id: 5060 }] }]),
  ['5000', '5060']);
assert.deepStrictEqual(prowlarr.fallbackQueries({ intelligenceFallbackQueriesPerRun: 0 }, 1, 0), []);

server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const prowlarrRows = await prowlarr.recent({ url: base, apiKey: 'test',
      intelligenceFallbackQueries: 'UFC', intelligenceFallbackQueriesPerRun: 1 }, log);
    assert.deepStrictEqual(prowlarrRows.map((row) => row.title).sort(),
      ['UFC.300.1080p', 'UFC.301.1080p', 'UFC.302.Prelims.1080p']);
    assert.strictEqual(prowlarrRows.find((row) => row.title.includes('301')).protocol, 'usenet');
    assert.strictEqual(prowlarrRows.diagnostics.length, 4);
    assert.strictEqual(prowlarrRows.diagnostics.find((row) => row.name === 'Disabled').state, 'disabled');
    const noMapping = prowlarrRows.diagnostics.find((row) => row.name === 'No Sports Mapping');
    assert.strictEqual(noMapping.state, 'working');
    assert.strictEqual(noMapping.titleVerified, 1);
    assert.strictEqual(noMapping.feedRaw, 0);
    assert.strictEqual(noMapping.searchRaw, 2);
    assert.ok(prowlarrRows.find((row) => row.title.includes('302'))
      .categories.includes('title-verified-sport'));
    assert.strictEqual(prowlarrRows.diagnostics.find((row) => row.name === 'Usenet Search').mode, 'rotating search');
    const torznabRows = await torznab.recent({ url: base, apiPath: '/torznab' }, log);
    assert.deepStrictEqual(torznabRows.map((row) => row.title), ['UFC.300.1080p']);
    assert.ok(requests.some((url) => /categories=5060/.test(url)), requests.join('\n'));
    assert.ok(requests.some((url) => /cat=5060/.test(url)), requests.join('\n'));
    assert.ok(requests.some((url) => /indexerIds=1/.test(url)), requests.join('\n'));
    assert.ok(requests.some((url) => /indexerIds=2/.test(url) && /query=UFC/.test(url)), requests.join('\n'));
    assert.ok(requests.some((url) => /indexerIds=4/.test(url) && /query=UFC/.test(url)
      && !/categories=/.test(url)), requests.join('\n'));
    assert.ok(!requests.some((url) => /indexerIds=3/.test(url)), requests.join('\n'));
    assert.ok(prowlarr.matchesFallbackTitle('UFC.300.Prelims.1080p', 'UFC'));
    assert.ok(!prowlarr.matchesFallbackTitle('The Ultimate Fighter S03', 'UFC'));
    assert.ok(prowlarr.matchesFallbackTitle('Formula1.2026.Dutch.GP.F1TV.1080p', 'Formula 1'));
    assert.ok(prowlarr.matchesFallbackTitle('UCL.Arsenal.vs.Atletico.1080p', 'Champions League'));
    assert.ok(prowlarr.matchesFallbackTitle('ONE.FF.168.1080p', 'ONE Friday Fights'));
    console.log('Release Intelligence source filtering tests passed.');
  } finally {
    server.close();
  }
});
