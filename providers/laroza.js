// providers/laroza.js
// laroza scraper for nuvio.
// flow: follow the laroza.to redirect to the live domain -> tmdb metadata
//       -> search.php by title (episode/season aware for tv) -> video page
//       -> embed page -> external player -> packed jwplayer -> direct m3u8/mp4.

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
var TMDB_KEY = '68e094699525b18a70bab2f86b1fa706';
var ENTRY_URL = 'https://laroza.to';
var FALLBACK_BASES = ['https://laroza1.cfd', 'https://larooza.net'];
var DOMAIN_CACHE_MS = 10 * 60 * 1000;
var META_CACHE_MS = 30 * 60 * 1000;
var REQUEST_TIMEOUT_MS = 14000;

var cachedBase = null;
var cachedBaseAt = 0;
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
  return withTimeout(fetch(url, { headers: h, redirect: 'follow' }), REQUEST_TIMEOUT_MS)
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
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, function (_, n) {
    return String.fromCharCode(parseInt(n, 10));
  });
}

function originOf(url) {
  var m = /^(https?:\/\/[^/]+)/.exec(url);
  return m ? m[1] : '';
}

function looksLikeLaroza(html) {
  return /MELODYURL|laroza|video\.php|pm_video_data/i.test(html.slice(0, 60000));
}

function probeBase(base) {
  return httpGet(base + '/', { 'Referer': ENTRY_URL })
    .then(function (r) {
      return looksLikeLaroza(r.text) ? base : null;
    })
    .catch(function () { return null; });
}

function resolveBase(userConfig) {
  if (userConfig && userConfig.baseUrl) {
    return Promise.resolve(String(userConfig.baseUrl).replace(/\/$/, ''));
  }
  var now = Date.now();
  if (cachedBase && now - cachedBaseAt < DOMAIN_CACHE_MS) {
    return Promise.resolve(cachedBase);
  }
  // laroza.to always 301s to the current working domain; fetch follows the chain
  return httpGet(ENTRY_URL, { 'Referer': 'https://laroza.to/' })
    .then(function (r) {
      var origin = originOf(r.url);
      if (origin && origin !== 'https://laroza.to' && looksLikeLaroza(r.text)) {
        return origin;
      }
      if (origin && origin !== 'https://laroza.to') {
        return probeBase(origin).then(function (ok) { return ok || null; });
      }
      return null;
    })
    .catch(function () { return null; })
    .then(function (found) {
      if (found) return found;
      var chain = Promise.resolve(null);
      FALLBACK_BASES.forEach(function (base) {
        chain = chain.then(function (hit) {
          if (hit) return hit;
          return probeBase(base);
        });
      });
      return chain;
    })
    .then(function (base) {
      if (!base) throw new Error('no live laroza domain');
      cachedBase = base;
      cachedBaseAt = Date.now();
      return base;
    });
}

// ---------------------------------------------------------------------------
// tmdb metadata
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
// search + result matching
// ---------------------------------------------------------------------------

function toAsciiDigits(s) {
  return String(s)
    .replace(/[\u0660-\u0669]/g, function (c) { return String(c.charCodeAt(0) - 0x0660); })
    .replace(/[\u06F0-\u06F9]/g, function (c) { return String(c.charCodeAt(0) - 0x06F0); });
}

function normalizeText(s) {
  return toAsciiDigits(String(s).toLowerCase())
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function parseSearchResults(html) {
  var out = [];
  var re = /<a\s[^>]*>/g;
  var m;
  while ((m = re.exec(html)) !== null) {
    var tag = m[0];
    if (tag.indexOf('video.php?vid=') === -1) continue;
    var hrefM = /href\s*=\s*"([^"]*video\.php\?vid=([a-z0-9]+)[^"]*)"/i.exec(tag);
    var titleM = /title\s*=\s*"([^"]{2,300})"/.exec(tag);
    if (!hrefM) continue;
    var vid = hrefM[2];
    if (out.some(function (r) { return r.vid === vid; })) continue;
    out.push({
      vid: vid,
      title: titleM ? unescapeHtml(titleM[1]) : ''
    });
  }
  return out;
}

