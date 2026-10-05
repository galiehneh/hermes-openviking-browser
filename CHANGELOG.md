# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.2] - 2026-10-05

### Fixed
- Reader: the v1.0.1 fix only covered entries picked from the listing. A directory selected any other way
  (the `›` button, a breadcrumb, a search hit, or a hit arriving before its parent listing had loaded) had no
  listing entry, so the content tab came back and showed "Directory URI is not readable as a file". Directory-ness
  is now resolved with `fs/stat` whenever the entry is unknown, and the content tab is only offered for files.
- Reader: content mode no longer leaks into the next selection. The reader is remounted per selection; before,
  a stale effect could fire `/read` for the newly selected URI while the tab had already been reset.
- Reader: if the backend still reports "not readable as a file" (e.g. `stat` failed), the raw error is replaced
  by a directory hint and the content tab is withdrawn.

### Added
- Directories show a notice. A directory that holds exactly one file offers "Open <file>" to jump straight to it;
  otherwise it offers "Open directory".
- `manifest.json` `entry` carries `?v=<version>` so every release is a new script URL.
- Tests: `tests/dirs.test.cjs` (jsdom, every path that could read a directory) and API/manifest checks in pytest.

### Notes
- After updating, **reload the dashboard page** (F5 / hard refresh). The Hermes dashboard loads plugin scripts once
  per page load and never re-fetches them in an open tab, so a tab opened before the update keeps running the old
  code. The server itself sends `Cache-Control: no-store`, so a reload always gets the new script. The Python backend
  is unchanged in this release, so no dashboard restart is needed for it.

## [1.0.1] - 2026-10-05

### Fixed
- Reader: directories no longer offer the "content" tab. OpenViking stores every document as a directory
  (a file named `x.md` is really a folder containing `x.md`), so reading one failed with
  "Directory URI is not readable as a file". The reader now explains how to open the directory.

## [1.0.0] - 2026-10-05

Initial public release.

### Added
- Read-only OpenViking tab for the Hermes dashboard: status cards, lazy `viking://` tree browser,
  Abstract / Overview / Content reader, `find` / `grep` / `glob` search, session list and raw observer reports.
- Backend router that exposes a fixed whitelist of read-only OpenViking operations. No generic proxy.
- `viking://` URI validation (scheme, length, control characters, `..` segments, also when percent-encoded).
- API key resolution: `OPENVIKING_API_KEY`, then the `agent_user_key` field of the file named by
  `OPENVIKING_CREDENTIALS_FILE`, then `~/.openviking/credentials.json`. A clear 503 when none is found.
- `OPENVIKING_URL` setting (default `http://127.0.0.1:1933`).
- pytest suite for the API and a jsdom render test for the UI; GitHub Actions CI.
