import path from "path"
import { fileURLToPath } from "url"
import express from "express"
import stremio from "stremio-addon-sdk"
import {interfacesBySlug, buildJellyfinStreamUrl, resolveJellyfinItem, isRequestableItemId} from "./addon.js"
import {ALL_CONFIGS, configToSlug} from "./manifest.js"
import {seerr} from "./seerr.js"

// We build our own Express app (instead of using serveHTTP directly) so we
// can add the /request route below, which serveHTTP has no hook for. This
// mirrors serveHTTP's own implementation (getRouter mounted on an express
// app) - see stremio-addon-sdk/src/serveHTTP.js.
const { getRouter } = stremio

const app = express()

// One genuinely separate installable addon per config (see manifest.js/
// addon.js) - the all-enabled config mounts at the root URL, unchanged
// from before this feature existed, so any existing install keeps working
// exactly as it did. Every other combination of Movies/Series/Adult gets
// its own URL prefix naming exactly which catalogs it includes (e.g.
// /movies-adult), with that catalog left out of its manifest entirely -
// not just hidden client-side.
for (const config of ALL_CONFIGS) {
    const slug = configToSlug(config)
    const iface = interfacesBySlug.get(slug || "")
    if (slug) {
        app.use(`/${slug}`, getRouter(iface))
    } else {
        app.use(getRouter(iface))
    }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PLACEHOLDER_VIDEO_PATH = path.join(__dirname, "assets", "requested-placeholder.mp4")

// DESIGN NOTE - why this endpoint does NOT poll or hold the connection open:
//
// Two earlier designs were tried and both proven broken by real player
// constraints:
//   1. Holding one HTTP connection open for up to 5 minutes while polling
//      Jellyfin internally, responding once ready/timed out. Broken because
//      real player HTTP clients have short idle-read timeouts - confirmed
//      via Nuvio's own source (PlayerPlaybackNetworking.kt): OkHttp
//      connect/read/write timeout = 15 seconds, with ExoPlayer's own
//      retry/backoff policy giving up entirely around 90-100s. A silent
//      connection blows past that on the very first request.
//   2. Responding fast every time via a redirect-loop (302 back to this
//      same endpoint every few seconds until ready). Broken because both
//      major player HTTP stacks cap the number of redirects they'll follow
//      in one logical request: OkHttp hard-caps at 20 follow-ups
//      (RetryAndFollowUpInterceptor.MAX_FOLLOW_UPS), and ffmpeg/mpv's
//      libavformat caps at 8 by default (HTTP_MAX_REDIRECTS_DEFAULT) - a
//      5-minute wait at a few seconds per hop needs 70+ hops, which fails
//      on both far before the timeout is ever reached.
//
// No single HTTP response can both stay open for minutes AND later swap to
// a different real video file - players don't support hot-swapping content
// mid-stream. So instead: this endpoint responds immediately (a fast,
// normal file response), submits the Seerr request, and serves a short
// static placeholder video explaining what's happening. The user reopens
// the title later (once it's downloaded) - at that point `defineStreamHandler`
// in addon.js finds the real Jellyfin item on its normal fast path and
// returns the actual stream, same as any title that was already in the
// library. No auto-transition mid-playback, but nothing hangs or errors.
function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c])
}

