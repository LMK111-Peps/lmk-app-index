import { getSnapshot, fetchStock, type Product, type Variation } from './catalog';
import { checkoutState, type Env } from './env';
import { square, SquareError, type Money } from './square';

export interface CartLine { variationId: string; quantity: number }
export interface CheckedLine { variationId: string; productName: string; strength: string; quantity: number; unitPrice: Money }

export class CartError extends Error {
  constructor(public code: string, message: string, public variationId?: string) {
    super(message);
    this.name = 'CartError';
  }
}

const MAX_LINES = 50;
const MAX_QTY = 99;

/** Parses untrusted cart input. Prices from the browser are ignored entirely. */
export function parseCart(input: unknown): CartLine[] {
  const lines = (input as { lines?: unknown })?.lines;
  if (!Array.isArray(lines) || lines.length === 0) throw new CartError('EMPTY_CART', 'Your cart is empty.');
  if (lines.length > MAX_LINES) throw new CartError('TOO_MANY_LINES', 'Too many items in cart.');
  const merged = new Map<string, number>();
  for (const l of lines) {
    const id = (l as any)?.variationId;
    const q = Number((l as any)?.quantity);
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new CartError('BAD_ITEM', 'Invalid item.');
    if (!Number.isInteger(q) || q < 1 || q > MAX_QTY) throw new CartError('BAD_QUANTITY', 'Invalid quantity.', id);
    merged.set(id, (merged.get(id) ?? 0) + q);
  }
  return [...merged].map(([variationId, quantity]) => {
    if (quantity > MAX_QTY) throw new CartError('BAD_QUANTITY', 'Invalid quantity.', variationId);
    return { variationId, quantity };
  });
}

function index(products: Product[]): Map<string, { product: Product; variation: Variation }> {
  const m = new Map<string, { product: Product; variation: Variation }>();
  for (const product of products) for (const variation of product.variations) m.set(variation.id, { product, variation });
  return m;
}

/** Validates a cart against the synced catalog and live Square stock. */
export async function validateCart(env: Env, lines: CartLine[]): Promise<CheckedLine[]> {
  const snap = await getSnapshot(env);
  const byId = index(snap.products);
  const tracked = lines.filter((l) => byId.get(l.variationId)?.variation.trackInventory).map((l) => l.variationId);
  const live = tracked.length ? await fetchStock(env, tracked) : new Map<string, number>();
  return lines.map((l) => {
    const hit = byId.get(l.variationId);
    if (!hit || !hit.variation.price) throw new CartError('UNAVAILABLE', 'An item in your cart is no longer available.', l.variationId);
    if (hit.variation.trackInventory) {
      const have = live.get(l.variationId) ?? 0;
      if (have < l.quantity) throw new CartError('INSUFFICIENT_STOCK', `Only ${have} left of ${hit.product.name} ${hit.variation.name}.`, l.variationId);
    }
    return {
      variationId: l.variationId,
      productName: hit.product.name,
      strength: hit.variation.name,
      quantity: l.quantity,
      unitPrice: hit.variation.price,
    };
  });
}
/**
 * Calculate cart totals using Square's Orders API.
 * Automatically applies catalog taxes.
 * Does not create an order or process a payment.
 */
export async function quoteCart(
  env: Env,
  lines: CartLine[]
): Promise<{
  lines: CheckedLine[];
  total: Money;
  tax: Money;
  checkout: ReturnType<typeof checkoutState>;
}> {
  // Validate cart items and available inventory.
  const checked = await validateCart(env, lines);

  // Ask Square to calculate the order total.
  const res = await square<{
    order: {
      total_money: Money;
      total_tax_money: Money;
    };
  }>(
    env,
    'POST',
    '/v2/orders/calculate',
    {
      order: {
        location_id: env.SQUARE_LOCATION_ID,

        line_items: checked.map((line) => ({
          catalog_object_id: line.variationId,
          quantity: String(line.quantity),
        })),

        // Apply taxes associated with catalog items.
        pricing_options: {
          auto_apply_taxes: true,
        },
      },
    }
  );

  // Return Square's calculated amounts.
  return {
    lines: checked,
    total: res.order.total_money,
    tax: res.order.total_tax_money,
    checkout: checkoutState(env),
  };
}


function randomToken(bytes = 18): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Checkout API: creates a one-time Square-hosted checkout session for this cart.
 * Refuses unless checkout is explicitly enabled (and, in production, live payments are approved).
 */
export async function createCheckout(env: Env, lines: CartLine[], idempotencyKey: string): Promise<{ checkoutUrl: string; orderRef: string }> {
  const state = checkoutState(env);
  if (!state.enabled) throw new CartError('CHECKOUT_DISABLED', 'Online checkout is not available yet.');
  if (!/^[A-Za-z0-9-]{16,64}$/.test(idempotencyKey)) throw new CartError('BAD_REQUEST', 'Missing checkout key.');

  // Reuse the session if the browser retries the same checkout attempt.
  const prior = (await env.LMK_STORE.get(`idem:${idempotencyKey}`, 'json')) as { checkoutUrl: string; orderRef: string } | null;
  if (prior) return prior;

  const checked = await validateCart(env, lines);
  const orderRef = randomToken();
  const body: Record<string, unknown> = {
    idempotency_key: idempotencyKey,
    order: {
      location_id: env.SQUARE_LOCATION_ID,
      reference_id: orderRef.slice(0, 40),
      line_items: checked.map((l) => ({ catalog_object_id: l.variationId, quantity: String(l.quantity) })),
    },
    checkout_options: {
      ask_for_shipping_address: true,
      ...(env.CHECKOUT_REDIRECT_URL ? { redirect_url: `${env.CHECKOUT_REDIRECT_URL}?order=${orderRef}` } : {}),
    },
  };
  let res: { payment_link: { url: string; order_id: string } };
  try {
    res = await square(env, 'POST', '/v2/online-checkout/payment-links', body);
  } catch (e) {
    if (e instanceof SquareError) throw new CartError('CHECKOUT_FAILED', 'Checkout could not be started. Please try again.');
    throw e;
  }
  const result = { checkoutUrl: res.payment_link.url, orderRef };
  // Public order reference -> Square order ID. The Square ID is never sent to the browser.
  await env.LMK_STORE.put(`order:${orderRef}`, JSON.stringify({ orderId: res.payment_link.order_id, createdAt: new Date().toISOString() }), { expirationTtl: 60 * 60 * 24 * 180 });
  await env.LMK_STORE.put(`idem:${idempotencyKey}`, JSON.stringify(result), { expirationTtl: 60 * 60 * 24 });
  return result;
}

/** Orders API: buyer-safe order status for the order-complete page. */
export async function orderStatus(env: Env, orderRef: string): Promise<{ status: string; paid: boolean; total: Money | null; fulfillment: string | null } | null> {
  if (!/^[a-f0-9]{36}$/.test(orderRef)) return null;
  const rec = (await env.LMK_STORE.get(`order:${orderRef}`, 'json')) as { orderId: string } | null;
  if (!rec) return null;
  const res = await square<{ order: { state: string; total_money?: Money; tenders?: unknown[]; net_amount_due_money?: Money; fulfillments?: { state?: string }[] } }>(env, 'GET', `/v2/orders/${encodeURIComponent(rec.orderId)}`);
  const o = res.order;
  const paid = Array.isArray(o.tenders) && o.tenders.length > 0 && (o.net_amount_due_money?.amount ?? 0) === 0;
  return { status: o.state, paid, total: o.total_money ?? null, fulfillment: o.fulfillments?.[0]?.state ?? null };
}
