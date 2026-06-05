const axios = require('axios');
const { cacheWrapAnizp } = require('./cache');
const { getGenreUrl } = require('./config')
const kitsuToImdbMappping = require('../static/data/imdb_mapping')
    .reduce((map, entry) => (map[entry.kitsu_id] = entry, map), {});
const imdbToKitsuMapping = Object.entries(kitsuToImdbMappping)
    .map(([kitsuId, value]) => ({
      kitsu_id: kitsuId,
      imdb_id: value.imdb_id,
      title: value.title,
      nonImdbEpisodes: value.nonImdbEpisodes,
      fromSeason: value.fromSeason === undefined ? 1 : value.fromSeason,
      fromEpisode: value.fromEpisode === undefined ? 1 : value.fromEpisode
    }))
    .filter((entry) => entry.imdb_id)
    .reduce((map, nextEntry) => {
      map[nextEntry.imdb_id] = (map[nextEntry.imdb_id] || []).concat(nextEntry)
          .sort((a, b) => {
            const seasonSort = a.fromSeason - b.fromSeason;
            if (seasonSort !== 0) {
              return seasonSort;
            }
            return a.fromEpisode - b.fromEpisode
          });
      return map;
    }, {});

async function fetchAnizpMetadata(kitsuId) {
  const url = `https://api.ani.zip/mappings?kitsu_id=${kitsuId}`;
  try {
    const resp = await axios.get(url, { timeout: 8000 });
    if (resp.status === 200 && resp.data) {
      return resp.data;
    }
  } catch (err) {
    console.warn(`Failed to fetch rich metadata from ani.zip for kitsu_id ${kitsuId}:`, err.message);
  }
  return null;
}

function hasImdbMapping(id) {
  if (id.startsWith('tt')) {
    return !!imdbToKitsuMapping[id];
  }
  return !!kitsuToImdbMappping[id]
}

function getImdbMapping(kitsuId) {
  return kitsuToImdbMappping[kitsuId];
}

async function enrichKitsuMetadata(metadata, retrieveImdbMetadata) {
  const kitsuId = metadata.kitsu_id;
  
  // 1. Fetch ani.zip mapping metadata (cached for 7 days)
  const anizpData = await cacheWrapAnizp(kitsuId, () => fetchAnizpMetadata(kitsuId)).catch(() => undefined);
  
  if (anizpData) {
    // 2. Enrich poster and background with high quality images from ani.zip
    const anizpPoster = anizpData.images?.find(img => img.coverType === 'Poster')?.url;
    const anizpFanart = anizpData.images?.find(img => img.coverType === 'Fanart')?.url;
    const anizpLogo = anizpData.images?.find(img => img.coverType === 'Clearlogo')?.url;
    
    if (anizpPoster) {
      metadata.poster = anizpPoster.replace('http://', 'https://');
    }
    if (anizpFanart) {
      metadata.background = anizpFanart.replace('http://', 'https://');
    }
    if (anizpLogo) {
      metadata.logo = anizpLogo.replace('http://', 'https://');
    }
    
    // 3. Enrich episodes with titles, release dates, overviews, and thumbnails
    if (metadata.videos && metadata.videos.length && anizpData.episodes) {
      metadata.videos = metadata.videos.map(video => {
        const epNum = video.episode;
        const anizpEp = anizpData.episodes[epNum.toString()] || {};
        
        const anizpTitle = anizpEp.title?.en || anizpEp.title?.['x-jat'];
        const title = (video.title && !video.title.match(/^Episode \d+$/i)) ? video.title : (anizpTitle || video.title);
        
        let released = video.released;
        if (anizpEp.airdate) {
          const airdate = new Date(anizpEp.airdate);
          if (!isNaN(airdate.getTime())) {
            released = airdate;
          }
        }
        
        const overview = video.overview || anizpEp.overview || anizpEp.summary || '';
        const thumbnail = anizpEp.image || video.thumbnail || metadata.background;
        
        return {
          ...video,
          title,
          released,
          overview,
          thumbnail: thumbnail ? thumbnail.replace('http://', 'https://') : undefined
        };
      });
    }
  }
  
  // 4. Enrich with IMDb (Cinemeta) if mapping exists
  const imdbId = anizpData?.mappings?.imdb_id || kitsuToImdbMappping[kitsuId]?.imdb_id;
  if (imdbId) {
    const imdbInfo = kitsuToImdbMappping[kitsuId] || {
      kitsu_id: kitsuId,
      imdb_id: imdbId,
      fromSeason: 1,
      fromEpisode: 1
    };
    
    const imdbMetadata = await retrieveImdbMetadata(imdbId, metadata.type).catch(() => undefined);
    if (imdbMetadata) {
      metadata.imdb_id = imdbId;
      metadata.runtime = metadata.runtime || imdbMetadata.runtime;
      metadata.imdbRating = metadata.imdbRating || imdbMetadata.imdbRating || undefined;
      if (!metadata.genres || !metadata.genres.length) {
        metadata.genres = imdbMetadata.genres?.filter(genre => genre !== 'Animation') || [];
      }
      metadata.videos = await enrichKitsuEpisodes(metadata, imdbInfo, imdbMetadata);
      metadata.links = []
          .concat(metadata.links || [])
          .concat(metadata.imdbRating ? [] : getImdbLink(imdbMetadata))
          .concat(metadata.genres?.length ? [] : getCinemetaGenres(imdbMetadata));
    }
    
    // Fallback to Metahub images if still missing
    if (imdbId) {
      if (!metadata.logo) {
        metadata.logo = `https://images.metahub.space/logo/medium/${imdbId}/img`;
      }
      if (!metadata.background) {
        metadata.background = `https://images.metahub.space/background/medium/${imdbId}/img`;
      }
      if (!metadata.poster) {
        metadata.poster = `https://images.metahub.space/poster/small/${imdbId}/img`;
      }
    }
  }
  
  return sanitize(metadata);
}