function scoreResult(result, info, mediaType, season, episode) {
  var attr = normalizeText(result.title);
  var title = normalizeText(info.title);
  if (!attr) return -1;

  var score = 0;
  if (title && attr.indexOf(title) !== -1) score += 10;
  else if (title && title.indexOf(attr) !== -1) score += 6;
  else {
    // fall back to word overlap
    var words = title.split(' ').filter(function (w) { return w.length > 2; });
    var hits = 0;
    words.forEach(function (w) { if (attr.indexOf(w) !== -1) hits++; });
    if (!words.length || hits < Math.ceil(words.length / 2)) return -1;
    score += hits;
  }

  if (info.year && attr.indexOf(info.year) !== -1) score += 3;

  var raw = toAsciiDigits(result.title).toLowerCase();
  var episodeMarker = /(?:حلقه|حلقة|episode|ep)\s*(\d{1,3})/.exec(raw) || /\b(\d{1,3})\b/.exec(raw.replace(/\d{4}/g, ' '));
  var seasonMarker = /(?:موسم|season)\s*(\d{1,2})/.exec(raw);

  if (mediaType === 'tv') {
    var wantEp = parseInt(episode || 1, 10);
    if (episodeMarker) {
      var gotEp = parseInt(episodeMarker[1], 10);
      if (gotEp === wantEp) score += 8;
      else score -= 12;
    }
    var wantSeason = parseInt(season || 1, 10);
    if (seasonMarker) {
      var gotSeason = parseInt(seasonMarker[1], 10);
      if (gotSeason === wantSeason) score += 4;
      else score -= 10;
    }
  } else {
    if (/\b(حلقه|حلقة|episode|ep)\s*\d/.test(raw)) score -= 12;
  }

  return score;
}

function pickResult(results, info, mediaType, season, episode) {
  var best = null;
  var bestScore = -Infinity;
  results.forEach(function (r) {
    var s = scoreResult(r, info, mediaType, season, episode);
    if (s > bestScore) { bestScore = s; best = r; }
  });
  if (bestScore < 4) return null;
  return best;
}

function searchSite(base, info, mediaType, season, episode) {
  var query = info.title + (info.year ? ' ' + info.year : '');
  var url = base + '/search.php?keywords=' + encodeURIComponent(query);
  return httpGet(url, { 'Referer': base + '/' }).then(function (r) {
    var results = parseSearchResults(r.text);
    if (!results.length && info.year) {
      // retry without the year
      var alt = base + '/search.php?keywords=' + encodeURIComponent(info.title);
      return httpGet(alt, { 'Referer': base + '/' }).then(function (r2) {
        return parseSearchResults(r2.text);
      });
    }
    return results;
  }).then(function (results) {
    if (!results.length) throw new Error('no search results for ' + info.title);
    var picked = pickResult(results, info, mediaType, season, episode);
    if (!picked) {
      // single result is good enough even when scoring is unsure
      if (results.length === 1) picked = results[0];
      else throw new Error('no confident match for ' + info.title);
    }
    return picked;
  });
}

// ---------------------------------------------------------------------------
// video page -> embed -> external player -> stream
// ---------------------------------------------------------------------------

function collectEmbedTargets(videoHtml, base, vid) {
  var out = [];
  function add(u) {
    if (!u) return;
    if (u.indexOf('//') === 0) u = 'https:' + u;
    if (out.indexOf(u) === -1) out.push(u);
  }
  var m = /embed_url\s*:\s*"([^"]+)"/.exec(videoHtml);
  if (m) add(unescapeHtml(m[1]));
  var re = /data-embed-url\s*=\s*"([^"]+)"/g;
  while ((m = re.exec(videoHtml)) !== null) add(unescapeHtml(m[1]));
  if (!out.length) add(base + '/embed.php?vid=' + encodeURIComponent(vid));
  return out.slice(0, 3);
}

var URL_RE = /https?:\\?\/\\?\/[^"'\s\\<>]+?\.(?:m3u8|mp4)(?:\?[^"'\s\\<>]*)?/gi;
var SKIP_HOST_RE = /(googletagmanager|google-analytics|histats|monetag|llvpn|googlesyndication|facebook|doubleclick)/i;

function cleanUrl(u) {
  return u.replace(/\\u0026/g, '&').replace(/\\&/g, '&').replace(/\\\/\//g, '//').replace(/&amp;/g, '&');
}

function scanForStream(text) {
  if (!text) return null;
  var m = URL_RE.exec(text);
  URL_RE.lastIndex = 0;
  if (m) return cleanUrl(m[0]);
  var re2 = /["'](https?:\\?\/\\?\/[^"']+?\.(?:m3u8|mp4)(?:\?[^"']*)?)["']/i;
  var m2 = re2.exec(text);
  if (m2) return cleanUrl(m2[1]);
  var m3 = /file\s*[:=]\s*["'](https?:[^"']+?\.(?:m3u8|mp4)(?:\?[^"']*)?)["']/i.exec(text);
  if (m3) return cleanUrl(m3[1]);
  return null;
}

