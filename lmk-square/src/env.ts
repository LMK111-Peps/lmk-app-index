// Minimal Cloudflare Workers types so this project type-checks without extra packages.
export interface KVNamespace {
  get(key: string, type: 'json'): Promise<unknown>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Env {
  /** "sandbox" (default) or "production". */
  SQUARE_ENV?: string;
  /** Secret: set with `wrangler secret put SQUARE_ACCESS_TOKEN`. Never commit it. */
  SQUARE_ACCESS_TOKEN: string;
  /** The Square location whose catalog, stock, and orders this site uses. */
  SQUARE_LOCATION_ID: string;
  /** Secret: webhook signature key from the Square Developer Console. */
  SQUARE_WEBHOOK_SIGNATURE_KEY?: string;
  /** Exact public URL registered for the webhook subscription, used in signature checks. */
  SQUARE_WEBHOOK_URL?: string;
  /** Secret: bearer token for the manual sync endpoint. */
  ADMIN_TOKEN?: string;
  /** Comma-separated origins allowed to call the API, e.g. https://www.example.com */
  ALLOWED_ORIGINS?: string;
  /** Phase-one hard stop: all deployments must run sandbox-only, sync-only. */
  SYNC_ONLY_MODE?: string;
  /** "true" turns on checkout sessions. Off by default. */
  CHECKOUT_ENABLED?: string;
  /**
   * Second, independent switch required for production checkout. Set to "true" only after
   * Square confirms in writing that this catalog is eligible for processing.
   */
  LIVE_PAYMENTS_APPROVED?: string;
  /** Where Square sends buyers after paying, e.g. https://www.example.com/order-complete */
  CHECKOUT_REDIRECT_URL?: string;
  /** Optional Square catalog category ID; when set, only items in it are published. */
  SQUARE_CATEGORY_ID?: string;
  /** KV namespace that holds the synced catalog snapshot and order lookups. */
  LMK_STORE: KVNamespace;
}

export const isProduction = (env: Env): boolean => (env.SQUARE_ENV ?? 'sandbox').toLowerCase() === 'production';

export function checkoutState(env: Env): { enabled: boolean; reason: string | null } {
  // Fail closed: sync-only is the default until a separate reviewed release.
  if (env.SYNC_ONLY_MODE !== 'false') return { enabled: false, reason: 'sync_only_mode' };
  if (env.CHECKOUT_ENABLED !== 'true') {
    return { enabled: false, reason: 'checkout_disabled' };
  }
  if (isProduction(env) && env.LIVE_PAYMENTS_APPROVED !== 'true') {
    return { enabled: false, reason: 'live_payments_not_approved' };
  }
  return { enabled: true, reason: null };
}
