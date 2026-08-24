'use strict';

const assert = require('assert');
const crypto = require('crypto');
const {
  absoluteDownloadUrl,
  extractTorrentInfoHash,
} = require('../lib/sources/prowlarr');

const info = Buffer.from('d4:name8:test.mkv6:lengthi12345ee');
const torrent = Buffer.concat([
  Buffer.from('d8:announce14:http://tracker4:info'),
  info,
  Buffer.from('e'),
]);
const expected = crypto.createHash('sha1').update(info).digest('hex');

assert.strictEqual(extractTorrentInfoHash(torrent), expected);
assert.strictEqual(extractTorrentInfoHash(Buffer.from('not a torrent')), '');
assert.strictEqual(
  absoluteDownloadUrl('/download?id=1', 'http://prowlarr:9696/'),
  'http://prowlarr:9696/download?id=1',
);
assert.strictEqual(absoluteDownloadUrl('not a URL', ''), '');

console.log('Prowlarr torrent hydration tests passed.');

