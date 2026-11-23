// providers/hydrahd.js
// hydrahd scraper for nuvio.
// flow: resolve live domain from hydrahd.info -> tmdb metadata (title + imdb id)
//       -> site ajax layer returns the server list -> each embed host is
//       resolved to a direct m3u8/mp4 link by the extractor registry.

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
var TMDB_KEY = '68e094699525b18a70bab2f86b1fa706';
var STATUS_URL = 'https://hydrahd.info';
var FALLBACK_DOMAINS = [
  'https://hydrahd.gd',
  'https://hydrahd.com',
  'https://hydrahd.ws',
  'https://hydrahd.io',
  'https://hydrahd.cc',
  'https://hydrahd.me',
  'https://hydrahd.ac'
];
var DOMAIN_CACHE_MS = 10 * 60 * 1000;
var META_CACHE_MS = 30 * 60 * 1000;
var EMBED_TIMEOUT_MS = 14000;

var cachedBase = null;
var cachedBaseAt = 0;
var cachedList = null;
var cachedListAt = 0;
var metaCache = {};

function withTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    var done = false;
    var timer = setTimeout(function () {
      if (!done) { done = true; reject(new Error('timeout')); }
    }, ms);
    promise.then(function (v) {
      if (!done) { done = true; clearTimeout(timer); resolve(v); }
    }, function (e) {
      if (!done) { done = true; clearTimeout(timer); reject(e); }
    });
  });
}

function httpGet(url, headers) {
  var h = { 'User-Agent': UA, 'Accept': '*/*' };
  if (headers) {
    for (var k in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, k)) h[k] = headers[k];
    }
  }
  return withTimeout(fetch(url, { headers: h, redirect: 'follow' }), EMBED_TIMEOUT_MS)
    .then(function (res) {
      if (!res.ok) throw new Error('http ' + res.status + ' for ' + url);
      return res.text().then(function (text) {
        return { text: text, url: res.url || url, status: res.status };
      });
    });
}

function httpGetJson(url, headers) {
  return httpGet(url, headers).then(function (r) {
    try { return JSON.parse(r.text); } catch (e) { throw new Error('bad json from ' + url); }
  });
}

