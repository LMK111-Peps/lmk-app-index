# LMK Production inventory reader (prelaunch)

Isolated Cloudflare Worker that **reads** Production catalog and tracked stock.
**No payment, order, inventory write or checkout routes are implemented.**

The Square personal production access token may have broader rights than this Worker.
Keep the token as a Cloudflare secret and limit who can edit/deploy the Worker.

## Setup (in Cloudflare)

1. Create a NEW Worker named `lmk-square-inventory`. Do not reuse `lmk-square`.
2. Connect GitHub repository `LMK111-Peps/lmk-app-index`.
   Branch: `square-sandbox-sync-only`. Root directory: `lmk-square-inventory`.
   Deploy command: `npx wrangler versions upload`.
3. Add two **encrypted secrets**, not plain variables:
   - `SQUARE_PRODUCTION_ACCESS_TOKEN`: from Square Developer Console > LMK-Website > Production > Credentials.
   - `INVENTORY_READ_TOKEN`: a newly generated long random secret (32+ chars), distinct from the Square token.
4. Upload the Worker and promote **only this new Worker** once the secrets are configured.
5. In Terminal, export `INVENTORY_READ_TOKEN` privately, then call:
   `curl -sS -H "Authorization: Bearer $INVENTORY_READ_TOKEN" https://lmk-square-inventory.<YOUR-CLOUDFLARE-SUBDOMAIN>.workers.dev/api/locations`
   (Do not share the secret or paste it into a web page.)
6. Configure a non-secret Worker variable `SQUARE_PRODUCTION_LOCATION_ID` to the correct returned location ID, upload/promote a version if required, then call protected `/api/catalog`.

Only `GET /health` is publicly accessible; it contains no product information.
All catalog and inventory details require authentication and do not grant browser CORS access.
The website must NOT call this service with its secret from frontend JavaScript.
Next phase: implement a reviewed, public-safe cache/proxy for staging after
checking Square SKUs and matching products. Keep prelaunch commerce disabled
until at least 2027-01-01 and all regulatory/payment approvals are satisfied.
