'use strict';

// Bitmagnet exposes Torznab directly at /torznab and does not require an API
// key by default. Keeping this as a dedicated source removes the easy-to-miss
// generic Torznab path/API-key choices that previously produced /torznab/api.

const torznab = require('./torznab');

function config(input) {
  return Object.assign({}, input || {}, {
    label: (input && input.label) || 'Bitmagnet',
    apiPath: '/torznab',
    apiKey: '',
  });
}

module.exports = {
  type: 'bitmagnet',
  label: 'Bitmagnet',
  description: 'Bitmagnet\'s built-in Torznab endpoint. Enter only the service URL; /torznab is added automatically.',
  schema: [
    { name: 'url', label: 'Bitmagnet URL', type: 'url', required: true,
      placeholder: 'http://bitmagnet:3333',
      hint: 'Use the container/service URL. A full URL ending in /torznab is also accepted.' },
    { name: 'categories', label: 'Categories', type: 'csv',
      hint: 'Optional comma-separated Torznab category IDs.' },
    { name: 'limit', label: 'Limit per query', type: 'number', default: 100 },
    { name: 'timeoutMs', label: 'Timeout (ms)', type: 'number', default: 12000 },
  ],
  multiSearch(queries, sourceConfig, log) {
    return torznab.multiSearch(queries, config(sourceConfig), log);
  },
  test(sourceConfig, log) {
    return torznab.test(config(sourceConfig), log);
  },
  _test: { config },
};