// dean edwards packer: eval(function(p,a,c,k,e,d){...}('body',radix,count,'k0|k1|...'.split('|'),0,{}))
function unpackPacker(src) {
  var marker = 'eval(function(p,a,c,k,e,d)';
  var i = src.indexOf(marker);
  if (i < 0) return src;
  var j = src.indexOf("}('", i);
  if (j < 0) return src;
  var k = j + 3;
  var body = '';
  while (k < src.length) {
    var ch = src.charAt(k);
    if (ch === '\\') { body += src.substr(k, 2); k += 2; continue; }
    if (ch === "'") break;
    body += ch;
    k++;
  }
  var m = /^',(\d+),(\d+),'((?:[^'\\]|\\.)*)'\.split\('\|'\)/.exec(src.substr(k));
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
      var replacement = table[c].replace(/\\/g, '');
      out = out.replace(new RegExp('\\b' + tok(c) + '\\b', 'g'), function () { return replacement; });
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
    var m = /file\s*[:=]\s*["'](https?:[^"']+?\.(?:m3u8|mp4)(?:\?[^"']*)?)["']/i.exec(unpacked);
    if (m) return cleanUrl(m[1]);
  }
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
  return origin + '/' + stack.join('/');
}

// split a master m3u8 into one selectable stream per rendition
// (144p, 240p, 360p, 480p, 720p, 1080p, 4k ...) plus an auto option.
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

function firstPlayerFrame(html, pageUrl) {
  var re = /<iframe[^>]*\ssrc\s*=\s*"([^"]+)"/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var u = unescapeHtml(m[1]);
    if (!u || u.indexOf('about:') === 0 || u.indexOf('data:') === 0) continue;
    if (u.indexOf('//') === 0) u = 'https:' + u;
    if (SKIP_HOST_RE.test(u)) continue;
    return u;
  }
  return null;
}

function resolveVideoStream(embedTarget, base) {
  return httpGet(embedTarget, { 'Referer': base + '/' })
    .then(function (embedPage) {
      var direct = scanDeep(embedPage.text);
      if (direct) return { url: direct, referer: embedPage.url };
      var frame = firstPlayerFrame(embedPage.text, embedPage.url);
      if (!frame) return null;
      return httpGet(frame, { 'Referer': embedPage.url })
        .then(function (player) {
          var url = scanDeep(player.text);
          return url ? { url: url, referer: player.url } : null;
        })
        .catch(function () { return null; });
    })
    .catch(function () { return null; });
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

function getStreams(tmdbId, mediaType, season, episode, userConfig) {
  if (!tmdbId) return Promise.resolve([]);
  var config = userConfig || {};
  return Promise.all([
    resolveBase(config),
    tmdbInfo(tmdbId, mediaType)
  ]).then(function (parts) {
    var base = parts[0];
    var info = parts[1];
    if (!info.title) throw new Error('tmdb metadata unavailable');
    return searchSite(base, info, mediaType, season, episode).then(function (result) {
      return httpGet(base + '/video.php?vid=' + encodeURIComponent(result.vid), {
        'Referer': base + '/search.php'
      }).then(function (videoPage) {
        var videoTitle = result.title || info.title;
        var tm = /title\s*:\s*'([^']{2,200})'/.exec(videoPage.text) ||
                 /title\s*:\s*"([^"]{2,200})"/.exec(videoPage.text);
        if (tm) videoTitle = unescapeHtml(tm[1]);
        var targets = collectEmbedTargets(videoPage.text, base, result.vid);
        var chain = Promise.resolve([]);
        targets.forEach(function (target) {
          chain = chain.then(function (acc) {
            if (acc.length >= 24) return acc;
            return resolveVideoStream(target, base).then(function (hit) {
              if (hit && hit.url && /^https?:\/\//.test(hit.url)) {
                var quality = qualityFromUrl(hit.url);
                var stream = {
                  name: 'Laroza',
                  title: videoTitle + ' · ' + quality,
                  url: hit.url,
                  quality: quality,
                  headers: {
                    'User-Agent': UA,
                    'Referer': hit.referer || originOf(target) + '/'
                  }
                };
                return expandMaster(stream).then(function (list) {
                  list.forEach(function (s) { acc.push(s); });
                  return acc;
                });
              }
              return acc;
            });
          });
        });
        return chain;
      });
    });
  }).catch(function (err) {
    console.log('[Laroza] error: ' + (err && err.message ? err.message : err));
    return [];
  });
}

module.exports = {
  getStreams: getStreams,
  // internals exposed for the offline fixture tests in test/
  _test: {
    parseSearchResults: parseSearchResults,
    scoreResult: scoreResult,
    pickResult: pickResult,
    unpackPacker: unpackPacker,
    scanDeep: scanDeep,
    expandMaster: expandMaster,
    normalizeText: normalizeText,
    toAsciiDigits: toAsciiDigits,
    collectEmbedTargets: collectEmbedTargets
  }
};