function unescapeHtml(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function originOf(url) {
  var m = /^(https?:\/\/[^/]+)/.exec(url);
  return m ? m[1] : '';
}

function hostOf(url) {
  var m = /^(?:https?:\/\/)?([^/?#]+)/.exec(url);
  return m ? m[1].toLowerCase() : '';
}

// ---------------------------------------------------------------------------
// domain resolution
// ---------------------------------------------------------------------------

function probeDomain(base) {
  return httpGet(base + '/', { 'Referer': STATUS_URL })
    .then(function (r) {
      var ok = r.text.length > 3000 && /hydrahd/i.test(r.text) && !/blockpage|blocked|nextdns/i.test(r.text.slice(0, 2000));
      return ok ? base : null;
    })
    .catch(function () { return null; });
}

function domainsFromStatusPage(html) {
  var out = [];
  var re = /href\s*=\s*"(https:\/\/hydrahd\.[a-z]{2,4})\/?"/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var base = m[1].toLowerCase();
    if (base === 'https://hydrahd.ru') continue; // marked disabled by the site
    if (out.indexOf(base) === -1) out.push(base);
  }
  return out;
}

function resolveCandidates() {
  var now = Date.now();
  if (cachedList && now - cachedListAt < DOMAIN_CACHE_MS) {
    return Promise.resolve(cachedList);
  }
  return httpGet(STATUS_URL)
    .then(function (r) {
      var list = domainsFromStatusPage(r.text);
      return list.length ? list : FALLBACK_DOMAINS.slice();
    })
    .catch(function () { return FALLBACK_DOMAINS.slice(); })
    .then(function (list) {
      var seen = {};
      var ordered = [];
      list.concat(FALLBACK_DOMAINS).forEach(function (d) {
        if (!seen[d]) { seen[d] = true; ordered.push(d); }
      });
      var candidates = ordered.slice(0, 5);
      var live = [];
      var chain = Promise.resolve(null);
      candidates.forEach(function (base) {
        chain = chain.then(function () {
          return probeDomain(base).then(function (ok) {
            if (ok && live.length < 4) live.push(ok);
          });
        });
      });
      return chain.then(function () {
        if (!live.length) throw new Error('no live hydrahd domain');
        cachedList = live;
        cachedListAt = Date.now();
        return live;
      });
    });
}

// some backup mirrors serve the homepage but have no ajax backend, so the
// server list request itself decides which domain is actually usable.
function fetchServersFromAny(candidates, tmdbId, mediaType, season, episode, imdb) {
  var order = candidates.slice();
  if (cachedBase && order.indexOf(cachedBase) !== -1) {
    order = [cachedBase].concat(order.filter(function (b) { return b !== cachedBase; }));
  }
  var chain = Promise.reject(new Error('no candidates'));
  order.forEach(function (base) {
    chain = chain.catch(function () {
      return fetchServers(base, tmdbId, mediaType, season, episode, imdb)
        .then(function (servers) {
          cachedBase = base;
          cachedBaseAt = Date.now();
          return servers;
        });
    });
  });
  return chain;
}

// ---------------------------------------------------------------------------
// tmdb metadata (title + year + imdb id)
// ---------------------------------------------------------------------------

function tmdbInfo(tmdbId, mediaType) {
  var key = mediaType + ':' + tmdbId;
  if (metaCache[key] && Date.now() - metaCache[key].at < META_CACHE_MS) {
    return Promise.resolve(metaCache[key].info);
  }
  var kind = mediaType === 'tv' ? 'tv' : 'movie';
  var url = 'https://api.themoviedb.org/3/' + kind + '/' + tmdbId +
    '?api_key=' + TMDB_KEY + '&append_to_response=external_ids';
  return httpGetJson(url)
    .then(function (d) {
      var info = {
        title: kind === 'tv' ? (d.name || '') : (d.title || ''),
        year: kind === 'tv'
          ? String(d.first_air_date || '').slice(0, 4)
          : String(d.release_date || '').slice(0, 4),
        imdb: (d.external_ids && d.external_ids.imdb_id) || d.imdb_id || ''
      };
      metaCache[key] = { info: info, at: Date.now() };
      return info;
    });
}

// ---------------------------------------------------------------------------
// site ajax layer -> server list
// ---------------------------------------------------------------------------

function parseServers(html) {
  var out = [];
  var seen = {};
  var re = /data-link\s*=\s*"([^"]+)"/g;
  var m;
  while ((m = re.exec(html)) !== null) {
    var link = unescapeHtml(m[1]);
    if (seen[link]) continue;
    var seg = html.substr(m.index + m[0].length, 400);
    var nameMatch = /<p[^>]*>([^<]{1,60})<\/p>/.exec(seg);
    var name = nameMatch ? nameMatch[1].replace(/\s+/g, ' ').trim() : 'Server';
    seen[link] = true;
    out.push({ name: name, link: link });
  }
  return out;
}

function fetchServers(base, tmdbId, mediaType, season, episode, imdb) {
  var path;
  if (mediaType === 'tv') {
    path = '/ajax/tv_0.php?t=' + encodeURIComponent(tmdbId) +
      '&i=' + encodeURIComponent(imdb) +
      '&s=' + encodeURIComponent(season || 1) +
      '&e=' + encodeURIComponent(episode || 1);
  } else {
    path = '/ajax/mov_0.php?t=' + encodeURIComponent(tmdbId) +
      '&i=' + encodeURIComponent(imdb);
  }
  return httpGet(base + path, {
    'Referer': base + '/',
    'X-Requested-With': 'XMLHttpRequest',
    'Accept': 'text/html, */*'
  }).then(function (r) {
    if (r.text.indexOf('data-link') === -1) throw new Error('empty server list');
    return parseServers(r.text);
  });
}

// ---------------------------------------------------------------------------
// stream scanning
// ---------------------------------------------------------------------------