function renderErrorPage(title, message) {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #0f1115; color: #eee; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; box-sizing: border-box; }
    .card { max-width: 420px; text-align: center; }
    h1 { font-size: 1.3rem; margin-bottom: 12px; color: #ff6b6b; }
    p { color: #aaa; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`
}

// Simple, self-contained configure page (no build step/framework in this
// app, matching renderErrorPage's approach above): one checkbox per
// catalog (Movies/Series/Adult), and an Install button that computes the
// right config's manifest URL client-side (mirroring configToSlug's own
// rule: all three enabled means the root, un-prefixed URL) and hands it to
// Stremio. Reachable at /configure and every /<slug>/configure (one per
// non-root config - see the mounting loop below) - Stremio's own
// "reconfigure" flow for an already-installed addon opens
// <manifest-base>/configure, so whichever config's prefix the user is
// already on renders here with that combination pre-checked. Since every
// config is a genuinely separate addon (distinct manifest id - see
// manifest.js), changing checkboxes and reinstalling adds/replaces that
// *other* addon rather than converting this one in place - Stremio has no
// concept of changing an installed addon's id.
function renderConfigurePage(config) {
    const {showMovies, showSeries, showAdult} = config
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Configure Jellyfin Addon</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #0f1115; color: #eee; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; box-sizing: border-box; }
    .card { max-width: 420px; width: 100%; text-align: center; }
    h1 { font-size: 1.4rem; margin-bottom: 24px; }
    label { display: flex; align-items: center; gap: 10px; justify-content: center; margin-bottom: 16px; font-size: 1.05rem; cursor: pointer; }
    input[type=checkbox] { width: 20px; height: 20px; cursor: pointer; }
    button { font-size: 1rem; padding: 12px 28px; border-radius: 8px; border: none; background: #7b5bf5; color: #fff; cursor: pointer; margin-top: 12px; }
    button:hover { background: #6a4be0; }
    .manifest-url { margin-top: 20px; font-size: 0.8rem; color: #888; word-break: break-all; }
    .manifest-url a { color: #9b8cf0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Jellyfin Stremio Addon</h1>
    <label><input type="checkbox" id="showMovies" ${showMovies ? "checked" : ""}> Show Movies catalog</label>
    <label><input type="checkbox" id="showSeries" ${showSeries ? "checked" : ""}> Show TV Series catalog</label>
    <label><input type="checkbox" id="showAdult" ${showAdult ? "checked" : ""}> Show Adult catalog</label>
    <button onclick="install()">Install in Stremio</button>
    <div class="manifest-url">Manifest URL: <a id="manifestLink" href="#"></a></div>
  </div>
  <script>
    // Mirrors configToSlug in manifest.js: all three enabled means the
    // root, un-prefixed manifest URL; every other combination gets a
    // prefix naming exactly which catalogs are on.
    function configSlug(movies, series, adult) {
      const enabled = []
      if (movies) enabled.push('movies')
      if (series) enabled.push('series')
      if (adult) enabled.push('adult')
      if (enabled.length === 3) return ''
      return enabled.length > 0 ? enabled.join('-') : 'none'
    }
    function manifestPath() {
      const movies = document.getElementById('showMovies').checked
      const series = document.getElementById('showSeries').checked
      const adult = document.getElementById('showAdult').checked
      const slug = configSlug(movies, series, adult)
      return (slug ? '/' + slug : '') + '/manifest.json'
    }
    function manifestHttpUrl() {
      return window.location.origin + manifestPath()
    }
    function updateLink() {
      const el = document.getElementById('manifestLink')
      el.href = manifestHttpUrl()
      el.textContent = manifestHttpUrl()
    }
    function install() {
      window.location.href = 'stremio://' + window.location.host + manifestPath()
    }
    for (const id of ['showMovies', 'showSeries', 'showAdult']) {
      document.getElementById(id).addEventListener('change', updateLink)
    }
    updateLink()
  </script>
</body>
</html>`
}

for (const config of ALL_CONFIGS) {
    const slug = configToSlug(config)
    app.get(slug ? `/${slug}/configure` : "/configure", (req, res) => {
        res.setHeader("content-type", "text/html; charset=utf-8")
        res.end(renderConfigurePage(config))
    })
}

// This is the URL served as the "Request via Seerr" stream.url itself - NOT
// a webpage the user browses to, but an endpoint a video player opens
// directly, exactly like it would open any other stream URL. See the
// DESIGN NOTE above for why this responds immediately rather than waiting.
app.get("/request/:type/:imdbId/:season?/:episode?", async (req, res) => {
    const { type, imdbId, season, episode } = req.params

    // If the title happens to already be available (e.g. the user is
    // reopening this same title after it finished downloading, and Stremio/
    // Nuvio's addon cache hasn't refreshed yet), skip straight to the real
    // stream instead of submitting a redundant Seerr request and showing
    // the placeholder unnecessarily.
    try {
        const item = await resolveJellyfinItem(type, imdbId, season, episode)
        if (item) {
            const streamUrl = buildJellyfinStreamUrl(item)
            if (streamUrl) {
                return res.redirect(302, streamUrl)
            }
        }
    } catch (err) {
        console.error("request availability check failed:", err?.message || err)
        // fall through - still try to submit the Seerr request below
    }

    if (!seerr.enabled) {
        res.status(503)
        res.setHeader("content-type", "text/html; charset=utf-8")
        return res.end(renderErrorPage(
            "Seerr not configured",
            "This addon's SEERR_URL / SEERR_API_KEY are not set, so requests can't be submitted."
        ))
    }

    // Belt-and-suspenders: defineStreamHandler never offers this URL
    // unless the id is known, catalogued mainstream Jellyfin content (see
    // isRequestableItemId in addon.js) - not Adult content, and not an id
    // from some other addon entirely - but refuse here too in case a
    // client held onto a stale stream URL from before that exclusion
    // took effect.
    if (!isRequestableItemId(imdbId)) {
        res.status(403)
        res.setHeader("content-type", "text/html; charset=utf-8")
        return res.end(renderErrorPage(
            "Not requestable",
            "This title isn't recognized as requestable mainstream Jellyfin content."
        ))
    }

    try {
        const match = await seerr.findByImdbId(imdbId, type)
        if (!match) {
            res.status(404)
            res.setHeader("content-type", "text/html; charset=utf-8")
            return res.end(renderErrorPage(
                "Couldn't find this title on Seerr",
                `No match found for IMDB id ${imdbId}. It may not be indexed on TMDb, or the title metadata differs.`
            ))
        }

        // requestMedia() itself now guards against duplicates (an in-memory
        // recent-request lock plus a live Seerr status check - see
        // seerr.js), so it only throws for genuine failures now, returning
        // normally (with alreadyRequested: true) for both "just requested"
        // and "already requested" cases. Either way, fall through to
        // serving the placeholder below.
        await seerr.requestMedia(match.tmdbId, match.mediaType)
    } catch (err) {
        console.error("Seerr request failed:", err?.response?.data || err?.message || err)
        res.status(502)
        res.setHeader("content-type", "text/html; charset=utf-8")
        return res.end(renderErrorPage(
            "Request failed",
            "Something went wrong submitting this request to Seerr. Check the addon logs for details."
        ))
    }

    // Request submitted (or already was) - respond immediately with the
    // placeholder video. This is a normal, fast, complete file response
    // (not a hanging connection), so it can't trip any player's read
    // timeout. The user reopens this title later, once it's actually
    // downloaded, to get the real stream.
    return res.sendFile(PLACEHOLDER_VIDEO_PATH, (err) => {
        if (err && !res.headersSent) {
            console.error("Failed to send placeholder video:", err?.message || err)
        }
    })
})

const port = process.env.SERVER_PORT || 60421
app.listen(port, () => {
    console.log(`HTTP addon accessible at: http://127.0.0.1:${port}/manifest.json`)
})
