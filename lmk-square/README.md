# LMK Square Integration

This project connects the existing Laboratori Massa Kritikal website (Cloudflare and GitHub) to Square through a Cloudflare Worker. Square is the one place you manage products: names, strengths, prices, images, and stock. The website reads from Square automatically.

| Square API | What it does here |
|---|---|
| Catalog | Syncs product names, strength variations (e.g. 5 mg / 10 mg), prices (including location price overrides), and images |
| Inventory | Syncs stock per strength. Out-of-stock strengths are disabled on the site, and stock is checked again live before checkout |
| Orders | Calculates cart totals (tax and discounts) from Square prices, then creates and tracks orders once checkout is enabled |
| Checkout | Creates a one-time, Square-hosted checkout session for the whole cart. No manually created payment links |

## Safety defaults

- **Credentials stay server-side.** The Square access token and webhook key are Cloudflare Worker secrets. They never go in GitHub, `wrangler.toml`, or browser code.
- **Sandbox first.** `SQUARE_ENV = "sandbox"` points every call at `connect.squareupsandbox.com`.
- **Checkout is off.** `CHECKOUT_ENABLED = "false"`. Visitors can browse and fill a cart, and the Checkout button shows "Online checkout is coming soon."
- **Live payments need two switches.** In production, checkout stays blocked unless `CHECKOUT_ENABLED` **and** `LIVE_PAYMENTS_APPROVED` are both `"true"`. Set `LIVE_PAYMENTS_APPROVED` only after Square confirms in writing that this catalog is eligible for processing.
- **The server decides prices.** The browser sends only item IDs and quantities. Prices, availability, and stock are always re-checked against Square.
- **Webhooks are verified.** Every Square notification's HMAC-SHA256 signature is checked, and duplicate events are ignored.

## Files

```
src/index.ts        Worker routes + 15-minute cron resync
src/catalog.ts      Catalog + Inventory sync -> cached snapshot (KV)
src/checkout.ts     Cart validation, Orders calculate, Checkout session, order status
src/webhooks.ts     Signed inventory/catalog webhooks
src/square.ts       Server-side Square client (pinned API version)
src/env.ts          Settings + checkout safety switches
public/lmk-square.js            Browser connector for your existing pages
public/example-product-page.html  Markup example using EXAMPLE data only
test/worker.test.ts             Offline tests (synthetic data)
.github/workflows/deploy-worker.yml  Test + deploy on push to main
```

## API routes

| Route | Purpose |
|---|---|
| `GET /api/catalog` | Public product snapshot (names, strengths, prices, stock, images, checkout status) |
| `POST /api/cart/quote` | Validates the cart and returns Square-calculated totals. Saves no order |
| `POST /api/checkout` | Creates a Square checkout session for the cart. Returns 503 while checkout is disabled |
| `GET /api/orders/:ref` | Order status for your order-complete page. Uses a random public reference, never the Square order ID |
| `POST /api/admin/sync` | Forces a full resync. Needs `Authorization: Bearer <ADMIN_TOKEN>` |
| `POST /api/square/webhook` | Receives Square inventory and catalog events |

## Setup (Sandbox)

1. **Square Developer Console** (developer.squareup.com): create an application. Under **Sandbox**, copy the Sandbox access token and a Sandbox location ID. Add a few test items with strength variations and stock in the Sandbox Square Dashboard.
2. **Add this folder to your GitHub repo**, either as its own repo or as a `worker/` folder next to your site.
3. **Create storage:** `npx wrangler kv namespace create LMK_STORE`, then paste the ID into `wrangler.toml`.
4. **Fill in `wrangler.toml` vars:** your Sandbox location ID, your site's origin in `ALLOWED_ORIGINS`, and the redirect and webhook URLs.
5. **Add secrets** (stored only in Cloudflare):
   ```
   npx wrangler secret put SQUARE_ACCESS_TOKEN
   npx wrangler secret put SQUARE_WEBHOOK_SIGNATURE_KEY
   npx wrangler secret put ADMIN_TOKEN
   ```
6. **Deploy:** `npm install && npm test && npx wrangler deploy`. For automatic deploys, add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub repository secrets. The included workflow tests and deploys on every push to `main`.
7. **Webhooks:** in the Developer Console (Sandbox), subscribe `https://<worker>/api/square/webhook` to `inventory.count.updated` and `catalog.version.updated`. Copy its signature key into the secret from step 5.
8. **First sync:** `curl -X POST -H "Authorization: Bearer <ADMIN_TOKEN>" https://<worker>/api/admin/sync`, then open `https://<worker>/api/catalog`.

## Connect your existing pages

Your design stays as it is. Add attributes to the elements you already have (see `public/example-product-page.html`):

- On each product card: `data-lmk-product="<exact Square item name>"`, plus `data-lmk-strength` on the strength `<select>`, `data-lmk-qty` on the quantity input, `data-lmk-price`, `data-lmk-stock`, and `data-lmk-add` on the button.
- On the cart: `data-lmk-cart-count`, `data-lmk-cart-lines`, `data-lmk-cart-subtotal`, `data-lmk-cart-tax`, `data-lmk-cart-total`, `data-lmk-cart-message`, `data-lmk-checkout`.
- Before `</body>`: `<script src="/lmk-square.js" data-api="https://<worker>" defer></script>`

Strength options are filled from the variation names in Square, so a variation named "10 mg" shows as "10 mg". Product images can stay your current images. Square image URLs are also included in the catalog data if you want to use them. Cart rows use `lmk-cart-*` classes, so you can style them to match your current cart.

## Test checkout in Sandbox only

Set `CHECKOUT_ENABLED = "true"` while `SQUARE_ENV = "sandbox"`, then use Square's Sandbox test cards. No real money moves.

## Going live (only after Square confirms eligibility)

1. Get written confirmation from Square that this specific catalog is eligible for processing.
2. Switch to production credentials and a production location ID. Set `SQUARE_ENV = "production"` and use a production webhook subscription and key.
3. Run catalog and inventory sync in production with `CHECKOUT_ENABLED = "false"` first.
4. Only then set `CHECKOUT_ENABLED = "true"` and `LIVE_PAYMENTS_APPROVED = "true"`.
