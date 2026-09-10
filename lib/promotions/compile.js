'use strict';

// Compiles a promotion definition into the four things the pipeline needs:
//
//   matcher  — does this release title belong to this promotion at all?
//   parse    — pull season / round / event number / date / competitors out
//   score    — how well does this candidate match the event we asked for?
//   queries  — what search strings should we send to the sources?
//
// Every regex emitted here is RE2-safe (no lookahead, no lookbehind,
// no backreferences) so the same pattern string can be handed to Postgres,
// Bitmagnet, or Go-based tooling unchanged. That is the whole reason the
// boundary helpers below exist instead of \b:
//
//   \b is wrong for release names. "20260203_EPL_25.26_R.24_..." has no word
//   boundary around EPL because "_" is a word character. Using \bEPL\b on the
//   EPL corpus silently drops ~700 of 1,146 genuine hits.

const { normalise, GLOBAL_NEGATIVES } = require('./schema');

// Non-alphanumeric boundary, anchorable at either end of the string.
const B_START = '(?:^|[^A-Za-z0-9])';
const B_END   = '(?:$|[^A-Za-z0-9])';

// Up to four intervening tokens between the promotion token and its
// corroborating context. Lazy, so the engine stops at the first evidence.
const GAP = '(?:[\\W_]|[A-Za-z0-9]+[\\W_]){0,4}?';

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Release names separate words with any of . _ - or space, inconsistently and
// often several at once. A definition writes "Aston Villa"; we match
// "Aston.Villa", "Aston_Villa", "aston-villa".
function tokenPattern(value) {
  return escapeRe(value).trim().replace(/\\?\s+/g, '[\\W_]{1,3}');
}

function alternation(values) {
  const parts = values.map(tokenPattern).filter(Boolean);
  return parts.length ? '(?:' + parts.join('|') + ')' : '';
}

// ---------------------------------------------------------------------------
// Shared structural patterns. These are what "a football release" looks like
// independent of which league it is.
// ---------------------------------------------------------------------------

const P = {
  // 2025-26, 2025-2026, 25_26, 25.26, 2017_2018
  season: '(?:19|20)\\d{2}[\\W_]{1,3}(?:19|20)?\\d{2}',
  // Short season form (25_26). Collides with dates, so it is only offered as
  // context, never used to parse a season value on its own.
  seasonShort: '\\d{2}[._\\-/]\\d{2}',
  // R.24, MD16, Matchday 1, Matchweek 06, GW12
  round: '(?:M(?:atch)?[\\W_]*(?:day|week)[\\W_]*\\d{1,2}'
       + '|(?:MD|MW|GW|R)[\\W_]*\\d{1,2}'
       + '|\\d{1,2}(?:st|nd|rd|th)?[\\W_]*(?:tour|tur|round|leg|matchday)'
       + '|\\d{1,2}[\\W_]*day)',
  // 21.02.26, 2026-02-21, 2026 02 21
  date: '(?:\\d{2}[._\\-/]\\d{2}[._\\-/]\\d{2,4}'
      + '|(?:19|20)\\d{2}[._\\-/ ]\\d{2}[._\\-/ ]\\d{2})',
  versus: '[Vv][Ss]?[\\W_]',
  editorial: '(?:Review|Highlights|Classic|Preview|MOTD|Recap|Full[\\W_]*(?:Match|Event|Card)'
           + '|Goals[\\W_]*of[\\W_]*the[\\W_]*Season|Prelims|Early[\\W_]*Prelims|PPV)',
  quality: '(?:2160p|1080[pi]|720p|480p|UHD|HDTV|WEB[\\W_]?DL|WEBRip|BluRay|HDR)',
};