var URL_RE = /https?:\\?\/\\?\/[^"'\s\\<>]+?\.(?:m3u8|mp4)(?:\?[^"'\s\\<>]*)?/gi;
var SKIP_HOST_RE = /(googletagmanager|google-analytics|histats|monetag|llvpn|cdn\.cloudflare|cdnjs|googleapis|gstatic|facebook|doubleclick|adservice)/i;

function cleanUrl(u) {
  return u.replace(/\\u0026/g, '&').replace(/\\&/g, '&').replace(/\\\/\//g, '//').replace(/&amp;/g, '&');
}

function scanForStream(text) {
  if (!text) return null;
  var m = URL_RE.exec(text);
  URL_RE.lastIndex = 0;
  if (m) return cleanUrl(m[0]);
  // json-escaped or single-quoted candidates
  var re2 = /["'](https?:\\?\/\\?\/[^"']+?\.(?:m3u8|mp4)(?:\?[^"']*)?)["']/gi;
  var m2 = re2.exec(text);
  if (m2) return cleanUrl(m2[1]);
  return null;
}

// dean edwards style packer: eval(function(p,a,c,k,e,d){...}('body',radix,count,'k0|k1|...'.split('|'),0,{}))
function unpackPacker(src) {
  var marker = 'eval(function(p,a,c,k,e,d)';
  var i = src.indexOf(marker);
  if (i < 0) return src;
  var j = src.indexOf("}('", i);
  if (j < 0) return src;
  var start = j + 3;
  var k = start;
  var body = '';
  while (k < src.length) {
    var ch = src.charAt(k);
    if (ch === '\\') { body += src.substr(k, 2); k += 2; continue; }
    if (ch === "'") break;
    body += ch;
    k++;
  }
  var tail = src.substr(k);
  var m = /^',(\d+),(\d+),'((?:[^'\\]|\\.)*)'\.split\('\|'\)/.exec(tail);
  if (!m) return src;
  var radix = parseInt(m[1], 10);
  var count = parseInt(m[2], 10);
  var table = m[3].split('|');
  if (!radix || radix < 2 || radix > 36 || !count) return src;
  var digs = '0123456789abcdefghijklmnopqrstuvwxyz'.substring(0, radix);
  function tok(n) {
    var s = '';
    while (n > 0) {
      s = digs.charAt(n % radix) + s;
      n = Math.floor(n / radix);
    }
    return s || digs.charAt(0);
  }
  var out = body;
  for (var c = count - 1; c >= 0; c--) {
    if (c < table.length && table[c]) {
      var token = tok(c);
      var replacement = table[c].replace(/\\/g, '');
      out = out.replace(new RegExp('\\b' + token + '\\b', 'g'), function () { return replacement; });
    }
  }
  return out;
}

function scanDeep(text) {
  var url = scanForStream(text);
  if (url) return url;
  var unpacked = unpackPacker(text);
  if (unpacked !== text) {
    url = scanForStream(unpacked);
    if (url) return url;
  }
  // jwplayer style file: "..."
  var m = /file\s*[:=]\s*["'](https?:[^"']+?\.(?:m3u8|mp4)(?:\?[^"']*)?)["']/i.exec(text);
  if (m) return cleanUrl(m[1]);
  return null;
}

function qualityFromUrl(url) {
  var m = /(\d{3,4})p/.exec(url);
  if (m) return m[1] + 'p';
  if (/master\.m3u8/i.test(url)) return 'Auto';
  if (/2160|4k/i.test(url)) return '4K';
  if (/cam/i.test(url)) return 'CAM';
  return 'Auto';
}

function qualityFromHeight(h, w) {
  if (h >= 2000 || w >= 3800) return '4K';
  if (h >= 1400) return '1440p';
  if (h >= 1000) return '1080p';
  if (h >= 700) return '720p';
  if (h >= 540) return '540p';
  if (h >= 460) return '480p';
  if (h >= 340) return '360p';
  if (h >= 220) return '240p';
  if (h >= 130) return '144p';
  return h + 'p';
}

function resolveRelativeUrl(base, rel) {
  if (/^https?:\/\//i.test(rel)) return rel;
  var origin = originOf(base);
  if (rel.charAt(0) === '/') return origin + rel;
  var basePath = base.split('?')[0].split('#')[0].replace(/\/[^/]*$/, '/');
  var combined = basePath + rel;
  var pathOnly = combined.replace(/^https?:\/\/[^/]+/, '');
  var parts = pathOnly.split('/');
  var stack = [];
  for (var i = 0; i < parts.length; i++) {
    var seg = parts[i];
    if (seg === '..') stack.pop();
    else if (seg !== '.' && seg !== '') stack.push(seg);
  }
  var last = parts[parts.length - 1];
  var tail = /\/$/.test(combined) ? '/' : '';
  return origin + '/' + stack.join('/') + (tail || (last ? '' : ''));
}

// a master m3u8 carries every rendition the host offers. split it so nuvio's
// picker lists 144p, 360p, 720p, 1080p, 4k as separate selectable streams.
function expandMaster(stream) {
  if (!/\.m3u8(\?|$)/i.test(stream.url)) return Promise.resolve([stream]);
  return httpGet(stream.url, { 'Referer': stream.headers.Referer || stream.url, 'Accept': '*/*' })
    .then(function (r) {
      if (r.text.indexOf('#EXT-X-STREAM-INF') === -1) return [stream];
      var lines = r.text.split(/\r?\n/);
      var out = [];
      for (var i = 0; i < lines.length - 1; i++) {
        if (lines[i].indexOf('#EXT-X-STREAM-INF') === -1) continue;
        var res = /RESOLUTION=(\d+)x(\d+)/i.exec(lines[i]);
        var next = lines[i + 1].trim();
        if (!next || next.charAt(0) === '#') continue;
        var variantUrl = resolveRelativeUrl(r.url || stream.url, next);
        var quality = res
          ? qualityFromHeight(parseInt(res[2], 10), parseInt(res[1], 10))
          : qualityFromUrl(variantUrl);
        var copy = {};
        for (var k in stream) {
          if (Object.prototype.hasOwnProperty.call(stream, k)) copy[k] = stream[k];
        }
        copy.url = variantUrl;
        copy.quality = quality;
        copy.title = quality;
        out.push(copy);
      }
      if (!out.length) return [stream];
      // keep the master itself last as an auto option
      var masterCopy = {};
      for (var k2 in stream) {
        if (Object.prototype.hasOwnProperty.call(stream, k2)) masterCopy[k2] = stream[k2];
      }
      masterCopy.quality = 'Auto';
      masterCopy.title = 'Auto';
      out.push(masterCopy);
      return out;
    })
    .catch(function () { return [stream]; });
}

// ---------------------------------------------------------------------------
// embed extractors
// ---------------------------------------------------------------------------

function extractVixsrc(embedUrl, tmdbId, mediaType, season, episode) {
  var isTv = mediaType === 'tv' || /\/tv\//.test(embedUrl);
  var apiPath = isTv
    ? '/api/tv/' + tmdbId + '?season=' + encodeURIComponent(season || 1) + '&episode=' + encodeURIComponent(episode || 1)
    : '/api/movie/' + tmdbId;
  var origin = originOf(embedUrl) || 'https://vixsrc.to';
  return httpGetJson(origin + apiPath, { 'Referer': embedUrl })
    .then(function (d) {
      if (!d || !d.src) return null;
      var embedPage = origin + d.src;
      return httpGet(embedPage, { 'Referer': origin + '/' }).then(function (r) {
        var url = scanDeep(r.text);
        if (url) return { url: url, referer: embedPage };
        var streamsRe = /window\.streams\s*=\s*(\[[\s\S]*?\])/;
        var sm = streamsRe.exec(r.text);
        if (!sm) return null;
        var list;
        try { list = JSON.parse(sm[1]); } catch (e) { return null; }
        var chain = Promise.resolve(null);
        list.slice(0, 2).forEach(function (s) {
          chain = chain.then(function (found) {
            if (found || !s || !s.url) return found;
            var playlistUrl = cleanUrl(String(s.url).replace(/\\\//g, '/'));
            return httpGet(playlistUrl, { 'Referer': embedPage })
              .then(function (pr) {
                var u = scanDeep(pr.text);
                return u ? { url: u, referer: playlistUrl } : null;
              })
              .catch(function () { return null; });
          });
        });
        return chain;
      });
    })
    .catch(function () { return null; });
}

function extractPrimesrc(embedUrl, tmdbId, mediaType, season, episode, imdb) {
  var isTv = mediaType === 'tv' || /\/tv\//.test(embedUrl);
  var api = '/api/v1/s?type=' + (isTv ? 'tv' : 'movie') +
    '&tmdb=' + encodeURIComponent(tmdbId);
  if (imdb) api += '&imdb=' + encodeURIComponent(imdb);
  if (isTv) {
    api += '&season=' + encodeURIComponent(season || 1) + '&episode=' + encodeURIComponent(episode || 1);
  }
  var origin = originOf(embedUrl) || 'https://primesrc.me';
  var hdr = { 'Referer': embedUrl, 'Accept': 'application/json, text/plain, */*' };
  return httpGetJson(origin + api, hdr)
    .then(function (d) {
      if (!d || !d.servers || !d.servers.length) return null;
      var chain = Promise.resolve(null);
      d.servers.slice(0, 3).forEach(function (s) {
        chain = chain.then(function (found) {
          if (found || !s.key) return found;
          return httpGet(origin + '/api/v1/l?key=' + encodeURIComponent(s.key), hdr)
            .then(function (r) {
              var u = scanDeep(r.text);
              return u ? { url: u, referer: origin + '/' } : null;
            })
            .catch(function () { return null; });
        });
      });
      return chain;
    })
    .catch(function () { return null; });
}

function collectIframeTargets(html, baseUrl) {
  var out = [];
  var re = /(?:src|data-src)\s*=\s*"(https?:\/\/[^"]+)"/g;
  var m;
  while ((m = re.exec(html)) !== null) {
    var u = cleanUrl(m[1]);
    if (SKIP_HOST_RE.test(u)) continue;
    if (out.indexOf(u) === -1) out.push(u);
  }
  // relative embed paths
  var re2 = /(?:src|data-src)\s*=\s*"\/([^"]{3,120})"/g;
  while ((m = re2.exec(html)) !== null) {
    var rel = originOf(baseUrl) + '/' + m[1];
    if (SKIP_HOST_RE.test(rel)) continue;
    if (out.indexOf(rel) === -1) out.push(rel);
  }
  return out;
}

function collectApiTargets(html, baseUrl) {
  var out = [];
  var origin = originOf(baseUrl);
  var re = /["'](\/(?:api|ajax)\/[a-z0-9_./-]{2,80}(?:\?[^"'\s]{0,120})?|\/[a-z0-9_]+\.php(?:\?[^"'\s]{0,120})?)["']/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var u = origin + m[1];
    if (SKIP_HOST_RE.test(u)) continue;
    if (out.indexOf(u) === -1) out.push(u);
  }
  return out;
}

