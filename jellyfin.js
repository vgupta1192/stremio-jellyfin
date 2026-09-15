import axios from "axios"
import os from "os"

export const server = process.env.JELLYFIN_SERVER
const user = process.env.JELLYFIN_USER
const password = process.env.JELLYFIN_PASSWORD
const device = os.hostname()
const itemsLimit = 20

// Library ItemIds used to scope catalog queries to a specific Jellyfin
// library instead of the whole server - without this, e.g. the Adult
// library's content (once given CollectionType=movies so it scans
// properly) would also show up in the main "Jellyfin Movies" catalog,
// since Items?IncludeItemTypes=Movie with no ParentId searches every
// library at once. Undefined/unset just means "don't scope" (old
// server-wide behavior), so this is safe to leave blank for setups
// without a dedicated Adult library.
export const moviesLibraryId = process.env.JELLYFIN_MOVIES_LIBRARY_ID
export const showsLibraryId = process.env.JELLYFIN_SHOWS_LIBRARY_ID
export const adultLibraryId = process.env.JELLYFIN_ADULT_LIBRARY_ID

export class JellyfinApi {

    async authenticate() {
        console.log(`Connecting to Jellyfin server: ${server} with username: ${user} and password: ${password}`)
        this.auth = await axios.post(`${server}/Users/authenticatebyname`,
            {Username: user, Pw: password}, {
                headers: {
                    'Content-Type': 'application/json',
                    // Jellyfin 12+ (upgraded from 10.11) dropped support for the legacy
                    // X-Emby-Authorization/X-Emby-Token headers entirely; it now requires
                    // the standard Authorization header, still using the MediaBrowser
                    // scheme, for both login and all authenticated requests.
                    'Authorization': `MediaBrowser Client="Jellyfin Stremio Addon", App="Jellyfin Stremio Addon", Device="${device}", DeviceId="${device}", Version="1.0.0.0"`
                }
            }).then(it => it.data)
            .catch(err => {
                if (err?.response) {
                    console.log(`Error caught while Jellyfin authentication, server response: '${err?.response?.status}' and data: '${err?.response?.data || "<empty>" }' (server: '${server}' with username: '${user}' and password: '${password}')`)
                } else {
                    console.log(`Error connecting to Jellyfin (server: '${server}' with username: '${user}' and password: '${password}'). Error message: '${err?.message}'`)
                    // anything else
                }
                console.info("Exiting. Please check your configuration and Jellyfin connection.")
                process.exit()
            })
        console.log(`Successfully connected to Jellyfin server: ${server}. Happy streaming.`)
        this.authorisationHeader = `MediaBrowser Client="Jellyfin Stremio Addon", App="Jellyfin Stremio Addon", Device="${device}", DeviceId="${device}", Version="1.0.0.0", Token="${this.auth.AccessToken}"`
    }