function compile(rawDefinition) {
  const def = normalise(rawDefinition);

  const tokenAlt = alternation(def.tokens);
  const tokenRe = B_START + tokenAlt + B_END;

  // ---- context: the corroborating evidence a title can offer ----
  const contextParts = [P.season, P.date, P.round, P.seasonShort, P.versus, P.editorial];
  if (def.contextTokens.length)   contextParts.push(alternation(def.contextTokens));
  if (def.competitors.length)     contextParts.push(alternation(def.competitors));
  if (def.competitorCodes.length) {
    // Three-letter codes are only safe when followed by a separator, otherwise
    // "NEW" matches "Newcastle", "News", "Newest"...
    contextParts.push('(?:' + def.competitorCodes.map(escapeRe).join('|') + ')[\\W_]');
  }
  if (def.eventNumbered) contextParts.push('\\d{1,4}');
  const contextRe = '(?:' + contextParts.filter(Boolean).join('|') + ')';

  // ---- the matcher ----
  // low       : token alone, on boundaries
  // medium/high: token adjacent to context, in either order
  let matchSource;
  if (def.tokenAmbiguity === 'low') {
    matchSource = tokenRe;
  } else {
    matchSource = '(?:' + tokenRe + GAP + contextRe
                + '|' + contextRe + GAP + tokenRe + ')';
  }

  const negatives = GLOBAL_NEGATIVES.concat(def.negativeTokens.map(tokenPattern));
  const negativeSource = negatives.length ? '(?:' + negatives.join('|') + ')' : '';

  const matchRe = new RegExp(matchSource, 'i');
  const negativeRe = negativeSource ? new RegExp(negativeSource, 'i') : null;

  // ---- parsers ----
  const seasonParser = new RegExp('(?:^|[^0-9])((?:19|20)?\\d{2})[._\\-/ ]{1,3}((?:19|20)?\\d{2})(?:[^0-9]|$)');
  const roundParser = new RegExp('(?:MD|MW|GW|R|Round|Tour|Tur|Matchday|Matchweek|Match[\\W_]*Day)'
    + '[\\W_]*(\\d{1,2})(?:[^0-9]|$)|(\\d{1,2})(?:st|nd|rd|th)?[\\W_]*(?:tour|tur|round|leg)', 'i');
  const dateParser = new RegExp('(?:^|[^0-9])((?:19|20)\\d{2})[._\\-/ ](\\d{2})[._\\-/ ](\\d{2})(?:[^0-9]|$)'
    + '|(?:^|[^0-9])(\\d{2})[._\\-/](\\d{2})[._\\-/](\\d{2,4})(?:[^0-9]|$)');
  const eventNoParser = def.eventNumbered
    ? new RegExp(tokenAlt + '[\\W_]*(\\d{1,4})(?:[^0-9]|$)', 'i')
    : null;
  const competitorRe = def.competitors.length
    ? new RegExp(B_START + alternation(def.competitors) + B_END, 'gi')
    : null;
  // Codes are matched by tokenising rather than by a global regex. A global
  // regex consumes the separator it needs as a boundary, so in "WHU_BOU_21"
  // the match for WHU eats the "_" that BOU needs and the away side is lost.
  const codeSet = new Set(def.competitorCodes.map((c) => c.toUpperCase()));
  const qualityRe = new RegExp(P.quality, 'i');

  function test(title) {
    const value = String(title || '');
    if (!value) return false;
    if (negativeRe && negativeRe.test(value)) return false;
    return matchRe.test(value);
  }

  function parse(title) {
    const value = String(title || '');
    const out = { promotion: def.id, season: null, round: null, eventNo: null,
      date: null, competitors: [], quality: null };

    // Scan every season-shaped run and keep the first where the two halves are
    // the same or consecutive years. "2026.02.21" is a date, not a season —
    // 02 does not follow 2026 — but it matches the same shape.
    const seasonScanner = new RegExp(seasonParser.source, 'g');
    let sm;
    while ((sm = seasonScanner.exec(value))) {
      const a = sm[1], b = sm[2];
      const startYear = a.length === 4 ? Number(a) : 2000 + Number(a);
      const endYear = b.length === 4 ? Number(b) : Math.floor(startYear / 100) * 100 + Number(b);
      if (startYear < 1950 || startYear > 2100) continue;
      if (endYear === startYear + 1 || endYear === startYear) {
        out.season = String(startYear) + '/' + String(endYear).slice(-2);
        break;
      }
      if (seasonScanner.lastIndex > sm.index + 1) seasonScanner.lastIndex -= 1;
    }
    const round = value.match(roundParser);
    if (round) {
      const n = Number(round[1] || round[2]);
      if (Number.isFinite(n) && n > 0 && n <= 60) out.round = n;
    }
    // Scan every date-shaped run and keep the first calendar-valid one. A
    // single match is not enough: "EPL.25_26.27th.round.WHU_BOU_21.02.26"
    // offers "25_26.27" before it offers the real date.
    const dateScanner = new RegExp(dateParser.source, 'g');
    let dm;
    while ((dm = dateScanner.exec(value))) {
      let year, month, day, assumed = false;
      if (dm[1]) {
        year = dm[1]; month = dm[2]; day = dm[3];
      } else if (dm[4]) {
        // Ambiguous without a locale. The release scene overwhelmingly uses
        // DD.MM.YY for sport, so that is the assumption; recorded as such.
        day = dm[4]; month = dm[5];
        year = dm[6].length === 2 ? '20' + dm[6] : dm[6];
        assumed = true;
      } else {
        continue;
      }
      const mo = Number(month), da = Number(day), yr = Number(year);
      if (mo < 1 || mo > 12 || da < 1 || da > 31 || yr < 1950 || yr > 2100) continue;
      out.date = year + '-' + month + '-' + day;
      if (assumed) out.dateAssumedDayFirst = true;
      break;
    }
    if (eventNoParser) {
      const ev = value.match(eventNoParser);
      if (ev) out.eventNo = Number(ev[1]);
    }
    if (competitorRe) {
      competitorRe.lastIndex = 0;
      let m;
      while ((m = competitorRe.exec(value))) {
        // Normalise the release-name separator back to a space so
        // "Manchester.City" and "Manchester City" are the same competitor.
        const name = m[0].replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').replace(/[\W_]+/g, ' ');
        if (name && !out.competitors.includes(name)) out.competitors.push(name);
        // Step back one character so adjacent competitors sharing a single
        // separator are both seen.
        if (competitorRe.lastIndex > m.index + 1) competitorRe.lastIndex -= 1;
      }
    }
    if (codeSet.size && out.competitors.length < 2) {
      for (const part of value.split(/[\W_]+/)) {
        if (part.length === 3 && codeSet.has(part.toUpperCase())
            && part === part.toUpperCase() && !out.competitors.includes(part)) {
          out.competitors.push(part);
        }
      }
    }
    const q = value.match(qualityRe);
    if (q) out.quality = q[0];
    return out;
  }

  // Relevance score for one candidate against one requested event. Additive
  // and deliberately transparent — every contribution is nameable in a log
  // line, because "why did this rank third" is the question you actually ask.
  function score(candidate, event) {
    const title = String((candidate && candidate.title) || '');
    if (!test(title)) return { score: 0, reasons: ['no promotion match'] };

    const parsed = parse(title);
    const reasons = [];
    let total = 10;
    reasons.push('promotion+10');

    const size = Number((candidate && candidate.size) || 0);
    if (def.sizeFloorBytes && size > 0 && size < def.sizeFloorBytes) {
      return { score: 0, reasons: ['below size floor'] };
    }

    if (event) {
      if (event.eventNo && parsed.eventNo) {
        if (Number(event.eventNo) === parsed.eventNo) { total += 50; reasons.push('eventNo+50'); }
        else return { score: 0, reasons: ['eventNo mismatch'] };
      }
      if (event.date && parsed.date) {
        if (String(event.date).slice(0, 10) === parsed.date) { total += 40; reasons.push('date+40'); }
      }
      if (event.season && parsed.season && event.season === parsed.season) {
        total += 15; reasons.push('season+15');
      }
      if (event.round && parsed.round && Number(event.round) === parsed.round) {
        total += 25; reasons.push('round+25');
      }
      const wanted = Array.isArray(event.competitors) ? event.competitors : [];
      if (wanted.length && parsed.competitors.length) {
        const lower = parsed.competitors.map((c) => c.toLowerCase());
        const hits = wanted.filter((w) => lower.includes(String(w).toLowerCase())).length;
        if (hits) { total += hits * 20; reasons.push('competitors+' + (hits * 20)); }
      }
    }

    const seeders = Number((candidate && candidate.seeders) || 0);
    if (seeders > 0) {
      const bonus = Math.min(10, Math.round(Math.log10(seeders + 1) * 5));
      total += bonus; reasons.push('seeders+' + bonus);
    }
    if (parsed.quality) {
      const q = parsed.quality.toLowerCase();
      const bonus = q.includes('2160') || q.includes('uhd') ? 8
        : q.includes('1080') ? 6 : q.includes('720') ? 3 : 1;
      total += bonus; reasons.push('quality+' + bonus);
    }
    return { score: total, reasons, parsed };
  }

  // Search strings for the sources. Templates use {token} {eventNo} {season}
  // {round} {home} {away} {date}; a template that references a field the event
  // does not have is skipped rather than emitting a half-filled query.
  function queries(event) {
    const ev = event || {};
    const out = [];
    const primary = def.tokens[0];
    // Season is stored as 2025/26 but no indexer is searched that way.
    const seasonDash = ev.season ? String(ev.season).replace('/', '-') : null;
    const values = {
      token: primary,
      eventNo: ev.eventNo != null ? String(ev.eventNo) : null,
      season: seasonDash,
      seasonShort: seasonDash ? seasonDash.slice(2) : null,
      round: ev.round != null ? String(ev.round) : null,
      roundMD: ev.round != null ? 'MD' + String(ev.round).padStart(2, '0') : null,
      roundR: ev.round != null ? 'R' + String(ev.round).padStart(2, '0') : null,
      home: ev.competitors && ev.competitors[0] ? String(ev.competitors[0]) : null,
      away: ev.competitors && ev.competitors[1] ? String(ev.competitors[1]) : null,
      date: ev.date ? String(ev.date).slice(0, 10) : null,
      name: ev.name || null,
    };
    const templates = def.queryTemplates.length ? def.queryTemplates : defaultTemplates(def);
    for (const template of templates) {
      let skip = false;
      const rendered = template.replace(/\{(\w+)\}/g, (_, key) => {
        if (values[key] == null || values[key] === '') { skip = true; return ''; }
        return values[key];
      });
      if (skip) continue;
      const clean = rendered.replace(/\s+/g, ' ').trim();
      if (clean && !out.includes(clean)) out.push(clean);
    }
    if (ev.name && !out.includes(ev.name)) out.unshift(ev.name);
    return out;
  }

  return {
    id: def.id,
    label: def.label,
    definition: def,
    tokenAmbiguity: def.tokenAmbiguity,
    // Pattern strings, exported so they can be pushed down into Postgres or
    // Bitmagnet rather than only run in-process.
    patterns: { match: matchSource, negative: negativeSource },
    test, parse, score, queries,
  };
}

function defaultTemplates(def) {
  const out = [];
  if (def.eventNumbered) out.push('{token} {eventNo}');
  if (def.seasonRound) {
    out.push('{token} {season} {round}');
    out.push('{token} {home} {away}');
  }
  out.push('{token} {home} vs {away}');
  out.push('{token} {date}');
  return out;
}

module.exports = { compile, escapeRe, tokenPattern, B_START, B_END, GAP, P };
