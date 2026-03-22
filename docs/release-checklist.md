# Memforge Release Checklist

> Maintainer-only operational checklist.
> This document is for release verification and packaging work, not for product positioning or end-user onboarding.

## Pre-release

- update versions to the intended release tag
- run `npm run check`
- run `npm test`
- run `npm run build`
- run `npm run prepare:cli-package`
- confirm `npm pack ./release/npm-cli` succeeds
- confirm `npm run verify:cli-package` succeeds after packing the tarball

## npm release

- `npm publish ./release/npm-cli --access public` succeeds
- `npm pack ./release/npm-cli` is followed by `npm run verify:cli-package`
- `memforge --help` works after install
- `pnw help` works after install
- `pnw mcp install` creates `~/.memforge/bin/memforge-mcp`
- `memforge-mcp --help` starts from the installed package
- the installed MCP launcher contains `memforge-mcp.js` and `--api`, but not persisted bearer tokens

## Release notes and docs

- `CHANGELOG.md` contains the release entry when a release note is needed
- `README.md` matches the two supported distribution paths: Git source-run and npm terminal-only
- `app/cli/README.md` matches the npm package behavior
- historical docs remain marked historical
