'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-intelligence-'));
process.env.DATA_DIR = dir;
process.env.INTELLIGENCE_RETENTION_DAYS = '14';
const intelligence = require('../lib/release-intelligence');

try {
  const source = { id: 'prowlarr-test', name: 'Prowlarr Test', type: 'prowlarr' };
  intelligence.ingest([{
    title: 'UEFA.Champions.League.2026.08.25.Arsenal.vs.Atletico.Madrid.1080p',
    size: 1234, publishedAt: new Date().toISOString(), protocol: 'usenet',
    indexer: 'Example Indexer', categories: ['5060', 'TV/Sport'],
    downloadUrl: 'https://indexer.invalid/get?apikey=secret',
    infoHash: 'a'.repeat(40), magnetTrackers: ['https://tracker.invalid/secret'],
  }], source);
  intelligence.ingest([{
    title: 'UEFA.Champions.League.2026.08.25.Arsenal.vs.Atletico.Madrid.1080p',
    size: 1234, publishedAt: new Date().toISOString(), protocol: 'usenet', indexer: 'Second Indexer',
  }], { id: 'torznab-test', name: 'Torznab Test', type: 'torznab' });
  intelligence.ingest([{
    title: 'Unrelated.TV.Show.S02E09.1080p', size: 999, protocol: 'torrent',
    indexer: 'Example Indexer', categories: ['5000'],
  }], source);
  const pruned = intelligence.pruneSourceCategories(Object.assign({}, source,
    { config: { intelligenceCategories: '5060' } }));
  assert.strictEqual(pruned.removedItems, 1);
  const result = intelligence.search({ queries: ['Champions League Arsenal Atletico'], limit: 20 });
  assert.strictEqual(result.count, 1);
  assert.strictEqual(result.results[0].origins.length, 2);
  const exported = JSON.stringify(intelligence.exportSafe({ query: 'Arsenal Atletico' }));
  assert.match(exported, /UEFA\.Champions\.League/);
  assert.doesNotMatch(exported, /apikey|secret|infoHash|magnet|tracker\.invalid|downloadUrl/);
  console.log('Release Intelligence storage, search, deduplication and safe export tests passed.');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