// chase a page: scan it, then follow api endpoints and iframes (depth limited)
function chase(url, referer, depth) {
  return httpGet(url, { 'Referer': referer || url })
    .then(function (r) {
      var found = scanDeep(r.text);
      if (found) return { url: found, referer: url };
      if (depth <= 0) return null;
      var targets = collectApiTargets(r.text, r.url).concat(collectIframeTargets(r.text, r.url));
      var chain = Promise.resolve(null);
      targets.slice(0, 5).forEach(function (t) {
        chain = chain.then(function (hit) {
          if (hit) return hit;
          return chase(t, url, depth - 1).catch(function () { return null; });
        });
      });
      return chain;
    })
    .catch(function () { return null; });
}

var MOVIESAPI_KEY = '3a67e8866ae1d2bb9e81fe7f73315a56eb3bdf5e3e755c7554c8be6910aa6b13';

function extractMoviesapi(embedUrl, tmdbId, mediaType, season, episode) {
  var isTv = mediaType === 'tv' || /\/tv\//.test(embedUrl);
  var path = isTv
    ? '/tv/' + tmdbId + '/' + encodeURIComponent(season || 1) + '/' + encodeURIComponent(episode || 1)
    : '/movie/' + tmdbId;
  var origin = originOf(embedUrl) || 'https://moviesapi.to';
  return httpGetJson(origin + '/api/vidora/v1' + path, {
    'Referer': embedUrl,
    'x-player-key': MOVIESAPI_KEY,
    'Accept': 'application/json, text/plain, */*'
  }).then(function (d) {
    if (!d || !d.sources) return null;
    var chain = Promise.resolve(null);
    d.sources.forEach(function (s) {
      chain = chain.then(function (found) {
        if (found || !s || !s.url) return found;
        var u = cleanUrl(String(s.url));
        return /^https?:\/\//.test(u) ? { url: u, referer: origin + '/' } : found;
      });
    });
    return chain;
  }).catch(function () { return null; });
}

