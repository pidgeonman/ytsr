const UTIL = require('./util');
const BASE_VIDEO_URL = 'https://www.youtube.com/watch?v=';
const URL = require('url').URL;

module.exports = item => {
  const type = Object.keys(item)[0];
  switch (type) {
    case 'videoRenderer':
      return parseVideo(item[type]);
    case 'playlistRenderer':
      return parsePlaylist(item[type]);
    case 'gridVideoRenderer':
      return parseVideo(item[type]);
    case 'lockupViewModel':
      return parseLockupViewModel(item[type]);
    default:
      return null;
  }
};

const parseVideo = obj => {
  const badges = Array.isArray(obj.badges) ? obj.badges.map(a => a.metadataBadgeRenderer.label) : [];
  const isLive = badges.some(b => ['LIVE NOW', 'LIVE'].includes(b));
  const upcoming = obj.upcomingEventData ? Number(`${obj.upcomingEventData.startTime}000`) : null;
  const lengthFallback = obj.thumbnailOverlays.find(x => Object.keys(x)[0] === 'thumbnailOverlayTimeStatusRenderer');
  const length = obj.lengthText || (lengthFallback && lengthFallback.thumbnailOverlayTimeStatusRenderer.text);

  return {
    type: 'video',
    name: UTIL.parseText(obj.title),
    id: obj.videoId,
    url: BASE_VIDEO_URL + obj.videoId,
    thumbnail: UTIL.prepImg(obj.thumbnail.thumbnails)[0].url,
    thumbnails: UTIL.prepImg(obj.thumbnail.thumbnails),
    isUpcoming: !!upcoming,
    upcoming,
    isLive,
    badges,

    // Author can be null for shows like whBqghP5Oow
    author: _parseAuthor(obj),

    description: UTIL.parseText(obj.descriptionSnippet),

    views: !obj.viewCountText ? null : UTIL.parseIntegerFromText(obj.viewCountText),
    // Duration not provided for live & sometimes with upcoming & sometimes randomly
    duration: UTIL.parseText(length),
    // UploadedAt not provided for live & upcoming & sometimes randomly
    uploadedAt: UTIL.parseText(obj.publishedTimeText),
  };
};

const _parseAuthor = obj => {
  const ctsr = obj.channelThumbnailSupportedRenderers;
  const authorImg = !ctsr ? { thumbnail: { thumbnails: [] } } : ctsr.channelThumbnailWithLinkRenderer;
  const ownerBadgesString = obj.ownerBadges && JSON.stringify(obj.ownerBadges);
  const isOfficial = !!(ownerBadgesString && ownerBadgesString.includes('OFFICIAL'));
  const isVerified = !!(ownerBadgesString && ownerBadgesString.includes('VERIFIED'));
  const author = obj.ownerText && obj.ownerText.runs[0];
  if (!author || !author.navigationEndpoint) return null;

  // Safely read browseEndpoint / commandMetadata as they may be undefined
  const browse = author.navigationEndpoint.browseEndpoint;
  const cmd = author.navigationEndpoint.commandMetadata && author.navigationEndpoint.commandMetadata.webCommandMetadata;
  const authorUrlRaw = (browse && browse.canonicalBaseUrl) || (cmd && cmd.url) || null;
  const channelID = browse && browse.browseId ? browse.browseId : null;
  const url = authorUrlRaw ? new URL(authorUrlRaw, BASE_VIDEO_URL).toString() : null;

  return {
    name: author.text,
    channelID,
    url,
    bestAvatar: UTIL.prepImg(authorImg.thumbnail.thumbnails)[0] || null,
    avatars: UTIL.prepImg(authorImg.thumbnail.thumbnails),
    ownerBadges: Array.isArray(obj.ownerBadges) ? obj.ownerBadges.map(a => a.metadataBadgeRenderer.tooltip) : [],
    verified: isOfficial || isVerified,
  };
};

const parsePlaylist = obj => ({
  type: 'playlist',
  id: obj.playlistId,
  name: UTIL.parseText(obj.title),
  url: `https://www.youtube.com/playlist?list=${obj.playlistId}`,

  owner: _parseOwner(obj),

  publishedAt: UTIL.parseText(obj.publishedTimeText),
  length: Number(obj.videoCount),
});

const _parseOwner = obj => {
  // Auto generated playlists (starting with OL) only provide a simple string
  // Eg: https://www.youtube.com/playlist?list=OLAK5uy_nCItxg-iVIgQUZnPViEyd8xTeRAIr0y5I

  if (obj.shortBylineText.simpleText) return null;
  // Or return { name: obj.shortBylineText.simpleText };

  const owner =
    (obj.shortBylineText && obj.shortBylineText.runs[0]) || (obj.longBylineText && obj.longBylineText.runs[0]);

  if (!owner.navigationEndpoint) return null;
  // Or return { name: owner.text };

  const ownerBrowse = owner.navigationEndpoint.browseEndpoint;
  const ownerCmd = owner.navigationEndpoint.commandMetadata && owner.navigationEndpoint.commandMetadata.webCommandMetadata;
  const ownerUrlRaw = (ownerBrowse && ownerBrowse.canonicalBaseUrl) || (ownerCmd && ownerCmd.url) || null;
  const ownerBadgesString = obj.ownerBadges && JSON.stringify(obj.ownerBadges);
  const isOfficial = !!(ownerBadgesString && ownerBadgesString.includes('OFFICIAL'));
  const isVerified = !!(ownerBadgesString && ownerBadgesString.includes('VERIFIED'));
  const fallbackURL = ownerCmd && ownerCmd.url;
  const channelID = ownerBrowse && ownerBrowse.browseId ? ownerBrowse.browseId : null;
  const url = ownerUrlRaw || fallbackURL ? new URL(ownerUrlRaw || fallbackURL, BASE_VIDEO_URL).toString() : null;

  return {
    name: owner.text,
    channelID,
    url,
    ownerBadges: Array.isArray(obj.ownerBadges) ? obj.ownerBadges.map(a => a.metadataBadgeRenderer.tooltip) : [],
    verified: isOfficial || isVerified,
  };
};

