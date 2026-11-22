/**
 * LMK Production Inventory Reader — prelaunch only.
 * Reads Square Production catalog and inventory, without any write/checkout routes.
 *
 * Every data endpoint requires INVENTORY_READ_TOKEN as a bearer credential.
 * Do NOT put that token in browser JavaScript or GitHub.
 * This Worker sends no Access-Control-Allow-Origin response headers.
 */

const SQUARE_API_ROOT = "https://connect.squareup.com";
const SQUARE_VERSION = "2026-11-18";
const MAX_PAGES = 100;

function reply(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function squareRead(env, method, path, body) {
  const response = await fetch(SQUARE_API_ROOT + path, {
    method,
    headers: {
      Authorization: "Bearer " + env.SQUARE_PRODUCTION_ACCESS_TOKEN,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    // Intentionally do not return Square's response, token or buyer data.
    throw new Error("Square catalog/inventory read failed (HTTP " + response.status + ")");
  }
  return response.json();
}

async function readCatalog(env) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const params = new URLSearchParams({ types: "ITEM" });
    if (cursor) params.set("cursor", cursor);
    const data = await squareRead(env, "GET", "/v2/catalog/list?" + params.toString());
    out.push(...(data.objects || []));
    cursor = data.cursor || null;
    if (!cursor) return out;
  }
  throw new Error("Catalog pagination limit reached");
}

async function readInventory(env, locationId, variationIds) {
  const stock = new Map();
  for (let start = 0; start < variationIds.length; start += 100) {
    const batch = variationIds.slice(start, start + 100);
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await squareRead(env, "POST", "/v2/inventory/counts/batch-retrieve", {
        catalog_object_ids: batch,
        location_ids: [locationId],
        states: ["IN_STOCK"],
        ...(cursor ? { cursor } : {}),
      });
      for (const count of data.counts || []) {
        if (count.state === "IN_STOCK" && count.location_id === locationId) {
          const q = Number(count.quantity);
          stock.set(count.catalog_object_id, Number.isFinite(q) ? q : 0);
        }
      }
      cursor = data.cursor || null;
      if (!cursor) break;
      if (page === MAX_PAGES - 1) throw new Error("Inventory pagination limit reached");
    }
  }
  return stock;
}

function isPresent(object, locationId) {
  if (object.is_deleted) return false;
  if (object.present_at_all_locations === false) {
    return (object.present_at_location_ids || []).includes(locationId);
  }
  return !(object.absent_at_location_ids || []).includes(locationId);
}

async function snapshot(env) {
  const locationId = (env.SQUARE_PRODUCTION_LOCATION_ID || "").trim();
  if (!locationId) return reply({ error: "LOCATION_NOT_CONFIGURED", hint: "Call /api/locations and configure SQUARE_PRODUCTION_LOCATION_ID first" }, 503);
  const objects = await readCatalog(env);
  const ids = objects.flatMap(item => (item.item_data?.variations || []).map(v => v.id));
  const stock = await readInventory(env, locationId, ids);
  const products = [];
  for (const item of objects) {
    if (!item.item_data || item.item_data.is_archived || !isPresent(item, locationId)) continue;
    const variations = [];
    for (const v of item.item_data.variations || []) {
      const d = v.item_variation_data;
      if (!d || !isPresent(v, locationId) || d.sellable === false) continue;
      const override = (d.location_overrides || []).find(o => o.location_id === locationId);
      const tracked = override?.track_inventory ?? d.track_inventory ?? false;
      const quantity = tracked ? (stock.get(v.id) ?? 0) : null;
      const price = d.pricing_type === "VARIABLE_PRICING" ? null : (override?.price_money ?? d.price_money ?? null);
      variations.push({
        id: v.id,
        name: d.name || "Standard",
        sku: d.sku || null,
        price,
        trackInventory: tracked,
        stock: quantity,
        available: price !== null && !override?.sold_out && (quantity === null || quantity > 0),
      });
    }
    if (variations.length) products.push({
      id: item.id,
      name: item.item_data.name || "Untitled",
      variations,
    });
  }
  products.sort((a, b) => a.name.localeCompare(b.name));
  return reply({
    syncedAt: new Date().toISOString(),
    environment: "production",
    locationId,
    mode: "read_only_prelaunch",
    checkout: { enabled: false, reason: "prelaunch_locked" },
    products,
  });
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method !== "GET") return reply({ error: "METHOD_NOT_ALLOWED" }, 405);
    if (path === "/health") return reply({ status: "ok", mode: "read_only_prelaunch", checkoutEnabled: false });
    const bearer = request.headers.get("Authorization");
    if (
      !env.INVENTORY_READ_TOKEN ||
      env.INVENTORY_READ_TOKEN.length < 32 ||
      !bearer ||
      bearer !== "Bearer " + env.INVENTORY_READ_TOKEN
    ) {
      return reply({ error: "UNAUTHORIZED" }, 401);
    }
    if (!env.SQUARE_PRODUCTION_ACCESS_TOKEN) return reply({ error: "PRODUCTION_TOKEN_NOT_CONFIGURED" }, 503);
    try {
      if (path === "/api/locations") {
        const data = await squareRead(env, "GET", "/v2/locations");
        return reply({
          locations: (data.locations || [])
            .filter(l => l.status === "ACTIVE")
            .map(l => ({ id: l.id, name: l.name, status: l.status })),
        });
      }
      if (path === "/api/catalog") return await snapshot(env);
      return reply({ error: "NOT_FOUND" }, 404);
    } catch (error) {
      console.error("Production read failed:", error instanceof Error ? error.message : "unknown");
      return reply({ error: "SQUARE_READ_FAILED" }, 502);
    }
  },
};
