# Contributing

Issues and pull requests are welcome.

## Ground rules

- **Read-only is a hard requirement.** Do not add routes that write, delete or administer anything in OpenViking.
  New read operations must be added to the `_UPSTREAM` table in `dashboard/api.py` and covered by tests.
- Never log, return or commit an API key. Tests use fake keys and mocked upstreams only.
- Keep the plugin dependency-free on the frontend (no CDN, no build step) and use only what Hermes already provides
  on the backend (`fastapi`, `httpx`, `pydantic`).

## Development

```bash
pip install -r requirements-dev.txt
python -m pytest tests -q

npm install
npm test
```

Both suites must pass before you open a PR. Use [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `ci:`) for commit messages.
