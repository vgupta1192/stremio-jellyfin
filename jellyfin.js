import axios from "axios"
import os from "os"

export const server = process.env.JELLYFIN_SERVER
const user = process.env.JELLYFIN_USER
const password = process.env.JELLYFIN_PASSWORD
const device = os.hostname()
const itemsLimit = 20

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

    async searchItems(skip, movie, searchTerm = null) {
        let firstItem = (Number(skip) || 0) + 1
        let itemsSearch = `${server}/Items?userId=${this.auth.User.Id}&hasImdb=true&Recursive=true&IncludeItemTypes=Movie,Series&startIndex=${firstItem}&limit=${itemsLimit}&sortBy=SortName`
        if (searchTerm) {
            itemsSearch += `&searchTerm=${searchTerm}`
        }

        if (movie) {
            itemsSearch += `&IncludeItemTypes=Movie`
        } else
            itemsSearch += `&IncludeItemTypes=Series`

        return this.authenticatedGet(itemsSearch)
            .then(it => it.data.Items.map(it => this.getItemById(it.Id)))
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
