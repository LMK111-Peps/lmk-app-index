import { applyStockUpdates, syncCatalog } from './catalog';
import type { Env, ExecutionContext } from './env';
import type { InventoryCount } from './square';

/** Square signs notification URL + raw body with HMAC-SHA256 (base64). */
export async function verifySquareSignature(key: string, url: string, body: string, signature: string | null): Promise<boolean> {
  if (!signature) return false;
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(url + body)));
  let bin = '';
  for (const b of mac) bin += String.fromCharCode(b);
  const expected = btoa(bin);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export async function handleWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.SQUARE_WEBHOOK_SIGNATURE_KEY || !env.SQUARE_WEBHOOK_URL) return new Response('Webhooks not configured', { status: 503 });
  const body = await request.text();
  const ok = await verifySquareSignature(env.SQUARE_WEBHOOK_SIGNATURE_KEY, env.SQUARE_WEBHOOK_URL, body, request.headers.get('x-square-hmacsha256-signature'));
  if (!ok) return new Response('Invalid signature', { status: 401 });

  let event: any;
  try { event = JSON.parse(body); } catch { return new Response('Bad JSON', { status: 400 }); }

  // Square may redeliver events; ignore ones already handled.
  const seenKey = `evt:${String(event.event_id ?? '')}`;
  if (event.event_id && (await env.LMK_STORE.get(seenKey))) return new Response('ok');
  if (event.event_id) await env.LMK_STORE.put(seenKey, '1', { expirationTtl: 60 * 60 * 24 * 3 });

  switch (event.type) {
    case 'inventory.count.updated': {
      const counts: InventoryCount[] = event.data?.object?.inventory_counts ?? [];
      ctx.waitUntil(applyStockUpdates(env, counts));
      break;
    }
    case 'catalog.version.updated':
      ctx.waitUntil(syncCatalog(env));
      break;
    default:
      // order.* and payment.* events can be handled here once live checkout is approved.
      break;
  }
  return new Response('ok');
}
