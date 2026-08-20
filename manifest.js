export const manifest = {
    "id": "community.stremiojellyfin",
    "version": "1.0.0",
    "catalogs": [
        {
            "type": "movie",
            "id": "all",
            "name": "Jellyfin Movies",
            "extra": [
                {
                    "name": "skip",
                    "isRequired": false
                },
                {
                    "name": "search",
                    "isRequired": false
                }
            ]
        },
        {
            "type": "series",
            "id": "all",
            "name": "Jellyfin Series",
            "extra": [
                {
                    "name": "skip",
                    "isRequired": false
                },
                {
                    "name": "search",
                    "isRequired": false
                }
            ]
        }
    ],
    "resources": [
        "catalog",
        "stream",
        "meta"
    ],
    "types": [
        "movie",
        "series"
    ],
    "name": "Jellyfin",
    "description": "Stremio Jellyfin integration"
}
