import type { Env } from './env';
import { square, type CatalogObject, type InventoryCount, type Money } from './square';

/** Public, credential-free catalog snapshot served to the website. */
export interface Product {
  id: string;
  name: string;
  description: string;
  images: string[];
  variations: Variation[];
}
export interface Variation {
  id: string;
  /** The strength selection, e.g. "5 mg". Taken from the Square variation name. */
  name: string;
  sku: string | null;
  price: Money | null;
  trackInventory: boolean;
  /** null when stock isn't tracked in Square. */
  stock: number | null;
  available: boolean;
}
export interface CatalogSnapshot {
  syncedAt: string;
  environment: string;
  locationId: string;
  products: Product[];
}

export const SNAPSHOT_KEY = 'catalog:v1';

function presentAt(obj: CatalogObject, locationId: string): boolean {
  if (obj.is_deleted) return false;
  if (obj.present_at_all_locations !== false) {
    return !(obj.absent_at_location_ids ?? []).includes(locationId);
  }
  return (obj.present_at_location_ids ?? []).includes(locationId);
}

async function listAll(env: Env): Promise<CatalogObject[]> {
  const out: CatalogObject[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 200; page += 1) {
    const qs = new URLSearchParams({ types: 'ITEM,IMAGE' });
    if (cursor) qs.set('cursor', cursor);
    const res = await square<{ objects?: CatalogObject[]; cursor?: string }>(env, 'GET', `/v2/catalog/list?${qs}`);
    out.push(...(res.objects ?? []));
    cursor = res.cursor;
    if (!cursor) return out;
  }
  throw new Error('Catalog pagination did not finish');
}

export async function fetchStock(env: Env, variationIds: string[]): Promise<Map<string, number>> {
  const stock = new Map<string, number>();
  for (let i = 0; i < variationIds.length; i += 500) {
    const ids = variationIds.slice(i, i + 500);
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const res = await square<{ counts?: InventoryCount[]; cursor?: string }>(env, 'POST', '/v2/inventory/counts/batch-retrieve', {
        catalog_object_ids: ids,
        location_ids: [env.SQUARE_LOCATION_ID],
        states: ['IN_STOCK'],
        cursor,
      });
      for (const c of res.counts ?? []) {
        if (c.state === 'IN_STOCK' && c.location_id === env.SQUARE_LOCATION_ID) {
          stock.set(c.catalog_object_id, Math.max(0, Math.floor(Number(c.quantity) || 0)));
        }
      }
      cursor = res.cursor;
      if (!cursor) break;
    }
  }
  return stock;
}

export function buildSnapshot(env: Env, objects: CatalogObject[], stock: Map<string, number>, now = new Date()): CatalogSnapshot {
  const loc = env.SQUARE_LOCATION_ID;
  const images = new Map<string, string>();
  for (const o of objects) {
    if (o.type === 'IMAGE' && o.image_data?.url) images.set(o.id, o.image_data.url);
  }
  const products: Product[] = [];
  for (const item of objects) {
    const d = item.item_data;
    if (item.type !== 'ITEM' || !d || d.is_archived || !presentAt(item, loc)) continue;
    if (env.SQUARE_CATEGORY_ID) {
      const cats = new Set([...(d.categories ?? []).map((c) => c.id), d.category_id].filter(Boolean));
      if (!cats.has(env.SQUARE_CATEGORY_ID)) continue;
    }
    const variations: Variation[] = [];
    const sorted = [...(d.variations ?? [])].sort((a, b) => (a.item_variation_data?.ordinal ?? 0) - (b.item_variation_data?.ordinal ?? 0));
    for (const v of sorted) {
      const vd = v.item_variation_data;
      if (!vd || !presentAt(v, loc) || vd.sellable === false) continue;
      const override = vd.location_overrides?.find((o) => o.location_id === loc);
      // Variable-priced variations can't be sold online at a fixed price.
      const price = vd.pricing_type === 'VARIABLE_PRICING' ? null : (override?.price_money ?? vd.price_money ?? null);
      const track = override?.track_inventory ?? vd.track_inventory ?? false;
      const qty = track ? (stock.get(v.id) ?? 0) : null;
      const soldOut = override?.sold_out === true;
      variations.push({
        id: v.id,
        name: vd.name?.trim() || 'Standard',
        sku: vd.sku ?? null,
        price,
        trackInventory: track,
        stock: qty,
        available: !!price && !soldOut && (qty === null || qty > 0),
      });
    }
    if (variations.length === 0) continue;
    products.push({
      id: item.id,
      name: d.name?.trim() || 'Untitled',
      description: d.description_plaintext ?? '',
      images: (d.image_ids ?? []).map((id) => images.get(id)).filter((u): u is string => !!u),
      variations,
    });
  }
  products.sort((a, b) => a.name.localeCompare(b.name));
  return { syncedAt: now.toISOString(), environment: env.SQUARE_ENV ?? 'sandbox', locationId: loc, products };
}

/** Full sync: Catalog API (names, strengths, prices, images) + Inventory API (stock). */
export async function syncCatalog(env: Env): Promise<CatalogSnapshot> {
  const objects = await listAll(env);
  const variationIds = objects
    .filter((o) => o.type === 'ITEM')
    .flatMap((o) => (o.item_data?.variations ?? []).map((v) => v.id));
  const stock = await fetchStock(env, variationIds);
  const snapshot = buildSnapshot(env, objects, stock);
  await env.LMK_STORE.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
  return snapshot;
}

/** Applies inventory webhook counts to the cached snapshot without a full catalog sync. */
export async function applyStockUpdates(env: Env, counts: InventoryCount[]): Promise<number> {
  const snap = (await env.LMK_STORE.get(SNAPSHOT_KEY, 'json')) as CatalogSnapshot | null;
  if (!snap) return 0;
  let changed = 0;
  for (const c of counts) {
    if (c.state !== 'IN_STOCK' || c.location_id !== env.SQUARE_LOCATION_ID) continue;
    for (const p of snap.products) {
      for (const v of p.variations) {
        if (v.id === c.catalog_object_id && v.trackInventory) {
          v.stock = Math.max(0, Math.floor(Number(c.quantity) || 0));
          v.available = !!v.price && v.stock > 0;
          changed += 1;
        }
      }
    }
  }
  if (changed) await env.LMK_STORE.put(SNAPSHOT_KEY, JSON.stringify(snap));
  return changed;
}

export async function getSnapshot(env: Env): Promise<CatalogSnapshot> {
  const snap = (await env.LMK_STORE.get(SNAPSHOT_KEY, 'json')) as CatalogSnapshot | null;
  return snap ?? syncCatalog(env);
}
