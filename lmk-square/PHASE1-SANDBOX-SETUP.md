# LMK Square — Phase 1 Sandbox Synchronization

**Scope:** Read-only Square Sandbox catalog and inventory sync. No payments, checkout, orders, cart quotes, or edits to the existing LMK website or AI Research Worker.

## Safety gates

- Worker: `lmk-square`, separately deployed from the LMK website and AI Research Worker.
- `SQUARE_ENV = "sandbox"`, `SYNC_ONLY_MODE = "true"`, `CHECKOUT_ENABLED = "false"`, `LIVE_PAYMENTS_APPROVED = "false"`.
- Worker rejects all requests if `SQUARE_ENV` is production.
- Order lookup, quote, and checkout endpoints return HTTP 503 in sync-only mode, without contacting Square.
- Do not merge or deploy until tests and permissions have been reviewed. Do not enable Square commerce for restricted products without confirming processor and legal eligibility.

## Cloudflare setup — requires authenticated dashboard or Wrangler

1. In Cloudflare Workers, create a **new** Worker `lmk-square`. Do not overwrite the existing website or AI Worker.
2. Create a distinct KV namespace `LMK_SQUARE_STORE_SANDBOX` and set the resulting ID under `[[kv_namespaces]]` in this folder's `wrangler.toml`. Binding name remains `LMK_STORE`.
3. In the Square Developer Console, use only **Sandbox** credentials. Create a sandbox location and synthetic catalog items with variations and stock values.
4. Replace `SQUARE_LOCATION_ID` with the **sandbox** location ID. Replace `ALLOWED_ORIGINS` with the trusted website origin. Do not modify Products page scripts yet.
5. Set Worker secrets (not repository files): `SQUARE_ACCESS_TOKEN` (Sandbox), `ADMIN_TOKEN` (random 32+ bytes), and `SQUARE_WEBHOOK_SIGNATURE_KEY` when webhook subscriptions are ready. Confirm no credentials appear in logs or source control.
6. If using webhooks, use the exact Sandbox webhook URL for `SQUARE_WEBHOOK_URL` and verify signature before accepting any event.
7. Keep deployment CI disabled/unconfigured until verification. Avoid GitHub workflows that automatically deploy to production when merging.

## Tests before any website integration

- `npm ci` if lockfile exists, otherwise `npm install`; then `npm test` and `npm run typecheck` in `lmk-square/`.
- GET `/api/status`: environment=sandbox and checkout.enabled=false.
- GET `/api/catalog`: returns only synthetic Sandbox products, variation IDs, price overrides, images, and inventory; no credentials.
- Change Sandbox stock and run POST `/api/admin/sync` with `Authorization: Bearer <ADMIN_TOKEN>`; verify catalog changes.
- Check zero-stock variations show unavailable.
- POST `/api/checkout` and `/api/cart/quote`, and GET `/api/orders/test`: HTTP 503.
- Confirm no changes to `index.html`, `products.html`, website deployment, or the AI Research Worker.

## Acceptance criteria

Catalog and inventory sync are demonstrated against actual Square Sandbox data and independent Cloudflare KV, all commerce endpoints stay disabled, secrets remain in Cloudflare, and the current LMK website and AI Research Worker stay unchanged.

**Current status:** GitHub implementation branch prepared; Cloudflare Worker, Square Sandbox credentials, KV namespace, and live Sandbox tests are *not yet configured or verified*.
