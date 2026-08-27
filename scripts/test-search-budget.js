'use strict';

const assert = require('assert');
const settings = require('../lib/settings');
const registry = require('../lib/sources/registry');

const hash = 'a'.repeat(40);
settings.enabledSources = () => [
  { id: 'fast', name: 'Fast', type: 'test-fast', config: { timeoutMs: 5000 } },
  { id: 'slow', name: 'Slow', type: 'test-slow', config: { timeoutMs: 5000 } },
];
const originalGet = registry.get;
registry.get = (type) => {
  if (type === 'test-fast') return { multiSearch: async () => [{ infoHash: hash, title: 'Dutch GP' }] };
  if (type === 'test-slow') return { multiSearch: async () => new Promise(() => {}) };
  return originalGet(type);
};

(async () => {
  const start = Date.now();
  const result = await require('../lib/search').scrape({
    event: { id: 'f1-dutch', name: 'Dutch Grand Prix' },
    searchTitles: ['Dutch GP'],
    budgetMs: 1000,
  });
  const elapsed = Date.now() - start;
  assert(elapsed >= 900 && elapsed < 1800, 'request budget was not respected: ' + elapsed + 'ms');
  assert.strictEqual(result.candidates.length, 1);
  assert.strictEqual(result.candidates[0].infoHash, hash);
  console.log('Scrape request budget and partial-source tests passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
