# SeriousSportSync Scraper

Companion indexer-aggregator for the SeriousSportSync metadata addon.

The metadata addon stays content-neutral. This service does the dirty work — querying Prowlarr, Zilean (DMM), Knaben, raw Torznab feeds, anything you wire in — and returns a flat list of release-candidate metadata to the addon, which in turn resolves them against the user's debrid provider and returns only playable URLs.

> Public source and image, private runtime. Run it only on your own internal
> container network. The operator GUI has no login wall and must not be routed
> to the Internet.

---

## How it fits

```
   Stremio client                                      
        │ /stream                                      
        ▼                                              
   ┌──────────────────────┐                            
   │  SeriousSportSync    │  POST /scrape              
   │  metadata addon      │ ─────────────────────►  ┌──────────────────────┐
   │  (public)            │ ◄─── candidates ──────  │ SeriousSportSync     │
   │                      │                         │ Scraper (this repo)  │
   │  resolves via        │                         │  • Prowlarr          │
   │  TorBox / etc.       │                         │  • Zilean            │
   │  returns playable    │                         │  • Knaben            │
   │  URLs only           │                         │  • Torznab           │
   └──────────────────────┘                         └──────────────────────┘
```

The scraper never speaks to the Stremio client and never resolves candidates to playable links. Its sole job: take a `{promotion, event, searchTitles}` request, fan out to every configured source in parallel, return a deduped list of `{infoHash, title, size, seeders, indexer, magnetTrackers}`.

---

## Running

Docker is the supported deployment path.

```bash
git clone https://github.com/Monkfish1337/SeriousSportSync-Scraper.git
cd SeriousSportSync-Scraper
cp .env.example .env
# edit .env — set SCRAPER_AUTH_TOKEN to a long random string
docker compose up -d
```

The repository and GHCR image are public, so cloning and pulling do not require
a GitHub token.

Update to the newest image with `docker compose pull && docker compose up -d`.
For a local source build instead, run
`docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build`.

The Compose port is loopback-only. On the Docker host, open
`http://127.0.0.1:8080/`. For remote administration, use an SSH tunnel rather
than publishing the GUI:

```bash
ssh -L 8080:127.0.0.1:8080 your-docker-host
```

The metadata addon's `/admin → Sources` page is where you point at this service (companion URL + auth token).

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | bind address |
| `PORT` | `8080` | listen port |
| `SCRAPER_AUTH_TOKEN` | required by Compose | bearer token required on `/scrape` |
| `SOURCE_TIMEOUT_MS` | `10000` | default per-source request timeout |
| `SCRAPE_BUDGET_MS` | `25000` | hard ceiling on overall `/scrape` time |
| `RESEARCH_BUDGET_MS` | `60000` | ceiling for explicit Promotion Wizard research requests |
| `SOURCE_CACHE_TTL_MS` | `900000` | retain completed source searches for Refresh Links (15 minutes) |
| `SOURCE_CACHE_MAX` | `500` | maximum exact source/query results retained in memory |
| `INTELLIGENCE_ENABLED` | `true` | collect recent title-only metadata from supported Sport Sources |
| `INTELLIGENCE_INTERVAL_MS` | `3600000` | collection interval (one hour) |
| `INTELLIGENCE_STARTUP_DELAY_MS` | `60000` | delay before the first collection after startup |
| `INTELLIGENCE_RETENTION_DAYS` | `14` | rolling naming-evidence retention window |
| `INTELLIGENCE_MAX_ITEMS` | `20000` | hard cap on retained deduplicated titles |
| `LOG_BUFFER_MAX` | `4000` | in-memory log ring buffer size |
| `HISTORY_MAX` | `200` | on-disk `/scrape` call retention |
| `HTTPS_PROXY` | _(unset)_ | outbound proxy (e.g. `http://gluetun:8888`) |
| `NO_PROXY` | _(see compose)_ | comma-separated hosts that bypass the proxy |
| `DATA_DIR` | `/app/data` | persistent state directory |

---

## GUI tour

- **Dashboard** — stat tiles, per-source health, recent `/scrape` calls, activity tail.
- **Sources** — add / edit / delete sources; enable/disable toggle; per-source `Test` probe; schema-driven forms (each source type declares its own config schema, the form is generated from it).
- **Search** — manual probe. Paste search titles, see what every enabled source returns side-by-side. Useful for "why is this event coming back thin".
- **Logs** — live tail via Server-Sent Events; level/category/source/text filters; pause + clear.
- **History** — newest-first list of `/scrape` calls; click any row for per-source breakdown (latency, returned count, status pill).
- **Settings** — runtime config display; clear history; clear log buffer; export/import `sources.json`.

---

## Supported source types

Each source type lives at `lib/sources/<type>.js` and exports a small contract:

```js
module.exports = {
  type: 'prowlarr',
  label: 'Prowlarr',
  description: 'Federated Torznab aggregator…',
  schema: [
    { name: 'url',    label: 'Base URL', type: 'url',    required: true },
    { name: 'apiKey', label: 'API key',  type: 'secret', required: true },
    // …
  ],
  async multiSearch(searchTitles, config, log) { /* return candidates */ },
  async test(config, log)                       { /* return {ok, message} */ },
};
```

