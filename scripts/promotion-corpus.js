'use strict';

// Corpus harness — measure a promotion matcher against a real export.
//
//   node scripts/promotion-corpus.js <csv> [promotionId]
//
// The CSV needs a `name` column; a Bitmagnet report
// (`select name, info_hash, size, created_at from torrents where ...`)
// is exactly the right shape. With no promotionId, every loaded promotion is
// run and the totals are broken down by promotion — which is how you catch
// one definition stealing another's releases.
//
// This exists so changes to a definition are provable rather than plausible.
// Freeze an export, re-run this after every edit, compare the numbers.

const fs = require('fs');
const path = require('path');
const promotions = require('../lib/promotions');

function parseCsv(text) {
  const rows = [];
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return rows;
  const header = splitCsvLine(lines[0]);
  const nameIndex = header.findIndex((h) => h.trim().toLowerCase() === 'name');
  const sizeIndex = header.findIndex((h) => h.trim().toLowerCase() === 'size');
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const name = nameIndex >= 0 ? cells[nameIndex] : cells[0];
    if (!name) continue;
    rows.push({ name, size: sizeIndex >= 0 ? Number(cells[sizeIndex]) || 0 : 0 });
  }
  return rows;
}

function splitCsvLine(line) {
  const out = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; }
        else quoted = false;
      } else current += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(current); current = '';
    } else current += ch;
  }
  out.push(current);
  return out;
}

function pct(part, whole) {
  if (!whole) return '  n/a';
  return (Math.round((part / whole) * 1000) / 10).toFixed(1).padStart(5) + '%';
}

function main() {
  const file = process.argv[2];
  const only = process.argv[3];
  if (!file) {
    console.error('usage: node scripts/promotion-corpus.js <csv> [promotionId]');
    process.exit(2);
  }
  const rows = parseCsv(fs.readFileSync(path.resolve(file), 'utf8'));
  console.log('corpus: ' + rows.length.toLocaleString() + ' rows from ' + path.basename(file));
  console.log('');

  const targets = only ? [only] : promotions.list().map((p) => p.id);
  const perPromotion = [];

  for (const id of targets) {
    const promotion = promotions.get(id);
    if (!promotion) { console.error('unknown promotion: ' + id); process.exit(2); }
    const matched = [];
    for (const row of rows) if (promotion.test(row.name)) matched.push(row);
    const parsed = matched.map((row) => promotion.parse(row.name));
    perPromotion.push({
      id, ambiguity: promotion.tokenAmbiguity, matched: matched.length,
      season: parsed.filter((p) => p.season).length,
      round: parsed.filter((p) => p.round != null).length,
      date: parsed.filter((p) => p.date).length,
      eventNo: parsed.filter((p) => p.eventNo != null).length,
      twoSided: parsed.filter((p) => p.competitors.length >= 2).length,
      samples: matched.slice(0, 3).map((r) => r.name),
    });
  }

  perPromotion.sort((a, b) => b.matched - a.matched);
  const width = Math.max(12, ...perPromotion.map((p) => p.id.length + 2));
  console.log('promotion'.padEnd(width) + 'ambig   matched   season    round     date   ev.no  2-sided');
  console.log('-'.repeat(width + 62));
  for (const p of perPromotion) {
    if (p.matched === 0 && only == null) continue;
    console.log(
      p.id.padEnd(width)
      + p.ambiguity.padEnd(8)
      + String(p.matched).padStart(7)
      + pct(p.season, p.matched).padStart(9)
      + pct(p.round, p.matched).padStart(9)
      + pct(p.date, p.matched).padStart(9)
      + pct(p.eventNo, p.matched).padStart(8)
      + pct(p.twoSided, p.matched).padStart(9));
  }

  const claimed = new Set();
  let multi = 0;
  for (const row of rows) {
    let hits = 0;
    for (const id of targets) if (promotions.get(id).test(row.name)) hits++;
    if (hits > 0) claimed.add(row.name);
    if (hits > 1) multi++;
  }
  console.log('');
  console.log('classified : ' + claimed.size.toLocaleString() + ' / ' + rows.length.toLocaleString()
    + ' rows (' + pct(claimed.size, rows.length).trim() + ')');
  console.log('contested  : ' + multi.toLocaleString()
    + ' row(s) matched by more than one promotion'
    + (multi ? '  <- tighten those definitions' : ''));

  if (only) {
    console.log('');
    console.log('samples:');
    for (const sample of perPromotion[0].samples) console.log('  ' + sample.slice(0, 100));
  }
}

main();
