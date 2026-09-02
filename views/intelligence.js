'use strict';

const layout = require('./layout');
const intelligence = require('../lib/release-intelligence');

function render(req, res) {
  const query = String(req.query.q || '').trim();
  const protocol = /^(?:torrent|usenet)$/.test(String(req.query.protocol || ''))
    ? String(req.query.protocol) : '';
  const result = intelligence.search({ query, protocol, limit: 250 });
  const status = intelligence.status();
  const rows = result.results.map((item) => {
    const sources = Array.from(new Set((item.origins || []).map((origin) =>
      [origin.sourceName, origin.indexer, origin.protocol].filter(Boolean).join(' / ')))).join(', ');
    return '<tr><td><div class="mono">' + layout.escapeHtml(item.title) + '</div>'
      + '<div class="hint">' + layout.escapeHtml(item.publishedAt || item.firstSeenAt || '') + '</div></td>'
      + '<td>' + layout.escapeHtml(sources) + '</td>'
      + '<td>' + layout.escapeHtml((item.categories || []).join(', ')) + '</td>'
      + '<td>' + layout.escapeHtml(item.size ? (item.size / 1073741824).toFixed(2) + ' GB' : '—') + '</td></tr>';
  }).join('');
  const s = status.stats;
  const indexerDetails = status.lastRun ? status.lastRun.outcomes.flatMap((outcome) => outcome.details || []) : [];
  const detailRows = indexerDetails.map((detail) => {
    const tone = detail.state === 'working' ? 'good' : detail.state === 'error' ? 'bad'
      : detail.state === 'empty' || detail.state === 'unsupported' ? 'warn' : 'muted';
    const activity = layout.escapeHtml(detail.mode) + (detail.queries && detail.queries.length
      ? '<div class="hint">' + layout.escapeHtml(detail.queries.join(' · ')) + '</div>' : '');
    const outcome = detail.reason || (detail.accepted + ' sport title(s) retained');
    return '<tr><td><strong>' + layout.escapeHtml(detail.name) + '</strong></td>'
      + '<td>' + layout.escapeHtml(detail.protocol || 'unknown') + '</td>'
      + '<td><span class="pill ' + tone + '">' + layout.escapeHtml(detail.state) + '</span></td>'
      + '<td>' + activity + '</td><td>' + (detail.feedRaw || 0) + '</td><td>'
      + (detail.searchRaw || 0) + '</td><td>' + detail.accepted + '</td>'
      + '<td>' + detail.rejected + '</td><td>' + detail.durationMs + ' ms</td>'
      + '<td>' + layout.escapeHtml(outcome) + '</td></tr>';
  }).join('');
  const body = '<div class="page-head"><div><h1>Release Intelligence</h1>'
    + '<p>Recent sport-category release names collected once per source—not per-event searches. SSS searches this local evidence when researching an event. No hashes, download links, trackers or credentials are stored.</p></div>'
    + '<form method="post" action="/intelligence/collect"><button class="btn primary" type="submit"'
    + (status.running ? ' disabled' : '') + '>' + (status.running ? 'Collecting…' : 'Collect now') + '</button></form></div>'
    + '<div class="stats"><div><strong>' + s.total + '</strong><span>retained titles</span></div>'
    + '<div><strong>' + s.sources + '</strong><span>sources</span></div><div><strong>'
    + s.retentionDays + ' days</strong><span>retention</span></div><div><strong>'
    + layout.escapeHtml(s.updatedAt || 'Not collected') + '</strong><span>last database update</span></div></div>'
    + '<section class="panel"><div class="panel-head"><h2>Prowlarr indexer coverage</h2></div>'
    + '<p class="hint">Each indexer is checked independently. Empty feeds receive only the configured rotating fallback searches.</p>'
    + '<div class="table-wrap"><table class="t responsive"><thead><tr><th>Indexer</th><th>Type</th><th>State</th><th>Method</th><th>Feed</th><th>Search</th><th>Kept</th><th>Rejected</th><th>Time</th><th>Detail</th></tr></thead><tbody>'
    + (detailRows || '<tr><td colspan="10" class="empty">Collect once to inspect individual indexer coverage.</td></tr>')
    + '</tbody></table></div></section>'
    + '<section class="panel"><form method="get" action="/intelligence" class="filters">'
    + '<label>Find naming patterns<input name="q" value="' + layout.escapeHtml(query) + '" placeholder="UFC 300; Champions League Arsenal"></label>'
    + '<label>Protocol<select name="protocol"><option value="">All</option><option value="torrent"'
    + (protocol === 'torrent' ? ' selected' : '') + '>Torrent</option><option value="usenet"'
    + (protocol === 'usenet' ? ' selected' : '') + '>Usenet</option></select></label>'
    + '<button class="btn" type="submit">Search</button><a class="btn" href="/intelligence/export?q='
    + encodeURIComponent(query) + '&protocol=' + encodeURIComponent(protocol) + '">Download safe dataset</a></form></section>'
    + '<section class="panel"><div class="panel-head"><h2>' + result.count + ' matching title(s)</h2></div>'
    + '<div class="table-wrap"><table class="t responsive"><thead><tr><th>Release title</th><th>Observed through</th><th>Categories</th><th>Size</th></tr></thead><tbody>'
    + (rows || '<tr><td colspan="4" class="empty">No matching intelligence collected yet.</td></tr>')
    + '</tbody></table></div></section>';
  res.send(layout.layout(req, { title: 'Release Intelligence', active: 'intelligence', body }));
}

async function collect(_req, res) {
  await intelligence.runCollection();
  res.redirect(303, '/intelligence');
}

function exportData(req, res) {
  const payload = intelligence.exportSafe({ query: req.query.q, protocol: req.query.protocol });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="sss-release-intelligence.json"');
  res.send(JSON.stringify(payload, null, 2));
}

module.exports = { render, collect, exportData };
