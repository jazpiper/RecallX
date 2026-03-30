# Changesets

RecallX uses Changesets to drive release PRs from `main`.

Typical maintainer flow:

1. Run `npm run changeset` in a feature branch when a user-visible or release-relevant change should affect the next npm release.
2. Merge feature work to `main`.
3. The GitHub release workflow opens or updates a version PR.
4. Merge the version PR after reviewing the version bump and changelog.
5. After the version PR merges, run the separate Publish workflow to publish `recallx` and `recallx-headless` if that version is not already on npm.
