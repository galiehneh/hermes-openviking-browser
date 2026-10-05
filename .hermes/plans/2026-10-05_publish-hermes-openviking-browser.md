# Plan Publikasi: hermes-openviking-browser

**Status repo (FACT, dicek via gh/git):** publik, MIT, release v1.0.2 (Latest), 4 topics, issues aktif, CI workflow ada, SECURITY/CONTRIBUTING/CHANGELOG/README(205 baris, screenshot) ada, working tree bersih & sync origin/main. Tidak ada secret/IP internal di source.
**Gap (FACT):** homepage URL kosong; hanya 4 topics; tidak ada tag/rilis aturan promosi; belum ada listing di direktori.

Tujuan: dari "publik" → "ditemukan & dipakai", tanpa merusak kualitas.

## Fase 0 — Gate sebelum promosi (konfirmasi user: bug-free)
1. Cek CI hijau di main: `gh run list -R galiehneh/hermes-openviking-browser -L 3`
2. Clean-install test di host bersih/profil lain: ikuti README "Install" apa adanya, tab muncul, status/tree/read/search jalan.
3. Audit akhir (Claude Code opusplan): secret leak, path traversal, read-only guarantee.
4. `git grep -nE '172\.16|100\.79|/root/'` → pastikan bersih (cek terakhir hanya hit test/pycache).
5. **Persetujuan eksplisit user** sebelum fase 1+.

## Fase 1 — Polish repo (rendah risiko)
- Topics tambah: `hermes-plugin`, `nous-research`, `knowledge-base`, `memory`, `readonly`, `dashboard`.
- Description/homepage: homepage → URL releases atau README anchor.
- Social preview image (1280×640) dari screenshot.jpg.
- README: badge CI + release + license di atas; GIF/screenshot 2nd (search & tree); bagian "Quick start 3 baris".
- Pastikan release notes v1.0.2 menyertakan catatan "reload dashboard (F5)".
- Aktifkan GitHub Discussions (opsional) + issue templates (bug/feature).
- Cek `.gitignore` agar `node_modules`, `__pycache__`, `.pytest_cache` tidak masuk (sudah ada .gitignore; verifikasi `git ls-files`).

## Fase 2 — Distribusi (urut prioritas)
1. **awesome-hermes-skills** (ZeroPointRepo): fork → tambah entri plugin → PR. Cek format CONTRIBUTING mereka dulu.
2. **OpenViking**: buka Discussion/Issue di repo upstream (volcengine/OpenViking) sebagai "community plugin/dashboard"; link README. Sebutkan relasi ke `hermes-plugin-openviking` (sudah ada di README).
3. **Hermes Agent**: Discord/Discussions Nous Research — post singkat + screenshot + 1 command install. Cek apakah ada plugin registry/docs "community plugins" di hermes-agent-docs; kalau ada → PR.
4. Opsional: Reddit r/LocalLLaMA / r/selfhosted, X/Twitter, Hacker News (Show HN) — hanya jika user mau; HN butuh demo hidup/gif.

## Fase 3 — Draft post (siap pakai)
Judul: "OpenViking Browser — Obsidian-style read-only tab for Hermes dashboard"
Isi: 3 bullet fitur (tree viking://, reader abstract/overview/content, search find/grep/glob), 1 bullet security (API key server-side, read-only), install one-liner, link repo + screenshot.

## Fase 4 — Pasca publikasi
- Pantau issues/PR 7 hari; SLA balasan ≤48 jam.
- Release rutin: versi `X.Y.Z`, update CHANGELOG, tag, `gh release create`.
- Metrik: stars, clones/views (`gh api repos/galiehneh/hermes-openviking-browser/traffic/views`).
- Roadmap publik di README (mis. dark mode, pagination hasil search, i18n).

## Risiko
- Promosi sebelum clean-install test → kesan buruk (mitigasi: Fase 0).
- Dependensi ke versi OpenViking/Hermes tertentu → dokumentasikan versi tested di Requirements.
- Dashboard cache plugin JS (sudah didokumentasikan di Notes v1.0.2).
- Spam di komunitas → posting 1 kanal per kanal, ikuti aturan self-promo.

## Open questions
1. Kanal mana yang mau dipakai (Discord Hermes, Reddit, X, HN)?
2. Bahasa post: Inggris (disarankan) atau juga Indonesia?
3. Apakah nama/handle `galiehneh` yang dipakai untuk semua kanal?
