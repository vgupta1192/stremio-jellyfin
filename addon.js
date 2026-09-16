// noinspection JSPotentiallyInvalidConstructorUsage

import fs from "fs"
import path from "path"
import Promise from "es6-promise"
import {addonBuilder} from "stremio-addon-sdk"
import {JellyfinApi, server, moviesLibraryId, showsLibraryId, adultLibraryId} from "./jellyfin.js";
import {createManifest, configToSlug, ALL_CONFIGS} from "./manifest.js";
import {seerr} from "./seerr.js";

// Client-facing URLs (poster images, stream links) must use the publicly
// reachable Jellyfin address, since they're opened by the Stremio client,
// not by this addon's own server. Falls back to the internal server value
// if no public address is configured.
const publicServer = process.env.PUBLIC_JELLYFIN_SERVER || server

// Public URL of THIS addon's own server, used to build the "Request via
// Seerr" stream URL (the /request route, which the player opens directly
// like any other stream). Must be reachable by whatever device opens the
// Stremio/Nuvio client (same reasoning as publicServer above) - falls back
// to the internal SERVER_PORT-based localhost URL for local dev.
const publicSelfUrl = (process.env.PUBLIC_ADDON_URL || `http://127.0.0.1:${process.env.SERVER_PORT || 60421}`).replace(/\/+$/, "")

const jellyfin = new JellyfinApi()
await jellyfin.authenticate()

function stringToUuid(plainStringUuid) {
    return plainStringUuid.replace(
        /(.{8})(.{4})(.{4})(.{4})(.{12})/g,
        "$1-$2-$3-$4-$5"
    )
}

// Tracks which items have already had a background image refresh
// triggered this process lifetime, so a catalog page rendered repeatedly
// (every poll/scroll) doesn't re-request one every single time - one
// attempt per item per restart is enough to either pick up a fix or
// confirm there's nothing to extract.
const imageRefreshTriggered = new Set()

// Stremio's stream/meta requests carry only a content id, never which
// catalog the user found it through - so there's no direct way for
// defineStreamHandler below to know "this id is Adult content" when
// deciding whether to offer a Request-via-Seerr fallback. Populated by the
// catalog handler every time the Adult catalog is listed. Shared across
// every config/interface (see buildInterface) since it's a fact about the
// id itself, not about which addon variant is asking.
//
// Persisted to disk (confirmed live, 2026-09-16): this used to be
// in-memory only, on the assumption that the Adult catalog would always
// get listed again before a user could click into a title from it within
// the same process lifetime. That assumption broke on every restart of
// this addon (log rotation, deploys, etc. all restart it periodically) -
// a title already known to be Adult from a browse *before* the restart
// lost that protection the moment the process restarted, since the Set
// came back empty and Stremio doesn't necessarily re-list the catalog
// before reopening a title it already has cached client-side. Loading/
// saving this same Set to a small JSON file means the exclusion survives
// restarts, not just the current process's uptime.
const ADULT_ITEM_IDS_FILE = path.join(process.cwd(), "data", "adult-item-ids.json")
const adultItemIds = new Set(loadAdultItemIds())

function loadAdultItemIds() {
    try {
        return JSON.parse(fs.readFileSync(ADULT_ITEM_IDS_FILE, "utf8"))
    } catch {
        return []
    }
}

function saveAdultItemIds() {
    try {
        fs.mkdirSync(path.dirname(ADULT_ITEM_IDS_FILE), {recursive: true})
        fs.writeFileSync(ADULT_ITEM_IDS_FILE, JSON.stringify([...adultItemIds]))
    } catch (err) {
        console.error("Failed to persist adultItemIds:", err?.message || err)
    }
}