To add a new source type: drop a new file, register it in `lib/sources/registry.js`, restart. The GUI picks it up automatically — no view code change.

Built-in types in v0.1:

- **prowlarr** — federated Torznab; supports hash hydration via the `/download` proxy when an indexer only returns a `magnetUrl`.
- **zilean** — DebridMediaManager hashlist mirror (`POST /dmm/search`).
- **knaben** — Knaben multi-tracker aggregator (`POST /v1`).
- **torznab** — generic Torznab XML feed; bring your own indexer URL + API key.
- **bitmagnet** — dedicated Bitmagnet Torznab integration; enter the service URL and the companion uses `/torznab` without requiring an API key.

Private tracker website logins are not performed by the companion. Configure
credentials for trackers such as RuTracker in Prowlarr or Jackett, then add the
Prowlarr API or Jackett Torznab endpoint as the companion source.

---

## API protocol

Single endpoint. Auth via `Authorization: Bearer <SCRAPER_AUTH_TOKEN>` if configured.

```
POST /scrape
Content-Type: application/json
Authorization: Bearer <token>

{
  "promotion": "ufc",
  "event": { "name": "UFC 291", "date": "2026-07-29" },
  "searchTitles": ["UFC 291", "UFC.291.PPV"],
  "budgetMs": 5000
}
```

Response:

```json
{
  "candidates": [
    {
      "infoHash": "abcdef…",
      "title": "UFC.291.PPV.1080p.WEB-DL",
      "size": 5400000000,
      "seeders": 42,
      "indexer": "Prowlarr/<indexer-name>",
      "magnetTrackers": ["udp://tracker.example:6969"],
      "publishDate": "2026-07-30T00:00:00Z"
    },
    …
  ]
}
```

`budgetMs` is optional and can only shorten the operator's `SCRAPE_BUDGET_MS`
ceiling. Completed sources are retained when another source reaches that deadline.
If a slow source such as Prowlarr exceeds the caller's response window, it may
finish within its own configured timeout in the background. Its result is retained
and returned immediately when the client uses **Refresh Links**, avoiding a repeat
search and preventing slow indexers from being silently discarded.

Promotion Wizard research sends `researchMode: true`. That explicit admin action
uses the separate `RESEARCH_BUDGET_MS` ceiling, allowing slow federated indexers
to finish without increasing playback latency.

### Release Intelligence

The **Release Intelligence** page builds a small local naming database from the
recent-feed capability of configured Sport Sources. It makes one sport-category
feed request per source, not one remote search per event; SSS searches the saved
titles locally when researching an event. A Prowlarr source inventories and
collects each configured indexer independently, showing its protocol, capability,
feed/search/accepted/rejected counts, response time, and failure reason. Indexers
with an empty recent feed receive a bounded rotating selection of broad sports
queries so coverage grows over time without searching the complete event catalogue.
Indexers without a mapped TV/Sport category can also contribute through those
searches, but only when every meaningful word—or a tightly defined sports abbreviation
such as F1, UCL, or ONE FF—in the request appears in the result; those rows are visibly
marked `title-verified-sport`. A separate
collection timeout defaults to 30 seconds, so slow collection does not require
increasing playback latency. Prowlarr and direct Torznab sources are supported
initially; unsupported sources are skipped without being probed. Collection runs
hourly by default and can also be started manually.

The database stores only release title, publication/observation dates, size,
category, protocol, and source/indexer labels. It never stores credentials,
download URLs, magnets, info hashes, trackers, or NZB data. Search it in the GUI
or download the bounded safe JSON dataset for promotion research.
The metadata addon takes it from there: TorBox batched cache-check on the infoHashes, resolve cached candidates to playable URLs, return Stremio `url` rows only.

---

## Operations notes

- State is a flat JSON file (`data/sources.json` + `data/history.json`). Atomic-rename writes, file mode `0o600`. Volume-mount `/app/data` to survive container rebuilds.
- Logs mirror to `stdout`, so `docker logs serioussportsync-scraper` works fine, but the in-GUI log viewer is faster (SSE, filterable, no shell needed).
- Per-source timeouts are independent; one dead indexer doesn't stall the rest. The overall `SCRAPE_BUDGET_MS` is the hard ceiling, and callers may request a shorter per-call budget.
- Prowlarr searches aliases concurrently (three at a time by default) so events with many aliases do not incur serial query latency.
- All outbound HTTP honors `HTTPS_PROXY` + `NO_PROXY` if set — point at gluetun if you want the scraper to share its VPN egress.

---

## Status

Designed for a single operator running it next to their metadata addon. It has
no GUI authentication, multi-tenant auth, or user accounts. Keep the GUI
internal and set `SCRAPER_AUTH_TOKEN` for SSS API calls; do not expose it with a
plain public reverse-proxy route.
