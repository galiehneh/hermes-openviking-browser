# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

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
