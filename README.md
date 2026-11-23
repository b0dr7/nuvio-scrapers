# nuvio-scrapers

local javascript scrapers for the nuvio app. two sites, two separate plugins: hydrahd and laroza. each lives in its own file with its own manifest entry so you can enable one, the other, or both.

no content is hosted here. the scrapers only talk to the sites themselves and hand nuvio a playable link.

## install

1. open nuvio, go to settings, then plugins
2. add this repository url:

```
https://raw.githubusercontent.com/b0dr7/nuvio-scrapers/main/manifest.json
```

3. refresh the list, then enable hydrahd and/or laroza

## how hydrahd works

- on first run (and every 10 minutes after) the scraper reads the live domain list from `hydrahd.info`, skips anything marked disabled, and probes candidates until one answers. `hydrahd.gd` is tried first, so a normal run costs one extra request at most.
- hydrahd does not hand out streams directly. given a tmdb id, the scraper asks tmdb for the title, year and imdb id, then hits the site's own ajax layer:
  - movies: `GET /ajax/mov_0.php?t=<tmdb>&i=<imdb>`
  - series: `GET /ajax/tv_0.php?t=<tmdb>&i=<imdb>&s=<season>&e=<episode>`
- that returns the full server list (embed hosts with names). the scraper runs each host through its extractor registry:
  - `vixsrc` -> `/api/movie/<tmdb>` -> embed page -> `window.streams` -> playlist -> m3u8
  - `primesrc` -> `/api/v1/s` (server keys) -> `/api/v1/l?key=` -> m3u8/mp4
  - everything else -> generic pass: direct link scan, packed-javascript decode, quoted `/api/` and `.php` endpoints, one level of iframe chasing
- working links come back with the referer and user-agent nuvio needs for playback. hosts that do not resolve simply contribute nothing; when a host changes, its extractor in `providers/hydrahd.js` is the thing to update.

the site also has a normal search system (`GET /index.php?menu=search&query=<q>` returning `/movie/...` and `/watchseries/...` links). the scraper does not need it for streams because the ajax layer takes tmdb ids directly, but the endpoint is there if you ever want to browse from the plugin.

## how laroza works

- `laroza.to` always redirects to whatever domain is live today (currently `laroza1.cfd` via an intermediate hop). the scraper follows the redirect chain, validates the landing page actually is laroza, and caches the result for 10 minutes. if the redirect target is unreachable, it probes a short fallback list.
- laroza is an arabic site, so titles look like `فيلم Oppenheimer 2023 مترجم HD اون لاين`. the scraper searches `GET /search.php?keywords=<title> <year>` and scores the results against the tmdb title and year. for series it also matches `حلقة <n>` (episode) and `موسم <n>` (season), with arabic-indic digits normalised, so `s02e05` lands on the right video page.
- from the video page it takes `embed_url` (or `data-embed-url` server entries, or falls back to `embed.php?vid=`), follows the external player iframe, decodes the packed jwplayer config (`eval(function(p,a,c,k,e,d)...)`), and returns the direct `master.m3u8` link with the correct referer.

## structure

```
nuvio-scrapers/
├── manifest.json          plugin registry, one entry per site (plus a scrapers mirror)
├── providers/
│   ├── hydrahd.js         hydrahd scraper
│   └── laroza.js          laroza scraper
├── test/
│   ├── hydrahd.js         node test harness
│   └── laroza.js
├── tools/warp/            optional warp proxy helper, see below
├── LICENSE
└── README.md
```

## if your dns or isp blocks the sites

the plugins cannot start a tunnel from inside the nuvio app itself, so blocking has to be handled at the network layer. two options:

**warp as a proxy.** `tools/warp/warp-setup.sh` downloads wgcf and wireproxy, registers a free warp account, and exposes the tunnel as `socks5://<lan-ip>:40000` and `http://<lan-ip>:40001`. run it on a box on the same network as the device running nuvio (or on a router that can run binaries), then point the device's proxy setting at it. every request nuvio makes, scrapes included, then leaves through warp and the blocks stop mattering.

```
chmod +x tools/warp/warp-setup.sh
sudo ./tools/warp/warp-setup.sh
curl -x socks5://127.0.0.1:40000 https://hydrahd.info
```

**dns only.** if the block is dns-level (private dns providers love sinkholing these domains), switching the device to `1.1.1.1` or `8.8.8.8` is enough. hydrahd's own domains page has per-device instructions for this.

## testing outside the app

both scrapers are plain node modules (node 18+, for the built-in fetch):

```
node test/hydrahd.js 872585 movie
node test/hydrahd.js 247718 tv 1 1
node test/laroza.js 872585 movie
```

this runs the full path - domain resolution, metadata, search, page parse, stream extraction - and prints whatever links it found. useful for checking whether a site changed before blaming the app.

## notes

- the files in `providers/` are written to run as-is under hermes: promise chains instead of async/await, no optional chaining, no node-only imports. `fetch`, `console` and `require` are provided by the app.
- the tmdb key in both providers is the same public read-only key used by other open provider repos. tmdb is only queried for the title, year and imdb id - never for media.
- these sites change markup and rotate domains often. when a scraper stops finding streams: check `hydrahd.info` for hydrahd, check where `laroza.to` redirects for laroza, then run the node test harness - it shows exactly which stage broke.

## license

gpl-3.0
