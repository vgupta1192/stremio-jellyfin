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
        // Separate, much shorter timeout specifically for the optional
        // "already requested?" pre-check (see #alreadyRequestedOrAvailable
        // below). Live testing showed this endpoint occasionally hangs for
        // the full 15s (Seerr likely busy processing an active download at
        // the time), which pushed /request's total response time past 20s
        // - itself defeating the whole point of responding fast. This is a
        // nice-to-have optimization, not a correctness requirement (the
        // in-memory lock is the primary guard against duplicates), so it's
        // fine for it to fail/skip fast rather than block the request.
        this.precheckClient = axios.create({
            baseURL: seerrUrl,
            headers: { "X-Api-Key": seerrApiKey },
            timeout: 3000
        })
    }

    // In-memory guard against duplicate requests. Seerr's own POST
    // /api/v1/request duplicate check (server/entity/MediaRequest.ts) is a
    // non-atomic SELECT-then-INSERT with no DB unique constraint and no
    // locking - two POSTs close together can both pass the "does a request
    // already exist" check before the first one's row is committed. Live
    // testing confirmed this: two taps of "Request via Seerr" on the same
    // title, 22 seconds apart, both created separate "Requested" entries in
    // Seerr instead of the second one hitting a 409. This Set tracks
    // tmdbId+mediaType combos requested recently by THIS addon process, so
    // a repeat click within REQUEST_LOCK_MS is blocked before ever calling
    // Seerr, regardless of whether Seerr's own dedup would have caught it.
    // Not persisted across restarts (an in-memory Set), but that's fine -
    // it only needs to cover the "user impatiently taps twice" case, not
    // long-term dedup, since Seerr's GET-based pre-check below (checking
    // mediaInfo.status/requests) handles the "already requested a while
    // ago, in a previous process lifetime" case.
    #recentRequests = new Map()
    static REQUEST_LOCK_MS = 30 * 1000

    #isRecentlyRequested(tmdbId, mediaType) {
        const key = `${mediaType}:${tmdbId}`
        const requestedAt = this.#recentRequests.get(key)
        if (requestedAt === undefined) return false
        if (Date.now() - requestedAt > SeerrApi.REQUEST_LOCK_MS) {
            this.#recentRequests.delete(key)
            return false
        }
        return true
    }

    #markRecentlyRequested(tmdbId, mediaType) {
        this.#recentRequests.set(`${mediaType}:${tmdbId}`, Date.now())
    }

    // Checks Seerr's own record of this title's status/requests BEFORE
    // submitting a new one - the reliable way to detect "already requested
    // a while ago", since Seerr's POST-time 409 check is race-prone (see
    // note above) and this addon process may have restarted since the
    // original request (clearing the in-memory guard above).
    async #alreadyRequestedOrAvailable(tmdbId, mediaType) {
        try {
            const endpoint = mediaType === "tv" ? `/api/v1/tv/${tmdbId}` : `/api/v1/movie/${tmdbId}`
            const { data } = await this.precheckClient.get(endpoint)
            const info = data?.mediaInfo
            if (!info) return false
            if (info.status === 5 || info.status === 4) return true // AVAILABLE / PARTIALLY_AVAILABLE
            const requests = info.requests || []
            return requests.some(r => r.status === 1 || r.status === 2) // PENDING / APPROVED
        } catch (err) {
            console.error("Seerr pre-check failed, proceeding to request anyway:", err?.message || err)
            return false
        }
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
    //
    // Guards against duplicates two ways before ever POSTing (see the notes
    // above on why Seerr's own 409 dedup isn't reliable enough alone):
    //   1. In-memory recent-request lock (this addon process, last 30s)
    //   2. A live check of Seerr's own mediaInfo.status/requests
    // Only if both say "not already requested" does this actually POST.
    async requestMedia(tmdbId, mediaType) {
        if (!this.enabled) throw new Error("Seerr is not configured")

        if (this.#isRecentlyRequested(tmdbId, mediaType)) {
            return { alreadyRequested: true }
        }

        if (await this.#alreadyRequestedOrAvailable(tmdbId, mediaType)) {
            this.#markRecentlyRequested(tmdbId, mediaType)
            return { alreadyRequested: true }
        }

        const body = { mediaType, mediaId: tmdbId }
        if (mediaType === "tv") body.seasons = "all"

        try {
            const { data } = await this.client.post("/api/v1/request", body)
            this.#markRecentlyRequested(tmdbId, mediaType)
            return data
        } catch (err) {
            // Still mark it, even on Seerr's own 409 - the race this addon
            // can't fully close is other CLIENTS hitting Seerr directly
            // (its own web UI, another integration), not this addon's own
            // repeat clicks, which the guards above now prevent.
            if (err?.response?.status === 409) {
                this.#markRecentlyRequested(tmdbId, mediaType)
                return { alreadyRequested: true }
            }
            throw err
        }
    }
}

export const seerr = new SeerrApi()
