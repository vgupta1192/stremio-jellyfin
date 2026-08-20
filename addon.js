// noinspection JSPotentiallyInvalidConstructorUsage

import Promise from "es6-promise"
import {addonBuilder} from "stremio-addon-sdk"
import {JellyfinApi, server} from "./jellyfin.js";
import {manifest} from "./manifest.js";
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

let builder = new addonBuilder(manifest)

function itemToMeta(item) {
    return {
        id: item.ProviderIds.Imdb,
        type: item.Type.toLowerCase(),
        name: item.Name,
        poster: `${publicServer}/Items/${item.Id}/Images/Primary`
    }
}

builder.defineCatalogHandler(async ({type, id, extra}) => {
    console.log("request for catalogs: " + type + " " + id)
    return Promise.resolve({
        metas: await Promise.all(await jellyfin.searchItems(extra.skip || 0, type === 'movie', extra.search))
            .then(it => it.map(e => e.data))
            // Jellyfin's hasImdb=true query param is not reliably enforced by the
            // server (confirmed: items with no ProviderIds still come back), so
            // filter client-side too. Every Stremio catalog meta object requires
            // a non-empty `id` per spec; some third-party clients (e.g. Nuvio)
            // reject the whole catalog response if any entry is missing one,
            // whereas Stremio's own client silently tolerates it.
            .then(items => items.filter(item => item.ProviderIds && item.ProviderIds.Imdb))
            .then(items => items.map(itemToMeta))
    })
})

builder.defineMetaHandler(async ({type, id}) => {
    console.log("request for meta: " + type + " " + id)
    const items = await jellyfin.getItemByImdbId(id)
    if (items === undefined || items.length === 0)
        return Promise.resolve({meta: null})
    return Promise.resolve({meta: itemToMeta(items[0])})
})

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
    return `${publicServer}/videos/${itemId}/stream.mkv?static=true&api_key=${jellyfin.auth.AccessToken}&mediaSourceId=${item.MediaSources[0].Id}`
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
        const items = await jellyfin.getItemByImdbId(imdbId)
        return (items && items.length > 0) ? items[0] : null
    }

    const seriesItem = (await jellyfin.getItemByImdbId(imdbId))[0]
    if (seriesItem === undefined) return null
    const seasonItem = (await jellyfin.getSeasonByParentItemIdAndSeasonNumber(seriesItem.Id, Number(season))).Items.find(it => it.IndexNumber === Number(season))
    if (seasonItem === undefined) return null
    const episodeItem = (await jellyfin.getEpisodeByItemIdAndSeasonId(seriesItem.Id, seasonItem.Id)).Items.find(it => it.IndexNumber === Number(episode))
    if (episodeItem === undefined) return null
    return await jellyfin.getItemById(episodeItem.Id).then(it => it.data)
}

export {jellyfin}

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

        const seriesItem = (await jellyfin.getItemByImdbId(seriesId))[0]
        if (seriesItem === undefined) {
            const requestStream = buildRequestStream(type, seriesImdbId, seasonNum, episodeNum)
            return Promise.resolve({streams: requestStream ? [requestStream] : []})
        }
        const seasonItem = (await jellyfin.getSeasonByParentItemIdAndSeasonNumber(seriesItem.Id, seasonNum)).Items.find(it => it.IndexNumber === seasonNum)
        if (seasonItem === undefined) {
            const requestStream = buildRequestStream(type, seriesImdbId, seasonNum, episodeNum)
            return Promise.resolve({streams: requestStream ? [requestStream] : []})
        }
        const episodeItem = (await jellyfin.getEpisodeByItemIdAndSeasonId(seriesItem.Id, seasonItem.Id)).Items.find(it => it.IndexNumber === episodeNum)
        if (episodeItem === undefined) {
            const requestStream = buildRequestStream(type, seriesImdbId, seasonNum, episodeNum)
            return Promise.resolve({streams: requestStream ? [requestStream] : []})
        }
        const actualEpisodeItem = await jellyfin.getItemById(episodeItem.Id).then(it => it.data)

        items = [actualEpisodeItem]

    } else
        items = await jellyfin.getItemByImdbId(id)

    if (items === undefined || items.length === 0) {
        const requestStream = buildRequestStream(type, seriesImdbId || id, seasonNum, episodeNum)
        return Promise.resolve({streams: requestStream ? [requestStream] : []})
    }

    const item = items[0]
    const itemId = stringToUuid(item.Id)

    if (!(itemId === undefined)) {
        const stream = {
            url: `${publicServer}/videos/${itemId}/stream.mkv?static=true&api_key=${jellyfin.auth.AccessToken}&mediaSourceId=${item.MediaSources[0].Id}`,
            name: 'Jellyfin',
            description: item.MediaSources[0].MediaStreams[0].DisplayTitle
        }
        return Promise.resolve({streams: [stream]})
    }

    console.log(`Cant find stream for: ${id}`)
    const requestStream = buildRequestStream(type, seriesImdbId || id, seasonNum, episodeNum)
    return Promise.resolve({streams: requestStream ? [requestStream] : []})
})

export const addonInterface = builder.getInterface()
