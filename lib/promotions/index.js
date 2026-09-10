'use strict';

// Promotion registry. Loads every definition in ./definitions, compiles it
// once, and caches the result. Definitions are plain JSON so the Promotion
// Wizard can emit them and an operator can hand-edit one without a rebuild.

const fs = require('fs');
const path = require('path');
const { compile } = require('./compile');

const DEFINITIONS_DIR = path.join(__dirname, 'definitions');

let cache = null;

function loadAll(dir) {
  const out = new Map();
  const target = dir || DEFINITIONS_DIR;
  let entries = [];
  try {
    entries = fs.readdirSync(target).filter((f) => f.endsWith('.json')).sort();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return out;
  }
  for (const file of entries) {
    const full = path.join(target, file);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (err) {
      throw new Error('promotion definition ' + file + ' is not valid JSON: ' + err.message);
    }
    const compiled = compile(raw);
    if (out.has(compiled.id)) throw new Error('duplicate promotion id: ' + compiled.id);
    out.set(compiled.id, compiled);
  }
  return out;
}

function all() {
  if (!cache) cache = loadAll();
  return cache;
}

function get(id) {
  return all().get(String(id || '').toLowerCase()) || null;
}

function list() {
  return Array.from(all().values()).map((p) => ({
    id: p.id, label: p.label, tokenAmbiguity: p.tokenAmbiguity,
    sport: p.definition.sport,
  }));
}

// Which promotion (if any) does this release title belong to?
//
// Ambiguity order matters: a low-ambiguity token is self-anchoring, so it wins
// over a high-ambiguity token that only matched on circumstantial context.
const AMBIGUITY_RANK = { low: 0, medium: 1, high: 2 };

function classify(title) {
  const hits = [];
  for (const promotion of all().values()) {
    if (promotion.test(title)) hits.push(promotion);
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => AMBIGUITY_RANK[a.tokenAmbiguity] - AMBIGUITY_RANK[b.tokenAmbiguity]);
  return {
    promotion: hits[0].id,
    ambiguous: hits.length > 1 ? hits.map((h) => h.id) : null,
    parsed: hits[0].parse(title),
  };
}

// Rank a source's candidates against a requested event, dropping anything the
// promotion rejects outright. This is the precision half of the two-stage
// design — sources over-fetch, this narrows.
function rank(promotionId, candidates, event) {
  const promotion = get(promotionId);
  if (!promotion) return (candidates || []).map((c) => Object.assign({}, c));
  const out = [];
  for (const candidate of candidates || []) {
    const result = promotion.score(candidate, event);
    if (result.score <= 0) continue;
    out.push(Object.assign({}, candidate, {
      _score: result.score, _scoreReasons: result.reasons, _parsed: result.parsed,
    }));
  }
  out.sort((a, b) => b._score - a._score);
  return out;
}

function reload() { cache = null; return all(); }

module.exports = { get, list, all, classify, rank, reload, loadAll, DEFINITIONS_DIR };
