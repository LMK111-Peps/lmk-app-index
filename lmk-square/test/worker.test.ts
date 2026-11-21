import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildSnapshot } from '../src/catalog.ts';
import { checkoutState, type Env } from '../src/env.ts';
import { CartError, parseCart } from '../src/checkout.ts';
import { verifySquareSignature } from '../src/webhooks.ts';
import worker from '../src/index.ts';

// Synthetic fixtures only (no real Square data).
const LOC = 'LOC_TEST';
function memKV() {
  const m = new Map<string, string>();
  return {
    async get(k: string, t?: string) { const v = m.get(k) ?? null; return t === 'json' && v ? JSON.parse(v) : v; },
    async put(k: string, v: string) { m.set(k, v); },
    async delete(k: string) { m.delete(k); },
  } as any;
}
const baseEnv = (over: Partial<Env> = {}): Env => ({ SQUARE_ACCESS_TOKEN: 'x', SQUARE_LOCATION_ID: LOC, LMK_STORE: memKV(), ...over });

const objects: any[] = [
  { type: 'IMAGE', id: 'IMG1', image_data: { url: 'https://img.example/1.jpg' } },
  { type: 'ITEM', id: 'IT1', present_at_all_locations: true, item_data: { name: 'Example Compound', image_ids: ['IMG1'], variations: [
    { type: 'ITEM_VARIATION', id: 'V5', present_at_all_locations: true, item_variation_data: { name: '5 mg', ordinal: 1, pricing_type: 'FIXED_PRICING', price_money: { amount: 4500, currency: 'USD' }, track_inventory: true } },
    { type: 'ITEM_VARIATION', id: 'V10', present_at_all_locations: true, item_variation_data: { name: '10 mg', ordinal: 2, pricing_type: 'FIXED_PRICING', price_money: { amount: 8000, currency: 'USD' }, track_inventory: true, location_overrides: [{ location_id: LOC, price_money: { amount: 7500, currency: 'USD' } }] } },
    { type: 'ITEM_VARIATION', id: 'VVAR', present_at_all_locations: true, item_variation_data: { name: 'Custom', ordinal: 3, pricing_type: 'VARIABLE_PRICING' } },
  ] } },
  { type: 'ITEM', id: 'IT2', present_at_all_locations: false, present_at_location_ids: ['OTHER'], item_data: { name: 'Elsewhere', variations: [] } },
  { type: 'ITEM', id: 'IT3', present_at_all_locations: true, item_data: { name: 'Archived', is_archived: true, variations: [] } },
];

test('snapshot maps strengths, prices, overrides, stock and images', () => {
  const snap = buildSnapshot(baseEnv(), objects, new Map([['V5', 3]]));
  assert.equal(snap.products.length, 1);
  const p = snap.products[0];
  assert.deepEqual(p.images, ['https://img.example/1.jpg']);
  assert.deepEqual(p.variations.map((v) => v.name), ['5 mg', '10 mg', 'Custom']);
  assert.equal(p.variations[0].stock, 3);
  assert.equal(p.variations[0].available, true);
  assert.equal(p.variations[1].price?.amount, 7500, 'location price override wins');
  assert.equal(p.variations[1].available, false, 'tracked with no count = sold out');
  assert.equal(p.variations[2].price, null);
  assert.equal(p.variations[2].available, false, 'variable price not sold online');
});

test('checkout is off by default and production needs the second switch', () => {
  assert.deepEqual(checkoutState(baseEnv()), { enabled: false, reason: 'checkout_disabled' });
  assert.equal(checkoutState(baseEnv({ CHECKOUT_ENABLED: 'true' })).enabled, true, 'sandbox may test checkout');
  assert.deepEqual(checkoutState(baseEnv({ CHECKOUT_ENABLED: 'true', SQUARE_ENV: 'production' })), { enabled: false, reason: 'live_payments_not_approved' });
  assert.equal(checkoutState(baseEnv({ CHECKOUT_ENABLED: 'true', SQUARE_ENV: 'production', LIVE_PAYMENTS_APPROVED: 'true' })).enabled, true);
});

test('cart parser ignores prices and rejects bad input', () => {
  assert.deepEqual(parseCart({ lines: [{ variationId: 'V5', quantity: 2, price: 1 }, { variationId: 'V5', quantity: 1 }] }), [{ variationId: 'V5', quantity: 3 }]);
  assert.throws(() => parseCart({ lines: [] }), CartError);
  assert.throws(() => parseCart({ lines: [{ variationId: 'V5', quantity: 0 }] }), CartError);
  assert.throws(() => parseCart({ lines: [{ variationId: 'V5', quantity: 1.5 }] }), CartError);
  assert.throws(() => parseCart({ lines: [{ variationId: '<script>', quantity: 1 }] }), CartError);
});

test('webhook signature verification', async () => {
  const key = 'test-key', url = 'https://w.example/api/square/webhook', body = '{"a":1}';
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = Buffer.from(await crypto.subtle.sign('HMAC', k, enc.encode(url + body))).toString('base64');
  assert.equal(await verifySquareSignature(key, url, body, sig), true);
  assert.equal(await verifySquareSignature(key, url, body + ' ', sig), false);
  assert.equal(await verifySquareSignature(key, url, body, null), false);
});

test('checkout endpoint refuses while disabled, without calling Square', async () => {
  const orig = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => { called = true; throw new Error('no network'); }) as any;
  try {
    const res = await worker.fetch(new Request('https://w.example/api/checkout', { method: 'POST', body: '{"lines":[{"variationId":"V5","quantity":1}]}' }), baseEnv({ SQUARE_ENV: 'production', CHECKOUT_ENABLED: 'true' }), { waitUntil() {} });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).reason, 'live_payments_not_approved');
    assert.equal(called, false);
  } finally { globalThis.fetch = orig; }
});

test('admin sync requires token; unknown routes 404; cross-origin quote blocked', async () => {
  const env = baseEnv({ ADMIN_TOKEN: 'a'.repeat(32), ALLOWED_ORIGINS: 'https://shop.example' });
  const ctx = { waitUntil() {} };
  assert.equal((await worker.fetch(new Request('https://w.example/api/admin/sync', { method: 'POST' }), env, ctx)).status, 401);
  assert.equal((await worker.fetch(new Request('https://w.example/api/nope'), env, ctx)).status, 404);
  const q = await worker.fetch(new Request('https://w.example/api/cart/quote', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' }), env, ctx);
  assert.equal(q.status, 403);
});

test('catalog endpoint serves cached snapshot with checkout state and never exposes the token', async () => {
  const env = baseEnv({ SQUARE_ACCESS_TOKEN: 'SECRET_TOKEN_VALUE' });
  await env.LMK_STORE.put('catalog:v1', JSON.stringify(buildSnapshot(env, objects, new Map([['V5', 3]]))));
  const res = await worker.fetch(new Request('https://w.example/api/catalog'), env, { waitUntil() {} });
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!text.includes('SECRET_TOKEN_VALUE'));
  assert.equal(JSON.parse(text).checkout.enabled, false);
});