// "jf<itemId>" fallback for items TheMovieDb couldn't confidently match to
// an IMDb id (common for adult content and obscure/mistitled files) - see
// getItemByAnyId in jellyfin.js for the corresponding lookup. No colon in
// either form, so it never collides with the "seriesId:season:episode"
// shape defineStreamHandler splits on below.
function itemToMeta(item) {
    const hasPoster = !!item.ImageTags?.Primary
    // Omitting `poster` entirely (rather than pointing at an Images/Primary
    // URL that 404s) lets Stremio's own UI fall back to its normal
    // no-poster placeholder instead of a broken black box - confirmed live
    // this was rendering as pitch black for items with no Primary image.
    // Kick off a one-time background refresh so Jellyfin's own image
    // fetchers (including a screen-grab from the video as a last resort)
    // get a chance to backfill a real poster for any future item this
    // happens to - see refreshItemImages in jellyfin.js.
    if (!hasPoster && !imageRefreshTriggered.has(item.Id)) {
        imageRefreshTriggered.add(item.Id)
        jellyfin.refreshItemImages(item.Id)
    }
    return {
        id: item.ProviderIds?.Imdb || `jf${item.Id}`,
        type: item.Type.toLowerCase(),
        name: item.Name,
        ...(hasPoster ? {poster: `${publicServer}/Items/${item.Id}/Images/Primary`} : {})
    }
}

// For series, adds the "videos" (episode) list Stremio's UI needs to show
// a season/episode picker instead of a bare "Play" button. A real IMDb-id
// series gets this for free from Cinemeta (or another metadata addon that
// recognizes "tt..." ids) merging its own richer response in - but nothing
// else on earth recognizes our own "jf<itemId>" fallback ids, so for those
// this addon is the *only* possible source of an episode list. Without it,
// confirmed live: Stremio falls back to treating the whole series as one
// single playable item, exactly like a movie.
//
// Built from getCanonicalEpisodeList so the video ids handed to the client
// use the exact same season/episode numbering resolveEpisode expects back
// in defineStreamHandler - they're built from the same source, so they
// can't disagree with each other.
async function buildDetailedMeta(item) {
    const meta = itemToMeta(item)
    if (item.Type !== 'Series') return meta
    const episodes = await jellyfin.getCanonicalEpisodeList(item.Id)
    meta.videos = episodes.map(({seasonNum, episodeNum, item: ep}) => ({
        id: `${meta.id}:${seasonNum}:${episodeNum}`,
        title: ep.Name || `Episode ${episodeNum}`,
        season: seasonNum,
        episode: episodeNum,
        ...(ep.PremiereDate ? {released: ep.PremiereDate} : {})
    }))
    return meta
}

// Scopes each catalog id to its own Jellyfin library, so e.g. the Adult
// library's content (CollectionType=movies, so it scans/matches properly)
// shows up only in its own "Adult" catalog and not also in "Jellyfin
// Movies" - Items?IncludeItemTypes=Movie with no ParentId searches every
// library on the server at once.
const CATALOG_LIBRARY_IDS = {
    'movie:all': moviesLibraryId,
    'series:all': showsLibraryId,
    'movie:adult': adultLibraryId,
}

// Builds the fallback "Request via Seerr" stream entry shown when a title
// isn't in the Jellyfin library yet.
//
// This uses `url` (a real playable-stream URL), NOT `externalUrl`. Per the
// Stremio addon spec, externalUrl always opens outside the app (browser/
// webview) in every client - there is no "open a webpage inside the app"
// stream type, confirmed live in Nuvio (both desktop and mobile) opening an
// externalUrl in the system browser even though the goal was to stay in-app.
//
// The URL below points at server.js's /request route, which submits the
// Seerr request and responds immediately with a short placeholder video
// explaining what's happening - it does NOT hold the connection open or
// redirect-loop waiting for the download, since both of those were tried
// and proven broken by real player timeout/redirect-count limits (see the
// DESIGN NOTE in server.js for the full explanation). The user reopens this
// same title once it's been downloaded and imported into Jellyfin, at which
// point this function is no longer called at all - defineStreamHandler's
// normal fast path below finds the real Jellyfin item and returns it
// directly, same as any other title already in the library.
//
// season/episode are only meaningful (and only appended to the URL) for
// series - movies keep the plain /request/movie/:imdbId shape.
function buildRequestStream(type, imdbId, season, episode) {
    if (!seerr.enabled) return null
    // Never offer to request Adult content through Seerr - it's a
    // mainstream movie/TV request system (backed by Radarr/Sonarr via
    // TMDb), not something that makes sense to point at this library. See
    // adultItemIds above for how this is known without needing the item to
    // still exist in Jellyfin.
    if (adultItemIds.has(imdbId)) return null
    const path = (season !== undefined && episode !== undefined)
        ? `/request/${type}/${imdbId}/${season}/${episode}`
        : `/request/${type}/${imdbId}`
    return {
        name: "Seerr",
        title: "Request via Seerr",
        // Kept short and plain (not a full explanatory sentence) - testing
        // whether Stremio's UI (unlike Nuvio) parses/filters the
        // description looking for filename/quality-like text before
        // deciding whether to render a stream entry at all. See
        // DEPLOYMENT_GUIDE.md 13.2 for the investigation.
        description: "Request via Seerr",
        url: `${publicSelfUrl}${path}`,
        behaviorHints: {
            // Set to true: this URL doesn't serve the actual requested
            // media (it's a short placeholder video explaining the
            // request is pending), so it's not a "web ready" stream of the
            // real content in the spec's sense. Testing whether Stremio's
            // official client (unlike Nuvio) filters stream entries out of
            // the list based on this flag - see DEPLOYMENT_GUIDE.md 13.2
            // for the investigation.
            notWebReady: true
        }
    }
}