async function enrichKitsuEpisodes(metadata, imdbInfo, imdbMetadata) {
  if (!metadata.videos || !metadata.videos.length) {
    return metadata.videos;
  }
  const startSeason = Number.isInteger(imdbInfo.fromSeason) ? imdbInfo.fromSeason : 1;
  const startEpisode = Number.isInteger(imdbInfo.fromEpisode) ? imdbInfo.fromEpisode : 1;
  const otherImdbEntries = imdbToKitsuMapping[imdbInfo.imdb_id]
      .filter((entry) => entry.kitsu_id !== metadata.kitsu_id
          && entry.fromSeason >= startSeason
          && entry.fromEpisode >= startEpisode);
  const nextImdbEntry = otherImdbEntries && otherImdbEntries[0];
  const perSeasonEpisodeCount = imdbMetadata && imdbMetadata.videos && imdbMetadata.videos
      .filter((video) => video.episode = Number.isInteger(video.episode) ? video.episode : video.number)
      .filter((video) => (video.season === startSeason && video.episode >= startEpisode) || (video.season > startSeason
          && (!nextImdbEntry || nextImdbEntry.fromSeason > video.season)))
      .reduce(
          (counts, next) => (counts[next.season - startSeason] = counts[next.season - startSeason] + 1 || 1, counts),
          []);
  const videosMap = perSeasonEpisodeCount && imdbMetadata.videos.reduce((map, next) => (map[next.id] = next, map), {})
  let skippedEpisodes = 0;

  if (perSeasonEpisodeCount && perSeasonEpisodeCount.length) {
    let lastReleased;
    return metadata.videos
        .map(video => {
          if (imdbInfo.nonImdbEpisodes && imdbInfo.nonImdbEpisodes.includes(video.episode)) {
            skippedEpisodes++
            return video
          }
          const seasonIndex = ([...perSeasonEpisodeCount.keys()]
              .find((i) => perSeasonEpisodeCount.slice(0, i + 1)
                  .reduce((a, b) => a + b, 0) >= video.episode - skippedEpisodes) + 1 || perSeasonEpisodeCount.length) - 1;
          const previousSeasonsEpisodeCount = perSeasonEpisodeCount.slice(0, seasonIndex).reduce((a, b) => a + b, 0);
          const season = startSeason + seasonIndex;
          const episode = startEpisode - 1 + video.episode - skippedEpisodes - previousSeasonsEpisodeCount;
          const imdbVideo = videosMap[`${imdbInfo.imdb_id}:${season}:${episode}`];
          const title = video.title.match(/Episode \d+/) && (imdbVideo?.title || imdbVideo?.name) || video.title;
          const thumbnail = video.thumbnail || imdbVideo?.thumbnail;
          const overview = video.overview || imdbVideo?.overview;
          const released = new Date(imdbVideo?.released || video.released.getTime());
          lastReleased = lastReleased?.getTime() > released.getTime() ? lastReleased : released;
          return {
            ...video,
            title,
            thumbnail,
            overview,
            released: lastReleased,
            imdb_id: imdbInfo.imdb_id,
            imdbSeason: season,
            imdbEpisode: episode
          }
        });
  }

  return metadata.videos
      .map((video) => ({
        ...video,
        imdb_id: imdbInfo.imdb_id,
        imdbSeason: startSeason,
        imdbEpisode: startEpisode - 1 + video.episode // startEpisode is inclusive, so need -1
      }));
}

