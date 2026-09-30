# Patch build (NuvioTV-style)

This branch is **vanilla upstream** ([akarazniewicz/stremio-jellyfin](https://github.com/akarazniewicz/stremio-jellyfin))
plus this `.github/` directory. All custom changes live as a patch series in
`.github/patches/` and are applied by CI (`.github/workflows/patch-build.yml`)
on top of the latest upstream main at build time — the same pattern the Nuvio
app forks use, so upstream updates keep flowing in.

- **CI output**: every push to `main` publishes a public release
  (`build-N`) with `jellyfin-addon-src.tar.gz` = upstream + patches, ready to
  `docker build`. If upstream changes in a way that breaks a patch, the build
  fails loudly instead of shipping stale code.
- **Update flow when upstream moves**: rebase this branch onto the new
  upstream main (only this `.github/` dir is ours, so it is a clean rebase),
  then fix/regenerate whichever patch no longer applies:
  `git format-patch <old-base>..<your-fixes> -o .github/patches/`.
- **History**: the original 16-commit development history is preserved on the
  `main-prepatch-20260930` branch.

Patch series (in order): modern-Jellyfin API/auth fixes, Nuvio catalog
visibility, Seerr request stream (+dedupe/auto-reauth), full-library catalogs
(every item, IMDb-matched or not), dedicated Adult catalog, messy-library
episode numbering, poster fallback/self-heal, per-install catalog selection
(8 combinations = Movies/Series/Adult toggles), and Seerr id-whitelisting.