function resolveEmbed(server, ctx) {
  var link = server.link;
  var host = hostOf(link);
  var direct;

  if (host.indexOf('vixsrc.to') !== -1) {
    direct = extractVixsrc(link, ctx.tmdbId, ctx.mediaType, ctx.season, ctx.episode);
  } else if (host.indexOf('primesrc.me') !== -1) {
    direct = extractPrimesrc(link, ctx.tmdbId, ctx.mediaType, ctx.season, ctx.episode, ctx.imdb);
  } else if (host.indexOf('moviesapi.to') !== -1) {
    direct = extractMoviesapi(link, ctx.tmdbId, ctx.mediaType, ctx.season, ctx.episode);
  } else {
    direct = chase(link, ctx.base + '/', 2);
  }

  return Promise.resolve(direct)
    .catch(function () { return null; })
    .then(function (hit) {
      if (hit && hit.url) return hit;
      // generic fallback pass over the embed page itself
      return chase(link, ctx.base + '/', 1).catch(function () { return null; });
    })
    .then(function (hit) {
      if (!hit || !hit.url) return null;
      if (!/^https?:\/\//.test(hit.url)) return null;
      return {
        name: 'HydraHD · ' + server.name,
        title: server.name,
        url: hit.url,
        quality: qualityFromUrl(hit.url),
        headers: {
          'User-Agent': UA,
          'Referer': hit.referer || originOf(link) + '/'
        }
      };
    });
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

function getStreams(tmdbId, mediaType, season, episode, userConfig) {
  if (!tmdbId) return Promise.resolve([]);
  var config = userConfig || {};
  var domainStep = config.baseUrl
    ? Promise.resolve([String(config.baseUrl).replace(/\/$/, '')])
    : resolveCandidates();
  return Promise.all([
    domainStep,
    tmdbInfo(tmdbId, mediaType)
  ]).then(function (parts) {
    var candidates = parts[0];
    var info = parts[1];
    if (!info.title && !info.imdb) throw new Error('tmdb metadata unavailable');
    return fetchServersFromAny(candidates, tmdbId, mediaType, season, episode, info.imdb)
      .then(function (servers) {
        var base = cachedBase || candidates[0];
        var ctx = {
          base: base,
          tmdbId: String(tmdbId),
          mediaType: mediaType === 'tv' ? 'tv' : 'movie',
          season: season || 1,
          episode: episode || 1,
          imdb: info.imdb || '',
          title: info.title,
          year: info.year
        };
        var picked = servers.slice(0, 14);
        return Promise.all(picked.map(function (server) {
          return resolveEmbed(server, ctx).catch(function () { return null; });
        })).then(function (hits) {
          var streams = hits.filter(function (s) { return !!s; });
          return Promise.all(streams.map(expandMaster)).then(function (lists) {
            var out = [];
            lists.forEach(function (l) {
              l.forEach(function (s) { out.push(s); });
            });
            return out;
          });
        });
      });
  }).catch(function (err) {
    console.log('[HydraHD] error: ' + (err && err.message ? err.message : err));
    return [];
  });
}

module.exports = {
  getStreams: getStreams,
  // internals exposed for debugging and offline tests
  _test: {
    parseServers: parseServers,
    extractVixsrc: extractVixsrc,
    extractPrimesrc: extractPrimesrc,
    extractMoviesapi: extractMoviesapi,
    expandMaster: expandMaster,
    chase: chase,
    unpackPacker: unpackPacker,
    scanDeep: scanDeep,
    resolveCandidates: resolveCandidates
  }
};
