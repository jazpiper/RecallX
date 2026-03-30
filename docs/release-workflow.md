# RecallX Release Workflow

This document describes the current maintainer flow for versioning and publishing `recallx` and `recallx-headless`.

## Release Model

- Changesets are the source of truth for upcoming version bumps and release notes.
- The root [`package.json`](../package.json) version is the release version for both npm packages.
- `recallx` and `recallx-headless` are generated from the repo at publish time, not stored as first-class packages in the repo.

## Feature PR Flow

When a change should affect the next npm release:

```bash
npm run changeset
```

Choose the release type you want for `recallx`, write a short summary, and commit the generated markdown file under `.changeset/`.
Do not add `recallx-headless` to changeset frontmatter. The headless package is generated and published from the same repo version rather than versioned as a first-class Changesets workspace package.

Good candidates for a changeset:

- behavior changes in the API, CLI, MCP bridge, or renderer
- packaging or runtime changes that affect install or upgrade behavior
- fixes that should appear in release notes

## Release PR Flow

After changesets land on `main`, the `Release` GitHub Actions workflow:

1. opens or updates a version PR
2. runs `npm run version:release`
3. bumps the root version and syncs the internal package versions and lockfiles
4. updates `CHANGELOG.md`

Review and merge the version PR like any other PR.

## Publish Flow

After the version PR merges to `main`, run the `Publish` GitHub Actions workflow from the Actions tab.

The `Publish` workflow:

1. runs `npm run release:publish`
2. verifies whether `recallx@<version>` or `recallx-headless@<version>` are already on npm
3. skips safely if both packages are already published
4. otherwise runs the full verification pipeline and publishes only the missing package versions

The publish script uses npm provenance, so the GitHub workflow needs:

- `NPM_TOKEN` repository secret
- `id-token: write` workflow permission

## Maintainer Commands

Useful local commands:

```bash
npm run changeset
npm run changeset:status
npm run version:release
npm run release:verify
npm run release:publish
```

`npm run changeset:status` is also a useful pre-merge guard when touching release notes or workflow plumbing because it catches invalid package names in pending changesets.
In GitHub Actions, this check should use a full checkout and compare against `origin/main` so detached PR merge refs still validate correctly.

## Notes

- `npm run release:verify` is the same validation path used by CI before publish.
- `npm run release:publish` is idempotent for already-published versions.
- `workflow_dispatch` on the publish workflow can target another ref if you need to rerun a publish from a release commit.
- GitHub Actions workflow pins should stay on Node 24 compatible releases for JavaScript actions such as `actions/checkout` and `actions/setup-node`.
