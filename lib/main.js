const PARSE_ITEM = require('./parseItem.js');
const { request } = require('undici');
const UTIL = require('./util.js');

const BASE_SEARCH_URL = 'https://www.youtube.com/results';
const BASE_API_URL = 'https://www.youtube.com/youtubei/v1/search';
const CACHE = new Map([
  // ['apiKey', 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'],
  ['clientVersion', '2.20240606.06.00'],
  ['playlistParams', 'EgIQAw%3D%3D'],
]);

const saveCache = (parsed, opts) => {
  // if (parsed.apiKey) CACHE.set('apiKey', parsed.apiKey);
  // else if (CACHE.has('apiKey')) parsed.apiKey = CACHE.get('apiKey');
  if (parsed.context && parsed.context.client && parsed.context.client.clientVersion) {
    CACHE.set('clientVersion', parsed.context.client.clientVersion);
  } else if (CACHE.has('clientVersion')) {
    parsed.context = UTIL.buildPostContext(CACHE.get('clientVersion'), opts);
  }
  const plParams =
    UTIL.getPlaylistParams(parsed) ||
    (parsed.body ? UTIL.betweenFromRight(parsed.body, `"params":"`, '"}},"tooltip":"Search for Playlist"') : null);
  if (plParams) CACHE.set('playlistParams', plParams);
};

// eslint-disable-next-line complexity
const main = (module.exports = async (searchString, options, rt = 3) => {
  UTIL.checkForUpdates();
  if (rt === 2) {
    // CACHE.delete('apiKey');
    CACHE.delete('clientVersion');
    CACHE.delete('playlistParams');
  }
  if (rt === 0) throw new Error('Unable to find JSON!');
  // Set default values
  const opts = UTIL.checkArgs(searchString, options);

  let parsed = {};
  if (
    !opts.safeSearch ||
    !CACHE.has('clientVersion') ||
    !CACHE.has('playlistParams')
    // || !CACHE.has('apiKey')
  ) {
    const res = await request(BASE_SEARCH_URL, Object.assign({}, opts.requestOptions, { query: opts.query }));
    const body = await res.body.text();
    parsed = UTIL.parseBody(body, opts);
  }
  saveCache(parsed, opts);
  if (opts.type === 'playlist') {
    const params = CACHE.get('playlistParams');
    parsed.json = await UTIL.doPost(
      BASE_API_URL,
      Object.assign({}, opts.requestOptions, {
        query: {
          // key: parsed.apiKey,
          prettyPrint: false,
        },
      }),
      {
        context: parsed.context,
        params,
        query: searchString,
      },
    );
    if (!parsed.json) throw new Error('Cannot searching for Playlist!');
  } else if (opts.safeSearch || !parsed.json) {
    try {
      parsed.json = await UTIL.doPost(
        BASE_API_URL,
        Object.assign({}, opts.requestOptions, {
          query: {
            // key: parsed.apiKey,
            prettyPrint: false,
          },
        }),
        {
          context: parsed.context,
          query: searchString,
        },
      );
    } catch (e) {
      if (rt === 1) throw e;
    }
  }

  if (!parsed.json) return main(searchString, options, rt - 1);

  const resp = { query: opts.search };

  try {
    // Parse items
    const { rawItems, continuation } = UTIL.parseWrapper(
      parsed.json.contents.twoColumnSearchResultsRenderer.primaryContents,
    );

    // Parse items
    resp.items = rawItems
      .map(a => PARSE_ITEM(a, resp))
      .filter(r => r && r.type === opts.type)
      .filter((_, index) => index < opts.limit);

    // Adjust tracker
    opts.limit -= resp.items.length;

    // Get amount of results
    resp.results = Number(parsed.json.estimatedResults) || 0;

    let token = null;
    if (continuation) token = continuation.continuationItemRenderer.continuationEndpoint.continuationCommand.token;

    // We're already on last page or hit the limit
    if (!token || opts.limit < 1) return resp;
    // Recursively fetch more items
    const nestedResp = await parsePage2(
      // parsed.apiKey,
      token,
      parsed.context,
      opts,
    );

    // Merge the responses
    resp.items.push(...nestedResp);
    return resp;
  } catch (e) {
    parsed.query = searchString;
    parsed.requestOptions = opts.requestOptions;
    parsed.error = UTIL.errorToObject(e);
    // UTIL.logger writes a dump file and prints 'Unsupported YouTube Search response'.
    // That is only meaningful for genuine unknown JSON formats.
    // When the response is HTML (any non-JSON content starting with '<'), there is no
    // JSON structure to dump and the 'Unsupported format' message is misleading.
    // We detect this by checking the error originates from JSON.parse on the response body.
    const isHtmlResponse = e instanceof SyntaxError &&
      typeof e.message === 'string' && e.message.startsWith("Unexpected token '<'") &&
      typeof e.stack === 'string' && e.stack.includes('JSON.parse');
    if (isHtmlResponse) {
      // eslint-disable-next-line no-console
      console.error(`[ytsr] YouTube returned HTML instead of JSON for query "${searchString}" - likely rate-limited or network error.`);
    } else {
      UTIL.logger(parsed);
    }
    throw e;
  }
});

const parsePage2 = async (
  // apiKey,
  token,
  context,
  opts,
) => {
  const json = await UTIL.doPost(
    BASE_API_URL,
    Object.assign({}, opts.requestOptions, {
      query: {
        // key: apiKey,
        prettyPrint: false,
      },
    }),
    { context, continuation: token },
  );
  if (!Array.isArray(json.onResponseReceivedCommands)) {
    // No more content
    return [];
  }
  try {
    const { rawItems, continuation } = UTIL.parsePage2Wrapper(
      json.onResponseReceivedCommands[0].appendContinuationItemsAction.continuationItems,
    );
    const parsedItems = rawItems
      .map(PARSE_ITEM)
      .filter(r => r && r.type === opts.type)
      .filter((_, index) => index < opts.limit);

    // Adjust tracker
    opts.limit -= parsedItems.length;

    let nextToken = null;
    if (continuation) nextToken = continuation.continuationItemRenderer.continuationEndpoint.continuationCommand.token;

    // We're already on last page or hit the limit
    if (!nextToken || opts.limit < 1) return parsedItems;

    // Recursively fetch more items
    const nestedResp = await parsePage2(
      // apiKey,
      nextToken,
      context,
      opts,
    );
    parsedItems.push(...nestedResp);
    return parsedItems;
  } catch (e) {
    // UTIL.logger is for unknown JSON formats only. When YouTube returns HTML
    // (rate-limiting, geo-block, CAPTCHA, etc.) JSON.parse throws a SyntaxError
    // with a '<' token - there is no JSON structure worth dumping.
    const isHtmlResponse = e instanceof SyntaxError &&
      typeof e.message === 'string' && e.message.startsWith("Unexpected token '<'") &&
      typeof e.stack === 'string' && e.stack.includes('JSON.parse');
    if (isHtmlResponse) {
      // eslint-disable-next-line no-console
      console.error('[ytsr] YouTube returned HTML instead of JSON on continuation page - likely rate-limited or network error.');
    } else {
      json.error = UTIL.errorToObject(e);
      UTIL.logger(json);
    }
    return [];
  }
};
