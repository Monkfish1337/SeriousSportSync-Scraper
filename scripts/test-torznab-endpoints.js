'use strict';

const assert = require('assert');
const http = require('http');
const bitmagnet = require('../lib/sources/bitmagnet');
const torznab = require('../lib/sources/torznab');

const HASH = 'a'.repeat(40);
const xml = '<?xml version="1.0"?><rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel>'
  + '<item><title>UFC.300.1080p.WEB</title><link>magnet:?xt=urn:btih:' + HASH + '</link>'
  + '<torznab:attr name="infohash" value="' + HASH + '"/><torznab:attr name="seeders" value="12"/>'
  + '<torznab:attr name="size" value="12345"/></item></channel></rss>';

const requests = [];
const server = http.createServer((req, res) => {
  requests.push(req.url);
  if (!req.url.startsWith('/torznab?')) {
    res.statusCode = 404;
    return res.end('wrong endpoint');
  }
  res.setHeader('Content-Type', 'application/xml');
  res.end(req.url.includes('t=caps') ? '<?xml version="1.0"?><caps></caps>' : xml);
});

const log = { info() {}, warn() {}, error() {}, debug() {} };

server.listen(0, '127.0.0.1', async () => {
  const address = server.address();
  const base = 'http://127.0.0.1:' + address.port;
  try {
    assert.equal(torznab.endpointUrl({ url: base, apiPath: '/torznab' }), base + '/torznab');
    assert.equal(torznab.endpointUrl({ url: base + '/torznab', apiPath: '/torznab' }), base + '/torznab');

    const probe = await bitmagnet.test({ url: base }, log);
    assert.equal(probe.ok, true, probe.message);
    const results = await bitmagnet.multiSearch(['UFC 300'], { url: base }, log);
    assert.equal(results.length, 1);
    assert.equal(results[0].infoHash, HASH);
    assert.equal(results[0].indexer, 'Bitmagnet');
    assert.ok(requests.every((url) => url.startsWith('/torznab?')), requests.join(', '));
    assert.ok(requests.every((url) => !url.includes('apikey=')), requests.join(', '));
    console.log('torznab endpoint tests passed');
  } finally {
    server.close();
  }
});
