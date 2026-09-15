// showAdult controls whether the "Adult" catalog entry is advertised at
// all - see addon.js, which builds one full addonBuilder interface and one
// without this catalog, and server.js, which mounts them under different
// URL prefixes so each is a genuinely separate, installable Stremio addon
// (distinct manifest id) rather than one addon whose content changes
// underneath an existing install.
export function createManifest(showAdult) {
    const catalogs = [
        {
            "type": "movie",
            "id": "all",
            "name": "Jellyfin Movies",
            "extra": [
                {"name": "skip", "isRequired": false},
                {"name": "search", "isRequired": false}
            ]
        },
        {
            "type": "series",
            "id": "all",
            "name": "Jellyfin Series",
            "extra": [
                {"name": "skip", "isRequired": false},
                {"name": "search", "isRequired": false}
            ]
        }
    ]
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
    return {
        // Distinct ids so Stremio treats "with Adult" and "without Adult"
        // as two genuinely separate addons, not one addon being silently
        // reconfigured - installing one doesn't touch or replace the other,
        // and switching the choice on the configure page is a fresh
        // install of the other one alongside (or instead of) it.
        "id": showAdult ? "community.stremiojellyfin" : "community.stremiojellyfin.noadult",
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
        "name": showAdult ? "Jellyfin" : "Jellyfin (no Adult)",
        "description": "Stremio Jellyfin integration",
        "behaviorHints": {
            "configurable": true
        }
    }
}
