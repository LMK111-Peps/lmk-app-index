# LMK Commerce and Inventory — development only

## Current status
This branch provides the initial D1 schema, **not a functioning checkout or deployed payment integration**. No live site HTML, navigation, catalog, or Cloudflare production environment was changed.

## Product and processor review is mandatory
Do not offer an item for checkout until counsel has confirmed the specific product, intended purchasers, claims, labeling, shipping jurisdictions, and federal/state requirements. Obtain **written payment-processor approval** describing the actual catalog and business model; a generic processor signup is not approval of investigational peptides. A "research use only" label and an age gate do not, by themselves, establish legal eligibility.

Products start as `review_required` with `checkout_enabled=0`. Only separately vetted SKUs may become `approved_for_sale` and checkout-enabled. Investigational retatrutide and other questionable SKUs must not be auto-enabled.

Reference policy sources:
- FDA: https://www.fda.gov/drugs/postmarket-drug-safety-information-patients-and-providers/fdas-concerns-unapproved-glp-1-drugs-used-weight-loss
- Stripe peptide guidance: https://support.stripe.com/questions/prohibited-and-restricted-businesses-list-faqs
- Stripe restricted-business terms: https://stripe.com/legal/restricted-businesses

## Intended operational flows (not implemented yet)
1. Import existing SKU/variant counts as a verified opening balance. Avoid inserting remembered inventory quantities without reconciliation.
2. Admin-authenticated receiving, adjustment, damage, and returns produce append-only inventory movement records.
3. For an eligible SKU only, a server-side checkout request validates the SKU, price, quantity, available stock, purchase restrictions and fulfillment jurisdiction. Never trust browser prices.
4. Reserve available stock atomically via a conditional SQL UPDATE, then create an order/line item and checkout session using a provider-issued secret stored in a Cloudflare Worker secret. Do not expose it to browser JavaScript.
5. Verify the payment provider webhook signature against raw request bytes and deduplicate on `(provider,event_id)`. Only a verified successful payment transitions an order to paid; expiration/cancellation releases reserved stock.
6. Fulfillment decrements on-hand and releases the related reservation **exactly once**, recording the movement and reference. Support refund/cancellation, audit logs and retries.
7. Apply access controls, data minimization, backup strategy, sales tax/shipping rules and retention schedules. Payment-card data stays with the approved payment processor.

## Deployment requirements
Separate commerce Cloudflare Worker + separate D1 database; separate staging/production secrets; authenticated admin interface; atomic inventory test suite; processor approvals and test-mode webhook handling. Do not attach this schema directly to the AI research D1 or deploy it to the main LMK site as a payment system.
