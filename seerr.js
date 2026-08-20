import axios from "axios"

// Seerr is the unified successor to Jellyseerr/Overseerr (the two projects
// merged and were both deprecated in favor of Seerr, announced Feb 2026,
// sunset end of May 2026 - see https://docs.seerr.dev/blog/seerr-release/).
// Seerr's request API is a continuation of the same codebase/contract that
// Overseerr and Jellyseerr have used for years:
//   - Auth: `X-Api-Key` header (Settings -> General -> API Key in Seerr's UI)
//   - POST /api/v1/request  { mediaType: "movie"|"tv", mediaId: <tmdbId>, seasons?: number[] | "all" }
//
// IMDB id -> TMDb id resolution does NOT go through Seerr's own /api/v1/search
// (that's a plain title-text search against TMDb's /search/multi, confirmed
// by reading Seerr's own source - server/routes/search.ts / server/api/
// themoviedb/index.ts - it does not accept or match on external ids at all).
// Seerr's backend has an internal getMediaByImdbId()/getByExternalId() helper
// that wraps TMDb's real "find by external id" endpoint
// (GET https://api.themoviedb.org/3/find/{imdbId}?external_source=imdb_id),
// but that helper isn't exposed as its own public Seerr route - so this calls
// TMDb's /find endpoint directly instead. The API key below
// (431a8708161bcd1f1fbe7536137e61ed) is TMDb's own public "read" key that
// Overseerr/Jellyseerr/Seerr ship hardcoded in their own open-source
// repository (server/api/themoviedb/index.ts) - it's not a secret credential
// tied to this deployment, and using it here avoids requiring a separate
// TMDb account/key just for this one lookup.

const seerrUrl = (process.env.SEERR_URL || "").replace(/\/+$/, "")
const seerrApiKey = process.env.SEERR_API_KEY
const tmdbApiKey = process.env.TMDB_API_KEY || "431a8708161bcd1f1fbe7536137e61ed"

export class SeerrApi {
    constructor() {
        this.enabled = Boolean(seerrUrl && seerrApiKey)
        if (!this.enabled) {
            console.warn(
                "SEERR_URL / SEERR_API_KEY not configured - 'Request via Seerr' streams will be disabled."
            )
            return
        }
        this.client = axios.create({
            baseURL: seerrUrl,
            headers: {
                "X-Api-Key": seerrApiKey,
                "Content-Type": "application/json"
            },
            timeout: 15000
        })
        this.tmdb = axios.create({
            baseURL: "https://api.themoviedb.org/3",
            params: { api_key: tmdbApiKey },
            timeout: 15000
        })
    }

    // Resolves an IMDB id (e.g. "tt1234567") + Stremio type ("movie"/"series")
    // to a TMDb id, via TMDb's own /find endpoint - the correct, exact
    // external-id lookup (as opposed to Seerr's /search, which is text-only
    // and won't reliably match a raw IMDB id string).
    async findByImdbId(imdbId, stremioType) {
        if (!this.enabled) return null
        const mediaType = stremioType === "series" ? "tv" : "movie"

        const { data } = await this.tmdb.get(`/find/${imdbId}`, {
            params: { external_source: "imdb_id" }
        })

        const movieResult = data?.movie_results?.[0]
        const tvResult = data?.tv_results?.[0]

        if (mediaType === "movie" && movieResult) {
            return { tmdbId: movieResult.id, mediaType: "movie" }
        }
        if (mediaType === "tv" && tvResult) {
            return { tmdbId: tvResult.id, mediaType: "tv" }
        }
        // Fall back to whichever type TMDb actually matched, in case Stremio's
        // type classification (movie vs series) disagrees with TMDb's - better
        // to request the right title under the "wrong" type than fail outright.
        if (movieResult) return { tmdbId: movieResult.id, mediaType: "movie" }
        if (tvResult) return { tmdbId: tvResult.id, mediaType: "tv" }

        return null
    }

    // Submits a request to Seerr. For TV, requests all seasons by default
    // since Stremio's per-episode granularity doesn't map cleanly onto a
    // one-click "request this show" action.
    async requestMedia(tmdbId, mediaType) {
        if (!this.enabled) throw new Error("Seerr is not configured")
        const body = { mediaType, mediaId: tmdbId }
        if (mediaType === "tv") body.seasons = "all"

        const { data } = await this.client.post("/api/v1/request", body)
        return data
    }
}

export const seerr = new SeerrApi()