// Builds the same Jellyfin stream URL shape used by defineStreamHandler,
// exposed so server.js's polling /request endpoint can build an identical
// redirect URL once a requested title becomes available, without duplicating
// this URL-construction logic in two places.
export function buildJellyfinStreamUrl(item) {
    const itemId = stringToUuid(item.Id)
    if (itemId === undefined) return null
    const mediaSource = item.MediaSources?.[0]
    if (!mediaSource) return null
    return `${publicServer}/videos/${itemId}/stream.mkv?static=true&api_key=${jellyfin.auth.AccessToken}&mediaSourceId=${mediaSource.Id}`
}

// Resolves a movie or specific episode's Jellyfin item, mirroring the same
// lookup logic defineStreamHandler uses below. Exposed so server.js's
// polling /request-status endpoint can check availability using the exact
// same resolution path (series -> season -> episode) rather than duplicating
// it, and so the "specific requested episode" (not just "any episode of the
// season") is what's actually checked, per the product requirement that a
// season-level request should redirect once the ONE episode the user
// clicked on is ready, not merely once the season starts appearing at all.
export async function resolveJellyfinItem(type, imdbId, season, episode) {
    if (season === undefined || episode === undefined) {
        const items = await jellyfin.getItemByAnyId(imdbId)
        return (items && items.length > 0) ? items[0] : null
    }

    const seriesItem = (await jellyfin.getItemByAnyId(imdbId))[0]
    if (seriesItem === undefined) return null
    const episodeItem = await jellyfin.resolveEpisode(seriesItem.Id, Number(season), Number(episode))
    if (episodeItem === undefined) return null
    return await jellyfin.getItemById(episodeItem.Id).then(it => it.data)
}

export {jellyfin}

// Exposed so server.js's /request route (the actual URL a player opens for
// the "Request via Seerr" stream) can also refuse to submit an Adult id,
// in case a client ever holds onto a stale stream URL from before this
// content was correctly excluded at the point streams are built above.
export function isAdultItemId(id) {
    return adultItemIds.has(id)
}

