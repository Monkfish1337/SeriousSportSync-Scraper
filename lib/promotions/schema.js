'use strict';

// Promotion definition schema.
//
// A promotion is data, not code. Everything the pipeline needs to find and
// judge a release — query strings, the match regex, the metadata parser, the
// relevance scorer — is generated from one of these objects by
// lib/promotions/compile.js. Adding a promotion is adding a JSON file.
//
// The field that does the most work is `tokenAmbiguity`. It decides how much
// corroborating evidence a title needs before the promotion token counts as a
// real hit:
//
//   'low'    — the token is effectively unique ("UFC", "NASCAR"). Token alone
//              is enough; a bare "UFC 291" needs no further proof.
//   'medium' — the token is a real word or a common abbreviation but rarely
//              collides in release names ("Bellator", "NXT"). Token plus any
//              one context signal.
//   'high'   — the token is a common substring or a widely reused acronym
//              ("EPL", "ONE", "PFL"). Token MUST be accompanied by a context
//              signal, and the token itself must sit on non-word boundaries.
//
// The 'high' rule is the difference between 1,146 usable rows and 16,985 rows
// of epubs and adult releases — see the EPL corpus in scripts/test-promotions.js.

const AMBIGUITY = new Set(['low', 'medium', 'high']);

const FIELDS = {
  id:              { type: 'string',  required: true },
  label:           { type: 'string',  required: true },
  sport:           { type: 'string',  required: false, default: '' },
  tokens:          { type: 'array',   required: true },
  tokenAmbiguity:  { type: 'string',  required: false, default: 'medium' },
  contextTokens:   { type: 'array',   required: false, default: [] },
  competitors:     { type: 'array',   required: false, default: [] },
  competitorCodes: { type: 'array',   required: false, default: [] },
  negativeTokens:  { type: 'array',   required: false, default: [] },
  eventNumbered:   { type: 'boolean', required: false, default: false },
  seasonRound:     { type: 'boolean', required: false, default: false },
  sizeFloorBytes:  { type: 'number',  required: false, default: 0 },
  queryTemplates:  { type: 'array',   required: false, default: [] },
};

// Noise that is never a sports release, regardless of promotion. Mined from
// the EPL report: the whole 16,985-row result set was three noise families and
// two of them are global.
const GLOBAL_NEGATIVES = [
  '\\.epub',
  '\\(\\s*r\\d+\\.\\d+[^)]*\\)',   // EpubLibre revision tag: "(r1.0 EPL)"
  'roleplay',
  'role[\\W_]play',
  'foreplay',
  '@\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}',  // "EPL@38.100.22.211" spam
];

function fail(id, message) {
  throw new Error('promotion "' + (id || '?') + '": ' + message);
}

function normalise(input) {
  if (!input || typeof input !== 'object') fail('?', 'definition must be an object');
  const id = String(input.id || '').trim();
  if (!id) fail('?', 'id is required');
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) fail(id, 'id must be lowercase slug');

  const out = { };
  for (const [name, spec] of Object.entries(FIELDS)) {
    const value = input[name];
    if (value === undefined || value === null) {
      if (spec.required) fail(id, name + ' is required');
      out[name] = Array.isArray(spec.default) ? spec.default.slice() : spec.default;
      continue;
    }
    if (spec.type === 'array') {
      if (!Array.isArray(value)) fail(id, name + ' must be an array');
      out[name] = value.map((v) => String(v)).filter(Boolean);
    } else if (spec.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) fail(id, name + ' must be a non-negative number');
      out[name] = n;
    } else if (spec.type === 'boolean') {
      out[name] = value === true;
    } else {
      out[name] = String(value);
    }
  }

  if (out.tokens.length === 0) fail(id, 'at least one token is required');
  if (!AMBIGUITY.has(out.tokenAmbiguity)) {
    fail(id, 'tokenAmbiguity must be one of ' + Array.from(AMBIGUITY).join(', '));
  }
  // A high-ambiguity promotion with nothing to corroborate against can only
  // ever produce noise. Refuse it at load time rather than at 3am.
  if (out.tokenAmbiguity === 'high'
      && out.contextTokens.length === 0
      && out.competitors.length === 0
      && out.competitorCodes.length === 0
      && !out.eventNumbered && !out.seasonRound) {
    fail(id, 'tokenAmbiguity "high" requires contextTokens, competitors, '
      + 'eventNumbered or seasonRound to corroborate the token');
  }
  return out;
}

module.exports = { normalise, GLOBAL_NEGATIVES, AMBIGUITY };
