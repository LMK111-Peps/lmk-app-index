import { getSnapshot, syncCatalog } from './catalog';
import { CartError, createCheckout, orderStatus, parseCart, quoteCart } from './checkout';
import { checkoutState, isProduction, type Env, type ExecutionContext } from './env';
import { handleWebhook } from './webhooks';

function cors(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (origin && allowed.includes(origin)) {
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
  }
  return {};
}

function json(data: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
}

async function readJson(request: Request): Promise<unknown> {
  const len = Number(request.headers.get('Content-Length') ?? '0');
  if (len > 32_000) throw new CartError('TOO_LARGE', 'Request too large.');
  const text = await request.text();
  if (text.length > 32_000) throw new CartError('TOO_LARGE', 'Request too large.');
  try { return JSON.parse(text); } catch { throw new CartError('BAD_REQUEST', 'Invalid request.'); }
}

function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return true; // same-origin form posts and server tools
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return allowed.includes(origin) || origin === new URL(request.url).origin;
}

function isAdmin(request: Request, env: Env): boolean {
  const auth = request.headers.get('Authorization') ?? '';
  return !!env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 24 && auth === `Bearer ${env.ADMIN_TOKEN}`;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const h = cors(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });

    try {
      // During phase one, absolutely no production Square API access is permitted.
      if (isProduction(env)) return json({ error: 'SANDBOX_ONLY' }, 503, h);
      // Even in sandbox, purchasing, quotes, and order lookup are unavailable.
      if (url.pathname === '/api/cart/quote' ||
          url.pathname === '/api/checkout' ||
          url.pathname.startsWith('/api/orders/')) {
        return json({ error: 'SYNC_ONLY_MODE' }, 503, h);
      }
      if (url.pathname === '/api/square/webhook' && request.method === 'POST') return handleWebhook(request, env, ctx);

      if (url.pathname === '/api/catalog' && request.method === 'GET') {
        const snap = await getSnapshot(env);
        return json({ ...snap, checkout: checkoutState(env) }, 200, { ...h, 'Cache-Control': 'public, max-age=30' });
      }

      if (url.pathname === '/api/status' && request.method === 'GET') {
        return json({ environment: isProduction(env) ? 'production' : 'sandbox', checkout: checkoutState(env) }, 200, h);
      }

      if (url.pathname === '/api/cart/quote' && request.method === 'POST') {
        if (!originAllowed(request, env)) return json({ error: 'FORBIDDEN' }, 403, h);
        const quote = await quoteCart(env, parseCart(await readJson(request)));
        return json(quote, 200, h);
      }

      if (url.pathname === '/api/checkout' && request.method === 'POST') {
        if (!originAllowed(request, env)) return json({ error: 'FORBIDDEN' }, 403, h);
        const state = checkoutState(env);
        if (!state.enabled) return json({ error: 'CHECKOUT_DISABLED', reason: state.reason }, 503, h);
        const lines = parseCart(await readJson(request));
        const result = await createCheckout(env, lines, request.headers.get('Idempotency-Key') ?? '');
        return json(result, 200, h);
      }

      if (url.pathname.startsWith('/api/orders/') && request.method === 'GET') {
        const status = await orderStatus(env, url.pathname.slice('/api/orders/'.length));
        return status ? json(status, 200, h) : json({ error: 'NOT_FOUND' }, 404, h);
      }

      if (url.pathname === '/api/admin/sync' && request.method === 'POST') {
        if (!isAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401, h);
        const snap = await syncCatalog(env);
        const variations = snap.products.reduce((n, p) => n + p.variations.length, 0);
        return json({ syncedAt: snap.syncedAt, environment: snap.environment, products: snap.products.length, variations }, 200, h);
      }

      if (url.pathname.startsWith('/api/')) return json({ error: 'NOT_FOUND' }, 404, h);
      return new Response('Not found', { status: 404 });
    } catch (e) {
      if (e instanceof CartError) {
        const status = e.code === 'CHECKOUT_DISABLED' ? 503 : e.code === 'TOO_LARGE' ? 413 : 409;
        return json({ error: e.code, message: e.message, variationId: e.variationId }, status, h);
      }
      console.error('Unhandled error:', e instanceof Error ? `${e.name}: ${e.message}` : 'unknown');
      return json({ error: 'SERVER_ERROR', message: 'Something went wrong. Please try again.' }, 500, h);
    }
  },

  /** Cron trigger: full catalog + inventory resync as a safety net behind webhooks. */
  async scheduled(_event: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    if (isProduction(env)) return;
    ctx.waitUntil(syncCatalog(env).then(() => undefined));
  },
};