// Builds a complete addon interface for one config (which of Movies/
// Series/Adult are enabled - see manifest.js). Every config shares every
// handler unchanged: the catalog handler is already driven purely by the
// requested catalog `type`/`id` via CATALOG_LIBRARY_IDS, and Stremio only
// ever requests a catalog id that's actually listed in whichever manifest
// it fetched - so a config with a given catalog disabled simply never
// gets asked for it in the first place, with no extra branching needed
// here.
function buildInterface(config) {
    const builder = new addonBuilder(createManifest(config))

    builder.defineCatalogHandler(async ({type, id, extra}) => {
        console.log("request for catalogs: " + type + " " + id)
        const parentId = CATALOG_LIBRARY_IDS[`${type}:${id}`]
        // searchItems() now does its own Imdb filtering internally (on
        // the full, unpaginated list, before slicing to a page - see
        // jellyfin.js) and returns plain item objects directly, not
        // axios responses, so no .data unwrapping or re-filtering is
        // needed here any more.
        const items = await jellyfin.searchItems(extra.skip || 0, type === 'movie', extra.search, parentId)
        const metas = items.map(itemToMeta)
        if (id === 'adult') {
            const sizeBefore = adultItemIds.size
            metas.forEach(m => adultItemIds.add(m.id))
            if (adultItemIds.size !== sizeBefore) saveAdultItemIds()
        }
        return Promise.resolve({metas})
    })

    builder.defineMetaHandler(async ({type, id}) => {
        console.log("request for meta: " + type + " " + id)
        const items = await jellyfin.getItemByAnyId(id)
        if (items === undefined || items.length === 0)
            return Promise.resolve({meta: null})
        return Promise.resolve({meta: await buildDetailedMeta(items[0])})
    })

    builder.defineStreamHandler(async ({type, id}) => {
    console.log("request for streams: " + type + " " + id)
    let items = []
    let seriesImdbId = null
    let seasonNum = undefined
    let episodeNum = undefined
    if (id.includes(":")) {

        // resolve actual episode
        const resolvedId = id.split(":")
        const seriesId = resolvedId[0]
        seriesImdbId = seriesId
        seasonNum = Number(resolvedId[1])
        episodeNum = Number(resolvedId[2])

        const seriesItem = (await jellyfin.getItemByAnyId(seriesId))[0]
        if (seriesItem === undefined) {
            const requestStream = buildRequestStream(type, seriesImdbId, seasonNum, episodeNum)
            return Promise.resolve({streams: requestStream ? [requestStream] : []})
        }
        const episodeItem = await jellyfin.resolveEpisode(seriesItem.Id, seasonNum, episodeNum)
        if (episodeItem === undefined) {
            const requestStream = buildRequestStream(type, seriesImdbId, seasonNum, episodeNum)
            return Promise.resolve({streams: requestStream ? [requestStream] : []})
        }
        const actualEpisodeItem = await jellyfin.getItemById(episodeItem.Id).then(it => it.data)

        items = [actualEpisodeItem]

    } else
        items = await jellyfin.getItemByAnyId(id)

    if (items === undefined || items.length === 0) {
        const requestStream = buildRequestStream(type, seriesImdbId || id, seasonNum, episodeNum)
        return Promise.resolve({streams: requestStream ? [requestStream] : []})
    }

    const item = items[0]
    const itemId = stringToUuid(item.Id)
    // MediaStreams (per-track technical info: resolution/codec/language)
    // can be empty even when MediaSources itself is populated - e.g. a
    // file Jellyfin's ffprobe hasn't finished analyzing, or errored on -
    // confirmed live on real, otherwise-playable files (6 across the
    // Movies/Adult libraries). That's cosmetic only (the stream label),
    // not a reason to treat an actually-playable file as unavailable, so
    // it falls back to the item's own name instead of crashing the whole
    // request - unlike a missing MediaSources entry entirely, which does
    // mean there's no real file to play and correctly falls through to
    // the "not found" / Request-via-Seerr path below.
    const mediaSource = item.MediaSources?.[0]

    if (itemId !== undefined && mediaSource) {
        if (!mediaSource.MediaStreams?.[0]) {
            console.warn(`[stream-fallback] ${item.Name} (${item.Id}): MediaSources present but MediaStreams empty - Jellyfin likely hasn't finished (or failed) probing this file's technical details. Still playable, just using the item's name as the stream label instead of resolution/codec info. Fix at the source by re-running metadata refresh on this item, if the label matters here.`)
        }
        const stream = {
            url: `${publicServer}/videos/${itemId}/stream.mkv?static=true&api_key=${jellyfin.auth.AccessToken}&mediaSourceId=${mediaSource.Id}`,
            name: 'Jellyfin',
            description: mediaSource.MediaStreams?.[0]?.DisplayTitle || item.Name
        }
        return Promise.resolve({streams: [stream]})
    }

    console.log(`Cant find stream for: ${id}`)
    const requestStream = buildRequestStream(type, seriesImdbId || id, seasonNum, episodeNum)
    return Promise.resolve({streams: requestStream ? [requestStream] : []})
    })

    return builder.getInterface()
}

// One interface per config (all 2^3 = 8 combinations of Movies/Series/
// Adult - see manifest.js), each a genuinely separate installable addon
// (distinct manifest id) sharing every handler - see server.js for how
// each is mounted under its own URL prefix (or the root, for the
// everything-enabled default), and the /configure page that lets the user
// pick which one to install. Keyed by slug ("" for the root/all-enabled
// config) so server.js can look up the right interface for each mount
// point without rebuilding it.
export const interfacesBySlug = new Map(
    ALL_CONFIGS.map(config => [configToSlug(config) || "", buildInterface(config)])
)
