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
  if (req.url.startsWith('/api/v1/search?')) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify([
      { title: 'UFC.300.1080p', categories: [{ id: 5060, name: 'TV/Sport' }], protocol: 'usenet' },
      { title: 'Unrelated.Show.S02E09', categories: [{ id: 5070, name: 'TV/Anime' }], protocol: 'usenet' },
    ]));
  }
  if (req.url.startsWith('/torznab?')) {
    res.setHeader('Content-Type', 'application/xml');
    return res.end(xml);
  }
  res.statusCode = 404;
  res.end('not found');
});
const log = { info() {}, warn() {}, error() {}, debug() {} };

server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const prowlarrRows = await prowlarr.recent({ url: base, apiKey: 'test' }, log);
    assert.deepStrictEqual(prowlarrRows.map((row) => row.title), ['UFC.300.1080p']);
    const torznabRows = await torznab.recent({ url: base, apiPath: '/torznab' }, log);
    assert.deepStrictEqual(torznabRows.map((row) => row.title), ['UFC.300.1080p']);
    assert.ok(requests.some((url) => /categories=5060/.test(url)), requests.join('\n'));
    assert.ok(requests.some((url) => /cat=5060/.test(url)), requests.join('\n'));
    assert.ok(requests.every((url) => !/[?&](?:query|q)=[^&]/.test(url)), requests.join('\n'));
    console.log('Release Intelligence source filtering tests passed.');
  } finally {
    server.close();
  }
});