async function enrichImdbMetadata(metadata, retrieveKitsuMetadata) {
  const kitsuEntries = imdbToKitsuMapping[metadata.id];
  if (kitsuEntries && kitsuEntries.length) {
    const kitsuIds = kitsuEntries
        .filter((entry) => Number.isNaN(entry.fromSeason) || entry.fromSeason > 0)
        .map((entry) => entry.kitsu_id)
    return sanitize({
      ...metadata,
      imdb_id: metadata.id,
      kitsu_id: kitsuIds.length === 1 ? kitsuIds[0] : kitsuIds,
      videos: await enrichImdbEpisodes(metadata, kitsuEntries, retrieveKitsuMetadata)
    });
  }
  return metadata;
}

async function enrichImdbEpisodes(metadata, kitsuEntries, retrieveKitsuMetadata) {
  if (metadata.type === 'movie') {
    return metadata.videos;
  }
  if (metadata.type === undefined || !metadata.videos || !metadata.videos.length) {
    return Promise.all(kitsuEntries.map((kitsuEntry) => retrieveKitsuMetadata(kitsuEntry.kitsu_id)
        .then((kitsuMetadata) => (kitsuMetadata.videos || [])
            .map((video) => ({
              title: video.title,
              season: kitsuEntry.fromSeason,
              episode: kitsuEntry.fromEpisode + video.episode - 1,
              kitsu_id: kitsuEntry.kitsu_id,
              kitsuEpisode: video.episode
            })))))
        .then((videos) => videos.reduce((a, b) => a.concat(b), []));
  }
  const episode = video => video.episode || video.number;
  const episodeCounter = kitsuEntries.reduce((counter, next) => (counter[next.kitsu_id] = 1, counter), {});
  return metadata.videos
      .sort((a, b) => a.season - b.season || episode(a) - episode(b))
      .map((video) => {
        const kitsuEntry = kitsuEntries.slice().reverse()
            .find((entry) => entry.fromSeason <= video.season && entry.fromEpisode <=  episode(video));
        if (!kitsuEntry) {
          return video
        }
        let kitsuEpisode = episodeCounter[kitsuEntry.kitsu_id]++
        while (kitsuEntry.nonImdbEpisodes && kitsuEntry.nonImdbEpisodes.includes(kitsuEpisode)) {
          kitsuEpisode = episodeCounter[kitsuEntry.kitsu_id]++
        }
        return {
          ...video,
          kitsu_id: kitsuEntry.kitsu_id,
          kitsuEpisode: kitsuEpisode
        };
      })
}

function getImdbLink(metadata) {
  return (metadata?.links || []).filter(link => link.category === 'imdb');
}

function getCinemetaGenres(metadata) {
  return (metadata?.links || [])
      .filter(link => link.category === 'Genres' && link.name !== 'Animation')
      .map(link => ({
        ...link,
        url: getGenreUrl(link.name)
      }));
}

function sanitize(obj) {
  Object.keys(obj).forEach((key) => (obj[key] == null) && delete obj[key]);
  return obj;
}

module.exports = { enrichKitsuMetadata, enrichImdbMetadata, hasImdbMapping, getImdbMapping };
