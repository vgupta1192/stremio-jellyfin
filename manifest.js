// A config selects which of the three catalogs are shown. Each distinct
// config is a genuinely separate installable Stremio addon (its own
// manifest id, mounted at its own URL prefix - see server.js/addon.js),
// since Stremio has no concept of reconfiguring an installed addon's
// catalog list in place.
export const CATALOG_KEYS = ["movies", "series", "adult"]

export const ALL_ENABLED = {showMovies: true, showSeries: true, showAdult: true}

// Every one of the 2^3 = 8 possible on/off combinations, generated rather
// than listed by hand so adding a fourth toggle later is a one-line change
// (add "showX" to configToSlug/createManifest) instead of rewriting a
// hardcoded list.
export const ALL_CONFIGS = []
for (const showMovies of [true, false]) {
    for (const showSeries of [true, false]) {
        for (const showAdult of [true, false]) {
            ALL_CONFIGS.push({showMovies, showSeries, showAdult})
        }
    }
}

// The "everything enabled" config lives at the root URL with no prefix
// (backward compatible with the addon's original, single-manifest
// behavior) - every other combination gets a URL prefix naming exactly
// which catalogs it includes, e.g. "/movies-adult/manifest.json".
export function configToSlug({showMovies, showSeries, showAdult}) {
    const enabled = []
    if (showMovies) enabled.push("movies")
    if (showSeries) enabled.push("series")
    if (showAdult) enabled.push("adult")
    if (enabled.length === CATALOG_KEYS.length) return null
    return enabled.length > 0 ? enabled.join("-") : "none"
}

export function createManifest(config) {
    const {showMovies, showSeries, showAdult} = config
    const catalogs = []
    if (showMovies) {
        catalogs.push({
            "type": "movie",
            "id": "all",
            "name": "Jellyfin Movies",
            "extra": [
                {"name": "skip", "isRequired": false},
                {"name": "search", "isRequired": false}
            ]
        })
    }
    if (showSeries) {
        catalogs.push({
            "type": "series",
            "id": "all",
            "name": "Jellyfin Series",
            "extra": [
                {"name": "skip", "isRequired": false},
                {"name": "search", "isRequired": false}
            ]
        })
    }
    if (showAdult) {
        catalogs.push({
            "type": "movie",
            "id": "adult",
            "name": "Adult",
            "extra": [
                {"name": "skip", "isRequired": false},
                {"name": "search", "isRequired": false}
            ]
        })
    }
    const slug = configToSlug(config)
    return {
        // Distinct per config so Stremio treats each combination as its
        // own separate addon, not one addon being silently reconfigured -
        // installing one doesn't touch or replace another.
        "id": slug ? `community.stremiojellyfin.${slug.replace(/-/g, ".")}` : "community.stremiojellyfin",
        "version": "1.0.0",
        "catalogs": catalogs,
        "resources": [
            "catalog",
            "stream",
            "meta"
        ],
        "types": [
            "movie",
            "series"
        ],
        "name": slug ? `Jellyfin (${catalogs.map(c => c.name).join(", ") || "no catalogs"})` : "Jellyfin",
        "description": "Stremio Jellyfin integration",
        "behaviorHints": {
            "configurable": true
        }
    }
}
