# VetTranslate

Veterinary-clinic translator (UI in Russian) built by Elena. Reply to the user in the language they write in.

## Architecture

- `index.html` — the whole site (HTML + CSS + JS in one file). Served by GitHub Pages at https://elenabittt.github.io from the `main` branch of `elenabittt/elenabittt.github.io`.
- `worker/` — Cloudflare Worker `vettranslate-api` that proxies translation requests to Google Gemini. The API key lives only as a Worker secret (`GEMINI_API_KEY`); never put any API key in `index.html` or anywhere in this public repo.
- `vet-translate.html` — old version, not linked from the site.

## Making changes (the user just describes what they want)

1. Edit `index.html` (site) or `worker/src/index.js` (translation backend / prompt / model).
2. Site changes: commit with a short descriptive message and `git push origin main`. GitHub Pages redeploys in ~1 minute; confirm with `gh api repos/elenabittt/elenabittt.github.io/pages/builds/latest --jq .status` and then fetch the live URL.
3. Worker changes: commit and push too — `.github/workflows/deploy-worker.yml` deploys `worker/` to Cloudflare on every push that touches it (or run `gh workflow run deploy-worker.yml`). Check with `gh run list --workflow deploy-worker.yml`. Required repo secrets (set by Elena in GitHub → Settings → Secrets and variables → Actions): `CLOUDFARE_API_TOKEN`, `CLOUDFARE_ACCOUNT_ID` (spelled without the L, intentionally matched in the workflow), `GEMINI_API_KEY`. Then smoke-test:
   `curl -s -X POST https://<worker-url>/translate -H 'Origin: https://elenabittt.github.io' -H 'Content-Type: application/json' -d '{"text":"Хромота","target":"немецкий"}'`
4. Always `git pull` before editing — Elena may also upload files through the GitHub web UI.

## Notes

- Phrase cards (with favorites) are shared: stored in the Worker's `CardStore` Durable Object (`GET/POST /cards`). Viewing is public; edits need the `EDIT_PASSWORD` secret (asked once per device, kept in `localStorage`; 10 wrong tries → 15 min lockout). `DEFAULT_CARDS` in `index.html` only seed the store on the very first edit — to change cards that already exist, edit them on the site (or via `POST /cards`), not in `DEFAULT_CARDS`.
- Old versions kept cards only in each browser (`localStorage` key `vet-translate-cards`); the site offers to merge those into the server once and keeps a `-backup` copy. Extra languages and mic language stay per-device.
- GitHub Pages caches `index.html` for up to 10 minutes, so code changes can take that long to show on reload.
- Model is set by `GEMINI_MODEL` in `worker/wrangler.toml` (`gemini-flash-lite-latest` alias), with `GEMINI_FALLBACK_MODELS` tried on 429/5xx. Free-tier models get overloaded; pinned versions get retired (404), so prefer the `-latest` aliases. Switching to Claude later means changing only the Worker.
