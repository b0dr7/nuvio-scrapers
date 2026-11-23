// test/hydrahd.js - run outside nuvio:  node test/hydrahd.js [tmdbId] [movie|tv] [season] [episode]
var provider = require('../providers/hydrahd.js');

var tmdbId = process.argv[2] || '872585';      // oppenheimer
var mediaType = process.argv[3] || 'movie';
var season = process.argv[4] || 1;
var episode = process.argv[5] || 1;
var cfg = process.env.HYDRAHD_BASE ? { baseUrl: process.env.HYDRAHD_BASE } : {};

console.log('[test] hydrahd getStreams ' + mediaType + ' ' + tmdbId +
  (mediaType === 'tv' ? ' s' + season + 'e' + episode : ''));

provider.getStreams(tmdbId, mediaType, season, episode, cfg)
  .then(function (streams) {
    console.log('[test] streams: ' + streams.length);
    streams.forEach(function (s) {
      console.log('  - ' + s.name + ' | ' + s.quality + ' | ' + s.url.slice(0, 140));
    });
    if (!streams.length) process.exitCode = 1;
  })
  .catch(function (err) {
    console.error('[test] failed:', err);
    process.exitCode = 1;
  });
