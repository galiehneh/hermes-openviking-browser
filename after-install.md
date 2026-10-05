## OpenViking Browser installed

The **OPENVIKING** tab (`/openviking`) is read-only.

1. Make sure `plugins.enabled` in the Hermes config contains `openviking-browser`
   (`hermes plugins enable openviking-browser`).
2. Give the plugin an OpenViking key and, if the server is not on this machine, its URL
   (add to `~/.hermes/.env`):

   ```bash
   OPENVIKING_URL=http://127.0.0.1:1933
   OPENVIKING_API_KEY=<a user-level OpenViking key, not an admin/root key>
   ```

   Alternatively point `OPENVIKING_CREDENTIALS_FILE` (or `~/.openviking/credentials.json`) at a JSON file
   with an `agent_user_key` field.
3. Restart the dashboard once: the backend router is mounted at startup (a rescan only refreshes the tab list).
4. Open the dashboard and click **OPENVIKING**.

If the tab shows "503", no key was found. If it shows "502", the plugin could not reach OpenViking or the key
was rejected. See the README troubleshooting section.