// YouTube is migrating from videoRenderer/playlistRenderer to lockupViewModel.
// Handle both LOCKUP_CONTENT_TYPE_VIDEO and LOCKUP_CONTENT_TYPE_PLAYLIST.
const parseLockupViewModel = obj => {
  const contentType = obj.contentType || '';
  const contentId = obj.contentId;
  if (!contentId) return null;

  const meta = obj.metadata && obj.metadata.lockupMetadataViewModel;
  const title = (meta && meta.title && meta.title.content) || null;
  const rows = (meta && meta.metadata && meta.metadata.contentMetadataViewModel &&
    meta.metadata.contentMetadataViewModel.metadataRows) || [];

  if (contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
    // Thumbnail sources
    const thumbSources = (obj.contentImage && obj.contentImage.thumbnailViewModel &&
      obj.contentImage.thumbnailViewModel.image &&
      obj.contentImage.thumbnailViewModel.image.sources) || [];
    const thumbnail = thumbSources.length > 0 ? thumbSources[thumbSources.length - 1].url : null;

    // Duration from overlay badges (format: "5:33")
    let duration = null;
    const overlays = (obj.contentImage && obj.contentImage.thumbnailViewModel &&
      obj.contentImage.thumbnailViewModel.overlays) || [];
    for (const overlay of overlays) {
      const badges = overlay.thumbnailOverlayBadgeViewModel &&
        overlay.thumbnailOverlayBadgeViewModel.thumbnailBadges;
      if (Array.isArray(badges)) {
        for (const b of badges) {
          const text = b.thumbnailBadgeViewModel && b.thumbnailBadgeViewModel.text;
          if (text && /^\d+:\d+/.test(text)) { duration = text; break; }
        }
      }
      if (duration) break;
    }

    // Views, uploadedAt, and author from metadataRows
    let views = null;
    let uploadedAt = null;
    let author = null;
    for (const row of rows) {
      for (const part of (row.metadataParts || [])) {
        const text = part.text && part.text.content;
        if (!text) continue;
        if (/views/i.test(text)) {
          views = UTIL.parseIntegerFromText({ simpleText: text });
        } else if (/ago$/.test(text)) {
          uploadedAt = text;
        }
        // Author: part with commandRuns is a channel link
        if (!author && part.text && Array.isArray(part.text.commandRuns) &&
            part.text.commandRuns.length > 0) {
          author = {
            name: text, channelID: null, url: null,
            bestAvatar: null, avatars: [], ownerBadges: [], verified: false,
          };
        }
      }
    }

    return {
      type: 'video',
      name: title,
      id: contentId,
      url: BASE_VIDEO_URL + contentId,
      thumbnail,
      thumbnails: thumbSources.map(s => ({ url: s.url, width: s.width, height: s.height })),
      isUpcoming: false,
      upcoming: null,
      isLive: false,
      badges: [],
      author,
      description: null,
      views,
      duration,
      uploadedAt,
    };
  }

  if (contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST') {
    // Thumbnail from collectionThumbnailViewModel
    const primaryThumb = obj.contentImage && obj.contentImage.collectionThumbnailViewModel &&
      obj.contentImage.collectionThumbnailViewModel.primaryThumbnail &&
      obj.contentImage.collectionThumbnailViewModel.primaryThumbnail.thumbnailViewModel;
    const thumbSources = (primaryThumb && primaryThumb.image && primaryThumb.image.sources) || [];

    // Video count from overlay badge text ("158 videos")
    let videoCount = 0;
    const overlays = (primaryThumb && primaryThumb.overlays) || [];
    for (const overlay of overlays) {
      const badges = overlay.thumbnailOverlayBadgeViewModel &&
        overlay.thumbnailOverlayBadgeViewModel.thumbnailBadges;
      if (Array.isArray(badges)) {
        for (const b of badges) {
          const text = b.thumbnailBadgeViewModel && b.thumbnailBadgeViewModel.text;
          if (text) {
            const m = text.match(/(\d[\d,]*)\s*video/i);
            if (m) videoCount = parseInt(m[1].replace(/,/g, ''), 10);
          }
        }
      }
    }

    // Owner from first metadataRow part with commandRuns
    let owner = null;
    for (const row of rows) {
      for (const part of (row.metadataParts || [])) {
        if (part.text && Array.isArray(part.text.commandRuns) && part.text.commandRuns.length > 0) {
          owner = { name: part.text.content, channelID: null, url: null, ownerBadges: [], verified: false };
          break;
        }
      }
      if (owner) break;
    }

    return {
      type: 'playlist',
      id: contentId,
      name: title,
      url: `https://www.youtube.com/playlist?list=${contentId}`,
      owner,
      publishedAt: null,
      length: videoCount,
    };
  }

  return null;
};
