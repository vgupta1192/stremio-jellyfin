# Deploying stremio-jellyfin on an Ultra.cc Seedbox

This guide documents the full deployment of [vgupta1192/stremio-jellyfin](https://github.com/vgupta1192/stremio-jellyfin) (a fork of [akarazniewicz/stremio-jellyfin](https://github.com/akarazniewicz/stremio-jellyfin)) on a non-root Ultra.cc seedbox account, including every real bug hit along the way and how each was fixed. It also documents a full investigation into using Tailscale and Cloudflare Tunnel to expose the addon, and why the final answer was neither of those.

Final result: the addon runs as a systemd user service, talks to a Jellyfin server also running on the same seedbox, and is reachable at a permanent, free public URL with no path prefix:

```
http://vgupta1192.duckdns.org:5010/manifest.json
```

## 1. Requirements

Before deploying, these were confirmed:

- **A running Jellyfin server.** This addon is a *bridge*, not a standalone streaming source — it requires `JELLYFIN_SERVER`, `JELLYFIN_USER`, `JELLYFIN_PASSWORD` pointing at an existing Jellyfin instance. If you don't have Jellyfin running somewhere already, this addon does nothing on its own.
- **Node.js.** The repo's `package.json` specifies `"node": "^20.x"`, and only two real dependencies: `axios` and `stremio-addon-sdk`. No native modules, no build step.
- Originally, the README also lists a companion Jellyfin plugin (**jellyfin-providersid-search-plugin**) as required. In practice this plugin turned out to be **abandoned and binary-incompatible with modern Jellyfin** (see Section 4) — the final deployment does not use it at all.

## 2. Deployment method: native Node + systemd, not Docker

The repo ships a `Dockerfile` and documents `docker pull ghcr.io/akarazniewicz/stremio-jellyfin` as the install method. This seedbox runs every other addon (Sootio, Comet, StremThru, MediaFusion, etc.) natively via systemd user services instead of Docker, for consistency with the existing watchdog/auto-update/log-rotation tooling. Given this addon has zero native dependencies, native deployment was the obvious choice — no Docker daemon overhead, and it plugs directly into existing monitoring.

```bash
mkdir -p ~/apps
cd ~/apps
git clone https://github.com/vgupta1192/stremio-jellyfin.git
cd stremio-jellyfin

export PATH=/home/<user>/.nvm/versions/node/v24.19.0/bin:$PATH
npm install
```

**Why Node v24, not v20 (the repo's stated target):** see Section 3.

## 3. Bug #1 — WASM out-of-memory crash on Node v20

On first boot under Node v20, the addon crashed immediately:

```
RangeError: WebAssembly.instantiate(): Out of memory: Cannot allocate Wasm memory for new instance
    at lazyllhttp (node:internal/deps/undici/undici:5943:32)
```

This is **not a bug in the addon's code** — it's `undici` (Node's built-in HTTP client, used internally by `axios`/`fetch`) lazily loading a WASM-compiled HTTP parser on first network request. On this seedbox, the account has a hard, non-negotiable `ulimit -v` (virtual memory) ceiling of ~9.5GB, set by the host and unchangeable by a non-root user. Node v20's V8 engine reserves enough virtual address space for WASM guard pages that it exceeds this ceiling even for a trivial allocation. Node v24's V8 does not have this problem — it reserves less virtual address space for WASM instances, a genuine upstream improvement.

This exact issue and fix were already established earlier in this project for a different addon (Sootio), which hit the identical crash.

**Fix:** run the service under Node v24 instead of v20. No code changes needed — this addon has no native modules, so there's no ABI-compatibility concern (unlike Sootio's `better-sqlite3`, which required a specific rebuild).

```ini
# ~/.config/systemd/user/stremio-jellyfin.service
ExecStart=/home/<user>/.nvm/versions/node/v24.19.0/bin/node server.js
```

## 4. Bug #2 — `this.auth.User` is undefined after login

With the service running, catalog browsing initially worked, but every request logged:

```
TypeError: Cannot read properties of undefined (reading 'Id')
    at JellyfinApi.searchItems (jellyfin.js:47:68)
```

Root cause: the Jellyfin server on this box has its **Base URL** set to `/jellyfin` (Dashboard → Networking → Base URL), so the real API root is `http://127.0.0.1:11102/jellyfin`, not `http://127.0.0.1:11102`. Hitting the bare root returns a `302 Found` redirect (`Location: ../jellyfin/web/`) instead of JSON, so `axios.post(...).then(it => it.data)` resolved to `undefined`, and every downstream `.User.Id` access threw.

**Fix:** point `JELLYFIN_SERVER` at the correct base path:

```ini
Environment=JELLYFIN_SERVER=http://127.0.0.1:11102/jellyfin
```

No code change required for this one — confirmed via direct testing that the addon's own URL-building logic already handles the base path correctly once given the right root.

If your Jellyfin doesn't use a custom base URL, `JELLYFIN_SERVER` would just be `http://<host>:<port>` with no suffix.

## 5. Bug #3 — the companion plugin is dead on modern Jellyfin

Once auth was fixed, catalog browsing worked end-to-end, but clicking into any title to actually play it failed:

```
AxiosError: Request failed with status code 404
    url: 'http://127.0.0.1:11102/jellyfin/ProvidersIdSearch?ProviderId=tt0322259'
```

This endpoint is added by the companion plugin `jellyfin-providersid-search-plugin`, which the addon's README says is required. It wasn't installed yet, so installing it via **Dashboard → Plugins → Repositories** (add repo `https://raw.githubusercontent.com/akarazniewicz/jellyfin-providersid-search-plugin/main/manifest.json`) → **Catalog** → install "Providers ID Items Search API" seemed like the fix.

After installing, the endpoint stopped 404ing but started 500ing instead. Checking Jellyfin's own server log (`~/.apps/jellyfin/log/log_<date>.log`) revealed the real cause:

```
System.MissingMethodException: Method not found: 'System.Collections.Generic.List`1<MediaBrowser.Controller.Entities.BaseItem>
MediaBrowser.Controller.Library.ILibraryManager.GetItemList(MediaBrowser.Controller.Entities.InternalItemsQuery)'.
   at Jellyfin.Plugin.ProvidersIdSearch.Controller.ProvidersIdSearchController.FindItemsByProvidersId(String ProviderId)
```

The plugin's compiled DLL calls a Jellyfin server method signature that no longer exists — it was built against an older Jellyfin API (likely 10.8.x/10.9.x era) and this seedbox runs **Jellyfin 10.11.11**, a much newer release. The plugin is a small, apparently unmaintained project; downgrading the entire Jellyfin server just to keep one addon plugin working would risk the whole media server and any other integrations (e.g. Jellyseerr) for no good reason.

**Fix: remove the plugin dependency entirely**, replacing it with Jellyfin's own built-in `/Items` search API. Jellyfin's core API has no direct "find item by external provider ID" filter parameter (confirmed by pulling the live OpenAPI spec from `/jellyfin/api-docs/openapi.json` and checking every parameter on `/Items` — nothing matches), but it does support requesting `Fields=ProviderIds` on a recursive item search, letting the client filter by the exact IMDb ID itself:

```js
// jellyfin.js — getItemByImdbId()
return axios.get(`${server}/Items?userId=${this.auth.User.Id}&hasImdb=true&Recursive=true&IncludeItemTypes=Movie,Series&Fields=ProviderIds,MediaSources`,
    { headers: { 'X-Emby-Authorization': this.authorisationHeader } })
    .then(res => res.data.Items.filter(it => it.ProviderIds && it.ProviderIds.Imdb === imdbId))
```

`hasImdb=true` narrows the server-side result set to only IMDb-tagged items before the client-side filter runs, keeping the payload reasonable even for large libraries (tested against a 1190-item library without issue).

This means **the plugin is no longer required at all** for this fork. You can skip Section-5's plugin install steps entirely on a fresh deploy — they're documented here only because they were part of the diagnostic path, and because the original upstream README still says the plugin is required (it's a fair assumption until you've hit this exact version-incompatibility, since it works fine on older Jellyfin installs).

## 6. Bug #4 — meta handler always returned null

Separately from the plugin issue, `addon.js`'s `defineMetaHandler` was hardcoded:

```js
builder.defineMetaHandler(({type, id}) => {
    return Promise.resolve({meta: null})
})
```

This meant Stremio's "more info" view for any title would always show nothing, regardless of the plugin/API issue. Fixed to actually look up and return the item's metadata using the same `getItemByImdbId` now backed by the native API.

## 7. Bug #5 — stream/poster URLs used the internal loopback address

Even after the above fixes, the URLs returned to the *Stremio client* (poster images, the actual video stream link) were built from the same `JELLYFIN_SERVER` value used for the addon's own server-to-server API calls: `http://127.0.0.1:11102/jellyfin`. That's correct for the addon's own network calls (fast, local), but useless for a real Stremio client on a phone/PC/TV, which cannot reach the seedbox's own loopback address.

**Fix:** added a second env var, `PUBLIC_JELLYFIN_SERVER`, used only for client-facing URLs:

```ini
Environment=JELLYFIN_SERVER=http://127.0.0.1:11102/jellyfin
Environment=PUBLIC_JELLYFIN_SERVER=https://vgupta1192.peak.usbx.me/jellyfin
```

```js
// addon.js
const publicServer = process.env.PUBLIC_JELLYFIN_SERVER || server
// used in itemToMeta()'s poster URL and the stream handler's stream URL
```

If you don't set `PUBLIC_JELLYFIN_SERVER`, it falls back to `JELLYFIN_SERVER` (matching the original behavior) so this change is backward compatible.

## 8. All fixes pushed upstream (to the user's fork)

Since [akarazniewicz/stremio-jellyfin](https://github.com/akarazniewicz/stremio-jellyfin) (the original upstream) appears unmaintained, and `vgupta1192/stremio-jellyfin` is a personal fork with no active upstream sync expected, all of the above fixes were committed and pushed directly:

```bash
cd ~/apps/stremio-jellyfin
git add jellyfin.js addon.js
git commit -m "Fix Jellyfin API integration for modern Jellyfin servers"
git push origin main
```

Commit: `988e7e0`. A fresh clone of this fork will now deploy correctly without hitting any of bugs #2–#5.

## 8a. Bug #6 — catalogs worked in Stremio but were invisible in Nuvio

After the deployment above, the addon worked correctly in the Stremio app (both catalogs browsable, streams playable), but a separate client app, **Nuvio** (a different Stremio-protocol client, `NuvioMedia/NuvioTV`/`NuvioMobile`/`NuvioDesktop`), showed neither of the two Jellyfin catalogs at all — even though Nuvio could still resolve and play Jellyfin streams reached through *other* addons' catalogs. This ruled out anything wrong with Jellyfin itself or the stream-resolution code path, and pointed specifically at how Nuvio parses this addon's `manifest.json`.

**First (partial) fix attempt:** confirmed via direct curl testing that ~30% of catalog entries had no `id` field, because Jellyfin's `hasImdb=true` query parameter is not reliably enforced server-side (items with empty `ProviderIds` still came back). Added a client-side filter in `addon.js` to drop any item missing an IMDb id before mapping it to a Stremio meta object. This was a real, spec-required fix (every catalog meta object must have a non-empty `id`), but deploying and retesting showed it did **not** resolve the Nuvio-visibility issue on its own.

**Root cause, found by reading Nuvio's own client source** (`NuvioMedia/NuvioTV`, an open-source Kotlin/Compose Android TV app): Nuvio parses `manifest.json` with a strict Moshi JSON adapter into `AddonManifestDto` → `CatalogDescriptorDto`:

```kotlin
// NuvioTV: app/src/main/java/com/nuvio/tv/data/remote/dto/AddonManifestDto.kt
data class CatalogDescriptorDto(
    @Json(name = "type") val type: String,
    @Json(name = "id") val id: String,
    @Json(name = "name") val name: String,   // <-- non-nullable, no default
    ...
)
```

`name` is a required, non-nullable field with no default value. This addon's `manifest.js` catalog objects had `type` and `id` but **no `name` field at all** — technically also a Stremio SDK spec violation (`name` is documented as required in the manifest format), but one Stremio's own client tolerates silently. Moshi does not: a missing required field throws a `JsonDataException`, which fails the **entire manifest fetch** (`Response<AddonManifestDto>` via Retrofit) — not just the malformed catalog entry. That's why *both* catalogs vanished together in Nuvio while direct stream requests (`/stream/{type}/{id}`, which don't go through this DTO) kept working fine.

A second, independent manifest issue was found and fixed at the same time: `extra: [{ name: "skip", isRequired: true }]`. Per the Stremio SDK docs, `isRequired: true` on an extra means the catalog is *only* invoked when that value is supplied — intended for search-only catalogs, not pagination. Cross-checked directly against Nuvio's actual filtering logic (`SearchViewModel.kt`, `HomeViewModelCatalogUtils.kt`): any `isRequired` extra other than `search` disqualifies a catalog from being treated as browsable, so this was also a real (if secondary) bug — though the missing `name` field was the one actually causing the total parse failure.

**Fix**, in `manifest.js`:

```js
{
    "type": "movie",
    "id": "all",
    "name": "Jellyfin Movies",
    "extra": [
        { "name": "skip", "isRequired": false },
        { "name": "search", "isRequired": false }
    ]
},
{
    "type": "series",
    "id": "all",
    "name": "Jellyfin Series",
    "extra": [
        { "name": "skip", "isRequired": false },
        { "name": "search", "isRequired": false }
    ]
}
```

And a small follow-on guard in `jellyfin.js`, since `skip` can now legitimately be omitted by a stricter client:

```js
// was: let firstItem = Number(skip) + 1   (NaN if skip is undefined)
let firstItem = (Number(skip) || 0) + 1
```

**Verified live** before pushing (per the deploy-test-then-push workflow used throughout this project): manifest returns 200 with both catalog `name` fields present, `catalog/movie/all.json` returns 14 metas with zero missing ids, stderr log clean, and — after a full remove-and-re-add of the addon in Nuvio — both catalogs appeared correctly. Pushed as commit `c1e1802`.

**Takeaway for future manifest changes:** Stremio's own client is a poor test of manifest correctness — it tolerates missing required fields that a spec-compliant or simply stricter client (Nuvio, and likely others) will not. Validate new catalogs against the full required-field list (`type`, `id`, `name`) even though Stremio itself won't complain if you get it wrong.

## 9. Exposing the addon publicly — the Tailscale/Cloudflare investigation

The original plan was to expose this addon via Tailscale instead of the nginx-reverse-proxy pattern used for other addons, to avoid path-prefix issues that had broken manifest generation for other addons in the past. This required real investigation rather than assumption.

### 9.1 Tailscale — doesn't work on this account

Tailscale needs a real `/dev/net/tun` network interface to route traffic, which normally requires root. Testing revealed:

- `/dev/net/tun` is unusually world-writable (`crw-rw-rw-`) on this seedbox — a rare, favorable sign.
- However, actually creating the named TUN interface Tailscale needs (`tstun.New("tailscale0")`) requires the `CAP_NET_ADMIN` capability, which a non-root process does not have regardless of the device file's permissions. Confirmed directly:
  ```
  wgengine.NewUserspaceEngine(tun "tailscale0") error: tstun.New("tailscale0"): operation not permitted
  ```
- Tailscale's fallback **userspace networking mode** avoids needing `CAP_NET_ADMIN`, but by design it only provides *outbound* connectivity (a local SOCKS5/HTTP proxy for this machine to reach the tailnet) — it cannot *serve* a local port to other tailnet members. This rules it out for the actual goal (letting a Stremio client reach the addon).
- Tailscale Funnel/Serve (the public-exposure features) were also investigated, but both proxy traffic *to* the local `tailscaled` node — meaning the seedbox itself must be a functioning tailnet node first. There's no way to "reach in" from a different device's Tailscale node, since the architecture requires the serving device to hold its own tailnet identity and interface.

**Conclusion: Tailscale cannot expose a service on this non-root Ultra.cc account, in any mode.**

### 9.2 Cloudflare Tunnel — works, but needs a permanent hostname

Unlike Tailscale, Cloudflare Tunnel's `cloudflared` binary makes purely **outbound** HTTPS/QUIC connections to Cloudflare's edge — no TUN device, no elevated capabilities. This was tested and confirmed working:

```bash
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
chmod +x cloudflared
./cloudflared tunnel --url http://127.0.0.1:19999
```

This produced a real public HTTPS URL, and an external fetch of that URL correctly reached a local test server on the seedbox — full proof the mechanism works without root.

The catch: the free `trycloudflare.com` quick-tunnel used for this test issues a **random hostname on every restart** — unsuitable for a permanent Stremio addon URL (you'd have to re-add the addon in Stremio every time the tunnel process restarts, e.g. after any crash, reboot, or auto-update). A permanent named tunnel requires adding a real domain to a Cloudflare account (domain purchase, or a Cloudflare-compatible free-subdomain service like `is-a.dev`, which requires a manual GitHub PR review — not instant).

### 9.3 Final answer: DuckDNS + direct port exposure

Given the constraints, the simplest and most robust solution turned out to not need Tailscale or Cloudflare at all:

1. **DuckDNS** (duckdns.org) provides a genuinely free, instant, permanent subdomain (`<name>.duckdns.org`) that's a plain A-record pointed at the seedbox's public IP — no tunnel, no proxy, no approval process.
2. The addon is exposed on its **own dedicated port** (5010), the exact same pattern already proven to work for Sootio, StremThru, and MediaFusion-API on this seedbox. This avoids the nginx-subpath issue entirely (no `/subpath` prefix means no manifest-path-mangling bug).

```bash
curl -s "https://www.duckdns.org/update?domains=<name>&token=<token>&ip=<public-ip>"
```

**Important gotcha hit during setup:** DuckDNS's own dashboard auto-detected an incorrect IP (`49.205.43.134`) when the domain was first created — likely a stale/incorrect detection from the browser session. The correct IP was confirmed by resolving `vgupta1192.peak.usbx.me` (the seedbox's known-working domain) via a public DNS-over-HTTPS query and cross-checking it matched `ifconfig.me`'s output from the seedbox itself. Always verify the IP DuckDNS actually stores, don't trust its auto-detection blindly.

Final manifest URL:

```
http://vgupta1192.duckdns.org:5010/manifest.json
```

## 10. Full systemd unit

```ini
# ~/.config/systemd/user/stremio-jellyfin.service
[Unit]
Description=Stremio Jellyfin Addon
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/apps/stremio-jellyfin
Environment=SERVER_PORT=5010
Environment=JELLYFIN_SERVER=http://127.0.0.1:11102/jellyfin
Environment=PUBLIC_JELLYFIN_SERVER=https://vgupta1192.peak.usbx.me/jellyfin
Environment=JELLYFIN_USER=<jellyfin-username>
Environment=JELLYFIN_PASSWORD=<jellyfin-password>
Environment=PUBLIC_ADDON_URL=https://vgupta1192.peak.usbx.me/stremio-jellyfin
Environment=SEERR_URL=https://vgupta1192.peak.usbx.me/seerr
Environment=SEERR_API_KEY=<seerr-api-key>
ExecStart=/home/<user>/.nvm/versions/node/v24.19.0/bin/node server.js
Restart=on-failure
RestartSec=5
StandardOutput=file:%h/apps/logs/stremio-jellyfin/stremio-jellyfin-stdout.log
StandardError=file:%h/apps/logs/stremio-jellyfin/stremio-jellyfin-stderr.log

[Install]
WantedBy=default.target
```

```bash
chmod 600 ~/.config/systemd/user/stremio-jellyfin.service   # contains a plaintext password
systemctl --user daemon-reload
systemctl --user enable --now stremio-jellyfin.service
```

## 11. Monitoring integration

Wired into the same infrastructure every other addon on this seedbox uses:

- **watchdog.sh** — added to the `SERVICES` array with health-check URL `http://127.0.0.1:5010/manifest.json` expecting `^200$`. Runs every 5 minutes; auto-restarts on failure with a 60s cooldown between attempts.
- **auto-update.sh** — added `update_stremio_jellyfin()` calling the shared `update_git_app` helper (git fetch/pull if changed → `npm install` → restart service → health-check → auto-rollback via `git reset --hard` on failure).
- **seedbox-check / full-check.sh** — added to the systemd-services list, local HTTP health check, and public-URL check sections.
- **rotate-app-logs.sh** — no changes needed; the script already walks `~/apps/logs/*/*.log` as a wildcard, so `~/apps/logs/stremio-jellyfin/*.log` is automatically covered (2MB rotation threshold, 7-day retention, with the standard "restart the owning service after rotation" step since this is a persistent process holding an open file descriptor to its log path).

## 12. Verification checklist

```bash
# service is up
systemctl --user status stremio-jellyfin.service

# manifest reachable locally
curl -s http://127.0.0.1:5010/manifest.json

# manifest reachable publicly, permanent hostname
curl -s http://vgupta1192.duckdns.org:5010/manifest.json

# catalog returns real Jellyfin library items
curl -s http://127.0.0.1:5010/catalog/movie/all.json

# meta lookup by IMDb id returns real data (not null)
curl -s http://127.0.0.1:5010/meta/movie/tt0322259.json

# stream lookup returns a real, publicly-reachable playback URL
curl -s http://127.0.0.1:5010/stream/movie/tt0322259.json

# monitoring picks it up
seedbox-check | grep stremio-jellyfin
```

To install in Stremio: **Settings → Addons → Community Addons → paste manifest URL**:

```
http://vgupta1192.duckdns.org:5010/manifest.json
```

The same URL works for Nuvio (Settings → Addons → Add addon → paste manifest URL) as of commit `c1e1802` — earlier commits will fail to load any catalogs in Nuvio specifically, per Bug #6 above.

## 13. "Request via Seerr" — one-click requests for missing titles

Previously, if a title wasn't yet in the Jellyfin library, `defineStreamHandler` just returned an empty `streams: []` — a dead end in the client, with no path from "not available" to "downloaded and streaming."

**Why Seerr, not Jellyseerr:** Jellyseerr and Overseerr were both officially deprecated in February 2026, merged by their own dev team into a single unified project called **Seerr** (final sunset for both predecessors: end of May 2026). Seerr is the same codebase, not a rewrite, and its request API (`X-Api-Key` auth, `POST /api/v1/request`) is unchanged from Overseerr/Jellyseerr's long-stable contract — so this integration targets Seerr directly rather than building against a project already being sunset.

**New module — `seerr.js`:** mirrors `jellyfin.js`'s client pattern. `requestMedia(tmdbId, mediaType)` calls `POST /api/v1/request` — for TV, requesting all seasons (`seasons: "all"`), since Stremio's per-episode granularity doesn't map cleanly onto a one-click "request this show" action.

**Bug hit and fixed during testing — IMDb-to-TMDb resolution:** the first implementation of `findByImdbId()` searched Seerr's own `/api/v1/search?query=<imdbId>` endpoint, assuming TMDb's search backend would resolve a raw IMDb-id-shaped string directly. Live testing (`tt0068646`, The Godfather — an unambiguous, definitely-indexed title) proved this wrong: `/search` is confirmed (by reading Seerr's own source, `server/routes/search.ts` / `server/api/themoviedb/index.ts`) to be a plain title-text search against TMDb's `/search/multi`, with no external-id matching at all — it silently returned zero relevant results for an ID-shaped query. **Fix:** call TMDb's own `/find/{imdbId}?external_source=imdb_id` endpoint directly instead (the same endpoint Seerr's backend uses internally via `getMediaByImdbId()`/`getByExternalId()`, confirmed in `server/api/themoviedb/index.ts` — it's just never exposed as its own public Seerr route). This uses TMDb's own public "read" API key, which Seerr/Overseerr/Jellyseerr all ship hardcoded in their own open-source repos (`431a8708161bcd1f1fbe7536137e61ed`) — not a secret tied to this deployment, so no separate TMDb account/key registration is needed. Overridable via an optional `TMDB_API_KEY` env var if you'd rather use your own.

**Bug hit and fixed during testing — stale/invalid Seerr API key:** the first API key copied from Seerr's Settings → General page 403'd on `/api/v1/search` (and every other authenticated endpoint) while the unauthenticated `/api/v1/status` and `/api/v1/settings/public` endpoints worked fine — confirmed via direct `curl` (bypassing this addon entirely) and by reading Seerr's own auth middleware (`server/middleware/auth.ts`): it does a strict `req.header('X-API-Key') === settings.main.apiKey` string comparison, and a mismatch means `req.user` never gets set, causing every permission check downstream to 403 regardless of which permission is actually required. Regenerating the key in Seerr's UI and using the fresh value fixed it immediately — the original key had simply gone stale/invalid server-side.

**Stream-handler change — `addon.js`:** when no Jellyfin item is found (movie or episode), instead of returning `streams: []`, a fallback stream entry is returned:

```js
{
    name: "Seerr",
    title: "Request via Seerr",
    description: "Request via Seerr",
    url: `${publicSelfUrl}/request/${type}/${imdbId}`,
    behaviorHints: { notWebReady: true }
}
```

**Design history — three iterations, only the third one actually works. Read this before changing anything here again.**

*Iteration 1 — `externalUrl` pointing at a confirmation-page route.* Assumption: this is the standard way to expose a non-playback action link. Wrong — per the Stremio addon spec, `externalUrl` is **always** opened outside the app (system browser) in every Stremio-protocol client, confirmed live in Nuvio on both desktop and mobile. There's no spec-level "open a webpage inside the app" stream type.

*Iteration 2 — switched to `url`, held the HTTP connection open for up to 5 minutes while polling Jellyfin internally, then either 302-redirected to the real stream or responded with a timeout error.* This seemed reasonable (a player opening `stream.url` should tolerate a slow-to-respond connection, the same way a slow torrent resolve would) but was proven wrong by live testing: the "5 minute timeout" error never appeared and even the real file (ready ~11 minutes later) never played — the player was just stuck on "loading" forever. Root cause, confirmed by reading Nuvio's own source (`PlayerPlaybackNetworking.kt` in both `NuvioTV-dev` and `NuvioMobile-cmp-rewrite`): Nuvio's OkHttp-backed playback client uses a **15-second** connect/read/write timeout, with ExoPlayer's own retry/backoff policy giving up entirely around 90-100 seconds — nowhere close to 5 minutes. A connection that sends zero bytes for that long fails almost immediately from the player's perspective, it just doesn't surface a visible error because retries silently absorb it for a while.

*Iteration 3 (attempted, also rejected before implementation) — redirect-loop: respond fast every few seconds with a 302 back to the same endpoint, carrying the original start time forward, until ready or timed out.* This looked like the fix (every individual response is fast, well under 15s) but research into the actual player HTTP stacks killed it before it was ever deployed: OkHttp (used by ExoPlayer/Nuvio) hard-caps at **20** redirect follow-ups (`RetryAndFollowUpInterceptor.MAX_FOLLOW_UPS`), and ffmpeg/mpv (used by Stremio's own libmpv player) caps at **8** by default (`HTTP_MAX_REDIRECTS_DEFAULT`). A 5-minute wait at a few seconds per hop needs 70+ redirects — both players would hard-fail with a protocol error around hop 8-20, long before either the timeout or the real file could ever be reached.

**Final design (iteration 4, deployed and working) — respond immediately with a short static placeholder video, no polling or redirecting of any kind.** The underlying realization: no single HTTP response can both stay open for minutes *and* later swap to a different real video file — players don't support hot-swapping content mid-stream, so trying to make the "wait" and the "play" happen in one request was never going to work cleanly. Instead, `GET /request/:type/:imdbId/:season?/:episode?` now:

1. Does one quick check (sub-second) — if the title is somehow already available (e.g. reopening after it finished downloading, before the client's own cache refreshed), redirects straight to the real Jellyfin stream immediately.
2. Otherwise submits the request to Seerr (tolerating Seerr's `409 already requested` as the expected case on every subsequent open of the same title while it's still downloading).
3. Responds immediately (typically ~1-2 seconds total) with `res.sendFile()` serving a small static placeholder video (`assets/requested-placeholder.mp4`, ~30KB, 10s silent clip with "Requested via Seerr, still downloading..." burned in as text via ffmpeg's `drawtext` filter — generated once directly on the seedbox: `ffmpeg -f lavfi -i color=... -f lavfi -i anullsrc=... -vf drawtext=... -shortest -c:v libx264 -c:a aac assets/requested-placeholder.mp4`). This is a normal, fast, complete file response, not a hanging connection, so it can't trip any player's read timeout.

**The UX tradeoff this accepts:** there is no automatic transition from "placeholder" to "real stream" mid-playback. The user has to manually reopen the title later, once it's actually downloaded — at which point `defineStreamHandler`'s normal fast path in `addon.js` finds the real Jellyfin item and returns it directly, exactly like any title that was already in the library, no extra plumbing needed. This was a deliberate, evidence-based tradeoff after two more "seamless" designs were tried and both proven to fail against real player constraints — a placeholder that plays cleanly and a manual reopen is strictly better than a loading spinner that never resolves.

**Confirmed working end-to-end in Nuvio** (both the placeholder plays immediately without error, and reopening the title after the real download completes correctly shows the real Jellyfin stream).

**New dependency:** `express` was already a transitive dependency of `stremio-addon-sdk` (confirmed via its own `package.json`), but is now also declared directly in this project's `package.json` since `server.js` builds its own Express app (`getRouter(addonInterface)` mounted the same way `serveHTTP` does internally — confirmed by reading the SDK's own source, `src/serveHTTP.js` — plus the new `/request` route, which `serveHTTP` has no hook for).

**New environment variables:**

```ini
Environment=SEERR_URL=https://seerr-vgupta1192.peak.usbx.me
Environment=SEERR_API_KEY=<seerr-api-key>
Environment=PUBLIC_ADDON_URL=http://vgupta1192.duckdns.org:5010
```

- `SEERR_URL` / `SEERR_API_KEY` — Seerr's public base URL. Note this ended up being a **distinct subdomain** (`seerr-vgupta1192.peak.usbx.me`), not the `vgupta1192.peak.usbx.me/<app>` URL-Base subpath pattern used for Radarr/Sonarr/Jellyfin on this seedbox — confirm the actual working pattern for your own Seerr instance rather than assuming it matches other apps. API key from Seerr's **Settings → General → API Key**.
- `PUBLIC_ADDON_URL` — this addon's own publicly-reachable base URL, needed so the `url` link built for the Stremio/Nuvio client (not this server itself) is actually reachable by whatever device opens it. Falls back to `http://127.0.0.1:<SERVER_PORT>` if unset (fine for local testing, not for a real client).
- If `SEERR_URL`/`SEERR_API_KEY` are left unset, `seerr.enabled` is `false` and the addon silently falls back to the old behavior (`streams: []` when nothing is found) rather than showing a broken request link — this is a deliberate no-crash fallback, not an error state.

**Bug hit and fixed during testing — stale/invalid Seerr API key:** the first API key copied from Seerr's Settings → General page 403'd on every authenticated endpoint while unauthenticated endpoints worked fine — confirmed via direct `curl` and by reading Seerr's own auth middleware (`server/middleware/auth.ts`): a strict `req.header('X-API-Key') === settings.main.apiKey` string comparison, where any mismatch means `req.user` never gets set and every downstream permission check 403s regardless of which permission is actually required. Regenerating the key in Seerr's UI fixed it immediately — the original key had simply gone stale/invalid server-side, this was not a copy/paste or encoding issue.

**Bug hit and fixed during testing — IMDb-to-TMDb resolution:** the first implementation of `findByImdbId()` searched Seerr's own `/api/v1/search?query=<imdbId>` endpoint. Live testing (`tt0068646`, The Godfather) proved this wrong: `/search` is confirmed (by reading Seerr's own source) to be a plain title-text search against TMDb's `/search/multi`, with no external-id matching at all. **Fix:** call TMDb's own `/find/{imdbId}?external_source=imdb_id` endpoint directly, using TMDb's own public "read" API key that Seerr/Overseerr/Jellyseerr all ship hardcoded in their own open-source repos (`431a8708161bcd1f1fbe7536137e61ed`) — not a secret, no separate TMDb account needed. Overridable via an optional `TMDB_API_KEY` env var.

**Bug hit after deploying the `url`-based redesign — full regression, all streams (not just Seerr fallback ones) returning `{"err":"handler error"}`, Stremio crashing repeatedly on the addon.** Root-caused via a truncate-log-then-single-request sequence to a clean `AxiosError: 401 Unauthorized` from Jellyfin's own `/Items` endpoint — Jellyfin itself was confirmed healthy (`/System/Ping` returned `200`), isolating the problem to this addon process's own cached auth token. `jellyfin.js`'s `authenticate()` only ever ran once, at process startup (`const jellyfin = new JellyfinApi(); await jellyfin.authenticate()` at the top of `addon.js`) — if Jellyfin invalidates/rotates that session token at any point after that (server restart, session expiry, etc.), every single subsequent request from the long-running addon process 401s, with no retry or recovery. A plain `systemctl --user restart` confirmed this diagnosis (forcing a fresh `authenticate()` call immediately fixed it), but that's a manual workaround, not a fix. **Real fix:** `jellyfin.js` now routes every Jellyfin API call through a shared `authenticatedGet(url)` wrapper. On any `401`, it calls `authenticate()` again (fetching a fresh token) and retries the exact same request once before giving up — the addon now self-heals from a stale token automatically, with no manual restart needed.

### 13.1 Verification checklist for this feature

```bash
# 1. Confirm the placeholder video was generated
ls -la ~/apps/stremio-jellyfin/assets/requested-placeholder.mp4
# expect: a real file, ~30KB

# 2. Pick a real IMDb id NOT currently in your Jellyfin library, confirm the
#    stream handler returns the request-fallback entry instead of an empty list
curl -s http://127.0.0.1:5010/stream/movie/<imdb-id-not-in-library>.json
# expect: streams[0].name === "Seerr", streams[0].url set (not externalUrl)

# 3. Confirm the /request endpoint responds FAST with real video bytes, not
#    a hang - this is the whole point of the final design
time curl -s -o /tmp/test.mp4 -w "HTTP %{http_code}, %{size_download} bytes, %{time_total}s\n" \
  http://127.0.0.1:5010/request/movie/<imdb-id-not-in-library>
# expect: HTTP 200, ~30000 bytes, well under 5 seconds

# 4. Confirm a title ALREADY in the library still returns a normal direct
#    Jellyfin stream (not a Seerr fallback) - regression check for the
#    auth-wrapper refactor
curl -s http://127.0.0.1:5010/stream/movie/<imdb-id-already-in-library>.json
# expect: streams[0].name === "Jellyfin", streams[0].url points at Jellyfin

# 5. Click through in Nuvio itself: open a missing title, tap "Request via
#    Seerr", confirm the placeholder plays immediately with no browser hop
#    and no error, and the request appears in Seerr's own Requests queue

# 6. Confirm the existing pipeline picks it up: Radarr/Sonarr fetches it,
#    lands in Jellyfin, and manually reopening the SAME title later shows
#    the real Jellyfin stream instead of the placeholder - confirmed working
#    live (Nuvio)
```

### 13.2 Known open issue — Stremio's own client still doesn't show the entry

**Confirmed still broken as of the final placeholder-video design.** The "Request via Seerr" stream entry displays correctly in Nuvio (desktop and mobile) but does not appear at all in the official Stremio app (tested on Mac desktop and Android mobile), even after fully removing and re-adding the addon, and even after testing three different `behaviorHints`/`description` variations.

**What's been ruled out, in order:**

1. **Addon-side caching** — ruled out. Removing and fully re-adding the addon in Stremio was tested multiple times across different code versions; the entry still never appears.
2. **The endpoint not actually returning the entry** — ruled out. Confirmed via direct `curl` against `/stream/movie/<id>.json` that the JSON response correctly includes the Seerr stream object every time.
3. **Stremio not even reaching the addon for that title** — ruled out. Confirmed via live server-log capture (truncate stdout log, open the title in Stremio, check the log) that Stremio does request `/stream/movie/<id>.json` and the addon does respond.
4. **`behaviorHints.notWebReady`** — tested both `false` and `true`. Neither made any difference.
5. **Long, sentence-style `description` text confusing some UI-side quality/filename parser** — tested shortening `description` to a plain `"Request via Seerr"` string (matching the `name`/`title` style of a normal addon stream). No difference.
6. **`stremio-core`'s own Rust logic (shared by macOS desktop and Android, confirmed by reading the actual source, `src/types/resource/stream.rs` and `src/deep_links/mod.rs` in `Stremio/stremio-core`)** — ruled out as the filtering layer. `Stream::streaming_url()` passes any non-`magnet:` URL through unmodified regardless of scheme, host, or port; there is no file-extension check anywhere in the stream-resolution path; `StreamSource` is an untagged serde enum that cleanly matches a plain `{"url": ...}` object as its `Url` variant, and every downstream deep-link/player-URL builder (`ExternalPlayerLink::from()`, `StreamDeepLinks::player`) populates unconditionally for it. In other words: Stremio's shared core never drops this stream — whatever is filtering it out is happening in the UI rendering layer (`stremio-web`'s React code, or platform-specific list rendering in the desktop/Android shells), which has not yet been located in source.

**Current status: unresolved, deprioritized.** The feature is fully functional end-to-end via Nuvio, which was confirmed as the primary client this was built for. If this needs to be revisited: the next concrete step would be pulling `stremio-web`'s actual stream-list rendering component (not `stremio-core`) and diffing its behavior against a known-working addon's stream response field-by-field, since the shared Rust core has now been conclusively ruled out as the cause.

## Commit history

| Commit | Description |
| --- | --- |
| `988e7e0` | Fix Jellyfin API integration for modern Jellyfin servers (auth base-path, plugin replacement, meta handler) |
| `c1e1802` | Fix Nuvio catalog visibility: add required catalog `name` field, relax `skip` `isRequired`, filter items missing IMDb id |
| _(pending)_ | Add "Request via Seerr" fallback stream (`url`-based, static placeholder video response, not `externalUrl` or a blocking poll/redirect-loop) for titles missing from Jellyfin, using TMDb's `/find` endpoint for exact IMDb-id resolution, plus retry-on-401 auto re-authentication in `jellyfin.js`. Confirmed working end-to-end in Nuvio; Stremio's own client still doesn't display the entry (see 13.2, unresolved) |
