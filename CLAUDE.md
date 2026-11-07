# Notes for working on this repository

* **Versions:** every round of changes that goes live raises the version by 0.01 (1.00 -> 1.01 ->
  1.02 ...): `npm version minor --no-git-tag-version` (package.json 1.1.0 is shown as 1.01, see
  `src/version.ts`), plus an entry in `CHANGELOG.md`. One step per round of changes, not per commit.
* **Deployment:** a push to the default branch rebuilds the data and the site and deploys it to
  GitHub Pages (`.github/workflows/pages.yml`, about half an hour with a warm catalogue cache).
  Commits that change nothing on the site (docs only) may carry `[skip ci]`.
* **Checks before a push:** `npm run typecheck`, `npm test`, `npm run build`, and
  `cd pipeline && python -m pytest -q` when the pipeline changed.