    // Jellyfin session tokens can be invalidated/rotated server-side at any
    // time (server restart, session expiry, etc). Since authenticate() only
    // ever runs once at process startup, every Jellyfin API call goes through
    // this wrapper instead of calling axios.get directly: on a 401, it
    // re-authenticates once (getting a fresh token + authorisationHeader)
    // and retries the exact same request once before giving up. This lets
    // the addon self-heal from a stale token without needing a manual
    // service restart.
    async authenticatedGet(url) {
        try {
            return await axios.get(url, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': this.authorisationHeader
                }
            })
        } catch (err) {
            if (err?.response?.status !== 401) {
                throw err
            }
            console.warn("Jellyfin returned 401 - re-authenticating and retrying once.")
            await this.authenticate()
            return axios.get(url, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': this.authorisationHeader
                }
            })
        }
    }

    async getItemById(itemId) {
        return this.authenticatedGet(`${server}/Users/${this.auth.User.Id}/Items/${itemId}`)
    }

    // Fetches every Movie/Series in one shot (Fields=ProviderIds so
    // itemToMeta in addon.js can tell which items have a matched IMDb id
    // and which need the "jf<itemId>" fallback id - the list endpoint
    // omits ProviderIds entirely unless explicitly requested, unlike the
    // single-item endpoint getItemById used to hit per item), then
    // paginates. No longer filters out items without an IMDb id (it used
    // to, via hasImdb=true - which isn't reliably enforced server-side
    // anyway, confirmed live: identical result counts with and without
    // it): TheMovieDb fails to confidently match a meaningful fraction of
    // real titles (most of Adult's library, some Shows), and those items
    // were previously just invisible in every catalog rather than merely
    // lacking IMDb-based extras. The whole library is small enough
    // (~100-150 items) that fetching it in one request and paginating in
    // memory is simpler and cheaper than the old per-item getItemById()
    // N+1 calls it replaces. parentId scopes the search to one library
    // (its Jellyfin ItemId) - omit it to search the whole server, as
    // before.
    async searchItems(skip, movie, searchTerm = null, parentId = null) {
        let itemsSearch = `${server}/Items?userId=${this.auth.User.Id}&Recursive=true&Fields=ProviderIds,ImageTags&sortBy=SortName&IncludeItemTypes=${movie ? 'Movie' : 'Series'}`
        if (searchTerm) {
            itemsSearch += `&searchTerm=${searchTerm}`
        }
        if (parentId) {
            itemsSearch += `&ParentId=${parentId}`
        }

        return this.authenticatedGet(itemsSearch)
            .then(it => it.data.Items.slice(Number(skip) || 0, (Number(skip) || 0) + itemsLimit))
    }

     getItemByImdbId(imdbId) {
        // Native Jellyfin /Items API has no direct "find by external provider id" filter,
        // so we search with Fields=ProviderIds and match client-side. This replaces the
        // old jellyfin-providersid-search-plugin dependency, which is binary-incompatible
        // with modern Jellyfin server versions (MissingMethodException on ILibraryManager).
        return this.authenticatedGet(`${server}/Items?userId=${this.auth.User.Id}&hasImdb=true&Recursive=true&IncludeItemTypes=Movie,Series&Fields=ProviderIds,MediaSources,ImageTags`)
            .then(res => res.data.Items.filter(it => it.ProviderIds && it.ProviderIds.Imdb === imdbId))
    }

    // Fallback lookup for items with no matched external provider id (TheMovieDb
    // couldn't confidently identify the title - common for adult content and
    // obscure/mistitled files). Returns the same shape as getItemByImdbId (an
    // array, so callers can keep doing items[0] either way) so it's a drop-in
    // alternative, not a special case every caller needs to branch on.
    getItemByJellyfinId(itemId) {
        return this.getItemById(itemId).then(res => [res.data]).catch(() => [])
    }

    // Resolves a catalog item id that may be either a real IMDb id (tt-prefixed)
    // or our own "jf<itemId>" fallback id (see itemToMeta in addon.js) - use this
    // instead of getItemByImdbId anywhere a lookup used to assume every id was
    // an IMDb id.
    getItemByAnyId(id) {
        if (id.startsWith('jf')) {
            return this.getItemByJellyfinId(id.slice(2))
        }
        return this.getItemByImdbId(id)
    }

    // Fire-and-forget: asks Jellyfin to (re)fetch images for an item with
    // no Primary image yet, so its own already-configured image fetchers
    // (embedded cover extraction, TheMovieDb, and - as a last resort -
    // "Screen Grabber", which pulls a frame directly from the video file)
    // get a chance to run. Deliberately not awaited by callers: a poster
    // showing up a request or two later is a fine outcome, and this must
    // never block or fail the catalog/meta response it was triggered from.
    // Silently swallows failures - a corrupted file ffmpeg can't open at
    // all (confirmed live: some real files in this library are, via
    // "moov atom not found") has nothing any of these fetchers can
    // extract from, so this is a best-effort backfill that self-heals the
    // fixable cases and stays a harmless no-op for the unfixable ones.
    refreshItemImages(itemId) {
        axios.post(`${server}/Items/${itemId}/Refresh?metadataRefreshMode=None&imageRefreshMode=FullRefresh&replaceAllImages=false`, null, {
            headers: {'Authorization': this.authorisationHeader}
        }).catch(() => {})
    }

    // Builds one canonical (season, episode) numbering for every episode of
    // a series - the single source of truth both defineMetaHandler (the
    // browsable episode list Stremio's UI needs) and resolveEpisode (given
    // a season+episode, find the Jellyfin item) use, so they can never
    // disagree with each other. Handles two real, confirmed-live messy-
    // library cases beyond a normally-organized show (which just keeps its
    // real season/episode IndexNumbers unchanged):
    //
    // - A season with no IndexNumber ("Season Unknown" - Jellyfin's
    //   catch-all when it can't group episodes, common for a show scanned
    //   without season subfolders past season 1) gets folded into one
    //   synthetic season numbered one past the highest real season number,
    //   with its episodes numbered positionally (sorted by premiere date,
    //   then name). This won't always match the show's real season
    //   breakdown (e.g. seasons 2-4 of a show all lumped into one "season"
    //   here), but keeps every episode browsable and playable instead of
    //   invisible - a deliberate, disclosed trade-off, not a guarantee of
    //   matching official numbering.
    // - If a season has episodes with no IndexNumber at all (e.g. named
    //   after the release group/site instead of the real title, so
    //   Jellyfin's parser had nothing to extract), those also fall back to
    //   positional numbering within that season.
    async getCanonicalEpisodeList(seriesId) {
        const seasons = (await this.authenticatedGet(`${server}/Shows/${seriesId}/Seasons?userId=${this.auth.User.Id}`)).data.Items
        const episodesFor = async (seasonId) =>
            (await this.authenticatedGet(`${server}/Shows/${seriesId}/Episodes?seasonId=${seasonId}&userId=${this.auth.User.Id}`)).data.Items
        const sortEpisodes = (episodes) => [...episodes].sort((a, b) =>
            (a.PremiereDate || '').localeCompare(b.PremiereDate || '') || (a.Name || '').localeCompare(b.Name || '')
        )

        const numberedSeasons = seasons
            .filter(s => s.IndexNumber !== null && s.IndexNumber !== undefined)
            .sort((a, b) => a.IndexNumber - b.IndexNumber)
        const unnumberedSeasons = seasons.filter(s => s.IndexNumber === null || s.IndexNumber === undefined)

        const result = []
        let fallbackNumbered = 0

        for (const season of numberedSeasons) {
            const sorted = sortEpisodes(await episodesFor(season.Id))
            // A real IndexNumber is only trustworthy if it's unique within
            // this season - some messy batch releases (e.g. a "complete
            // series + movies" torrent packaged as one item) give several
            // unrelated files the same stray IndexNumber, which would
            // otherwise collide into the same video id and hide all but one
            // of them. Anything not uniquely numbered falls back to the
            // next free positional slot instead, guaranteed not to clash
            // with any real or already-assigned number in this season.
            const indexCounts = {}
            sorted.forEach(ep => {
                if (ep.IndexNumber !== null && ep.IndexNumber !== undefined) {
                    indexCounts[ep.IndexNumber] = (indexCounts[ep.IndexNumber] || 0) + 1
                }
            })
            const usedNums = new Set()
            let nextPositional = 1
            sorted.forEach(item => {
                const idx = item.IndexNumber
                let episodeNum
                // A real, uniquely-claimed index can still collide with a
                // number an earlier item already took via the positional
                // fallback below (order-dependent - the earlier item might
                // sort first despite having no real index of its own), so
                // usedNums has to be checked here too, not just in the
                // fallback branch.
                if (idx !== null && idx !== undefined && indexCounts[idx] === 1 && !usedNums.has(idx)) {
                    episodeNum = idx
                } else {
                    while (usedNums.has(nextPositional)) nextPositional++
                    episodeNum = nextPositional
                    fallbackNumbered++
                }
                usedNums.add(episodeNum)
                result.push({seasonNum: season.IndexNumber, episodeNum, item})
            })
        }

        if (unnumberedSeasons.length > 0) {
            const syntheticSeasonNum = numberedSeasons.length > 0
                ? numberedSeasons[numberedSeasons.length - 1].IndexNumber + 1
                : 1
            let extra = []
            for (const season of unnumberedSeasons) {
                extra = extra.concat(await episodesFor(season.Id))
            }
            sortEpisodes(extra).forEach((item, i) => {
                result.push({seasonNum: syntheticSeasonNum, episodeNum: i + 1, item})
            })
            console.warn(`[episode-numbering] ${seriesId}: ${unnumberedSeasons.map(s => s.Name).join(', ')} (${extra.length} episodes with no season number) folded into synthetic season ${syntheticSeasonNum}, numbered positionally - won't necessarily match this show's real season breakdown, but every episode stays browsable and playable. Fix at the source by fixing file/folder naming and re-scanning, if the real season split matters here.`)
        }

        if (fallbackNumbered > 0) {
            console.warn(`[episode-numbering] ${seriesId}: ${fallbackNumbered} episode(s) had no usable or unique IndexNumber within their season and were numbered positionally (by premiere date/name) instead - a best-effort guess, not guaranteed to match the real episode order. Fix at the source by fixing file naming and re-scanning, if exact accuracy matters here.`)
        }

        return result
    }

    async resolveEpisode(seriesId, seasonNum, episodeNum) {
        const list = await this.getCanonicalEpisodeList(seriesId)
        const match = list.find(e => e.seasonNum === seasonNum && e.episodeNum === episodeNum)
        return match ? match.item : undefined
    }
}
