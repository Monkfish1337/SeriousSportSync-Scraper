#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
const dockerignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8');

assert.match(
  compose,
  /127\.0\.0\.1:\$\{PORT:-8080\}:8080/,
  'standalone Compose must publish the GUI on loopback only',
);
assert.match(
  compose,
  /SCRAPER_AUTH_TOKEN:\s*["']?\$\{SCRAPER_AUTH_TOKEN:\?[^}]+\}/,
  'supported Compose deployment must require SCRAPER_AUTH_TOKEN',
);
assert.match(dockerignore, /^\.env\.\*$/m, 'Docker context must exclude environment files');
assert.match(dockerignore, /^data\/$/m, 'Docker context must exclude runtime state');

console.log('OK — public image excludes private state and standalone runtime stays loopback-only with API auth required.');
