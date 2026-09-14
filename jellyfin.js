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

    // Fetches every Movie/Series in one shot (Fields=ProviderIds so the
    // Imdb check below actually has data to look at - the list endpoint
    // omits ProviderIds entirely unless explicitly requested, unlike the
    // single-item endpoint getItemById used to hit per item), filters to
    // only items with a matched IMDb id (hasImdb=true is not reliably
    // enforced server-side - confirmed live: identical result counts with
    // and without it), THEN paginates. Filtering before paginating matters:
    // slicing a fixed-size page of raw Jellyfin items *before* filtering
    // (the previous approach) meant a page landing on a run of unmatched/
    // junk titles in sort order came back almost empty even though plenty
    // of valid items existed later in the list - this is what made the
    // catalog look like it only had 3-4 titles when 77+ actually had IMDb
    // ids. The whole library is small enough (~100-150 items) that fetching
    // it in one request and paginating in memory is simpler and cheaper
    // than the old per-item getItemById() N+1 calls it replaces.
    // parentId scopes the search to one library (its Jellyfin ItemId) -
    // omit it to search the whole server, as before.
    async searchItems(skip, movie, searchTerm = null, parentId = null) {
        let itemsSearch = `${server}/Items?userId=${this.auth.User.Id}&Recursive=true&Fields=ProviderIds&sortBy=SortName&IncludeItemTypes=${movie ? 'Movie' : 'Series'}`
        if (searchTerm) {
            itemsSearch += `&searchTerm=${searchTerm}`
        }
        if (parentId) {
            itemsSearch += `&ParentId=${parentId}`
        }

        return this.authenticatedGet(itemsSearch)
            .then(it => it.data.Items.filter(item => item.ProviderIds && item.ProviderIds.Imdb))
            .then(items => items.slice(Number(skip) || 0, (Number(skip) || 0) + itemsLimit))
    }

     getItemByImdbId(imdbId) {
        // Native Jellyfin /Items API has no direct "find by external provider id" filter,
        // so we search with Fields=ProviderIds and match client-side. This replaces the
        // old jellyfin-providersid-search-plugin dependency, which is binary-incompatible
        // with modern Jellyfin server versions (MissingMethodException on ILibraryManager).
        return this.authenticatedGet(`${server}/Items?userId=${this.auth.User.Id}&hasImdb=true&Recursive=true&IncludeItemTypes=Movie,Series&Fields=ProviderIds,MediaSources`)
            .then(res => res.data.Items.filter(it => it.ProviderIds && it.ProviderIds.Imdb === imdbId))
    }

     getSeasonByParentItemIdAndSeasonNumber(itemId, seasonNumber) {
        return this.authenticatedGet(`${server}/Shows/${itemId}/Seasons?userId=${this.auth.User.Id}`)
            .then(item => item.data)
    }

     getEpisodeByItemIdAndSeasonId(itemId, seasonId) {
        return this.authenticatedGet(`${server}/Shows/${itemId}/Episodes?seasonId=${seasonId}&userId=${this.auth.User.Id}`)
            .then(item => item.data)
    }
}
