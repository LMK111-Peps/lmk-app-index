/**
 * LMK Cloudflare Pages Function — read-only Square Production snapshot.
 * Secret: SQUARE_PRODUCTION_ACCESS_TOKEN, configured in Cloudflare Pages.
 * No checkout, orders, payments, or inventory writes.
 */
const SQUARE_BASE = "https://connect.squareup.com";
const SQUARE_VERSION = "2026-11-18";
const LOCATION = "LRXAGC9EFSD9N";
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers});

async function square(env, method, path, payload) {
  const response = await fetch(SQUARE_BASE + path, {
    method,
    headers: {
      Authorization: "Bearer " + env.SQUARE_PRODUCTION_ACCESS_TOKEN,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json",
    },
    ...(payload ? {body: JSON.stringify(payload)} : {}),
  });
  if (!response.ok) throw new Error("Square read failed: " + response.status);
  return response.json();
}

async function catalog(env) {
  const objects = [];
  let cursor = "";
  for (let page = 0; page < 100; page++) {
    const q = new URLSearchParams({types: "ITEM"});
    if (cursor) q.set("cursor", cursor);
    const data = await square(env, "GET", "/v2/catalog/list?" + q.toString());
    objects.push(...(data.objects || []));
    cursor = data.cursor || "";
    if (!cursor) return objects;
  }
  throw new Error("Catalog page limit reached");
}

async function inventory(env, ids) {
  const quantities = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    let cursor = "";
    for (let page = 0; page < 100; page++) {
      const data = await square(env, "POST", "/v2/inventory/counts/batch-retrieve", {
        catalog_object_ids: ids.slice(i, i + 100),
        location_ids: [LOCATION],
        states: ["IN_STOCK"],
        ...(cursor ? {cursor} : {}),
      });
      for (const count of data.counts || []) {
        if (count.location_id === LOCATION && count.state === "IN_STOCK") {
          const qty = Number(count.quantity);
          quantities.set(count.catalog_object_id, Number.isFinite(qty) ? qty : 0);
        }
      }
      cursor = data.cursor || "";
      if (!cursor) break;
      if (page === 99) throw new Error("Inventory page limit reached");
    }
  }
  return quantities;
}

const visibleAtLocation = object =>
  !object.is_deleted &&
  (object.present_at_all_locations !== false ||
    (object.present_at_location_ids || []).includes(LOCATION)) &&
  !(object.absent_at_location_ids || []).includes(LOCATION);

export async function onRequestGet({env}) {
  if (!env.SQUARE_PRODUCTION_ACCESS_TOKEN) {
    return json({error: "PRODUCTION_NOT_CONFIGURED", checkoutEnabled: false}, 503);
  }
  try {
    const items = await catalog(env);
    const ids = items.flatMap(item => (item.item_data?.variations || []).map(v => v.id));
    const counts = await inventory(env, ids);
    const products = items
      .filter(item => visibleAtLocation(item) && !item.item_data?.is_archived)
      .map(item => ({
        name: item.item_data.name,
        variations: (item.item_data.variations || [])
          .filter(v => visibleAtLocation(v) && v.item_variation_data?.sellable !== false)
          .map(v => {
            const d = v.item_variation_data;
            const override = (d.location_overrides || []).find(o => o.location_id === LOCATION) || {};
            const price = override.price_money || d.price_money;
            const tracked = override.track_inventory ?? d.track_inventory ?? false;
            const stock = tracked ? (counts.get(v.id) ?? 0) : null;
            return {
              id: v.id,
              size: d.name,
              sku: d.sku || "",
              priceCents: price?.currency === "USD" && Number.isSafeInteger(price.amount) ? price.amount : null,
              stock,
              available: !override.sold_out && (!tracked || stock > 0),
            };
          }),
      }))
      .filter(item => item.variations.length > 0);
    return json({
      environment: "production",
      locationId: LOCATION,
      syncedAt: new Date().toISOString(),
      checkout: {enabled: false, reason: "prelaunch_locked"},
      products,
    });
  } catch (error) {
    console.error("Square production snapshot failed:", error instanceof Error ? error.message : "unknown");
    return json({error: "PRODUCTION_READ_FAILED", checkoutEnabled: false}, 502);
  }
}
