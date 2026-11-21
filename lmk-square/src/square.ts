import { isProduction, type Env } from './env';

/** Pin the API version so Square changes never alter behavior silently. Bump deliberately. */
export const SQUARE_VERSION = '2025-01-23';

export class SquareError extends Error {
  constructor(public status: number, public codes: string[], message: string) {
    super(message);
    this.name = 'SquareError';
  }
}

export function squareBase(env: Env): string {
  return isProduction(env) ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';
}

/** Server-side only: the access token never leaves this Worker. */
export async function square<T>(env: Env, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  if (!env.SQUARE_ACCESS_TOKEN) {
    throw new SquareError(500, ['MISSING_TOKEN'], 'Square access token is not configured');
  }
  const res = await fetch(`${squareBase(env)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      'Square-Version': SQUARE_VERSION,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON error page */ }
  if (!res.ok || (Array.isArray(json.errors) && json.errors.length > 0)) {
    const codes: string[] = Array.isArray(json.errors) ? json.errors.map((e: any) => String(e.code ?? 'UNKNOWN')) : [];
    // Log codes only: never log tokens, request bodies, or buyer details.
    console.error(`Square ${method} ${path} failed: ${res.status} ${codes.join(',')}`);
    throw new SquareError(res.status, codes, `Square request failed (${res.status})`);
  }
  return json as T;
}

// ---- Square REST shapes used here (subset) ----
export interface Money { amount: number; currency: string }
export interface CatalogObject {
  type: string;
  id: string;
  version?: number;
  is_deleted?: boolean;
  present_at_all_locations?: boolean;
  present_at_location_ids?: string[];
  absent_at_location_ids?: string[];
  item_data?: {
    name?: string;
    description_plaintext?: string;
    description?: string;
    image_ids?: string[];
    categories?: { id: string }[];
    category_id?: string;
    is_archived?: boolean;
    ecom_visibility?: string;
    variations?: CatalogObject[];
  };
  item_variation_data?: {
    item_id?: string;
    name?: string;
    sku?: string;
    ordinal?: number;
    pricing_type?: string;
    price_money?: Money;
    track_inventory?: boolean;
    sellable?: boolean;
    location_overrides?: { location_id: string; price_money?: Money; track_inventory?: boolean; sold_out?: boolean }[];
  };
  image_data?: { url?: string; name?: string };
}
export interface InventoryCount { catalog_object_id: string; location_id: string; state: string; quantity: string }
