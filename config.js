/**
 * ============================================================
 *  SHOPIFY AUTO-TAGGER — CONFIGURATION
 *  Edit this file to customise your tagging rules.
 * ============================================================
 */

// ---------------------------------------------------------------------------
// Shopify credentials (prefer setting these as environment variables)
// ---------------------------------------------------------------------------
export const SHOP = process.env.SHOPIFY_SHOP    || 'your-store.myshopify.com';
export const TOKEN = process.env.SHOPIFY_TOKEN  || 'shpat_xxxxxxxxxxxxxxxxxxxx';

// ---------------------------------------------------------------------------
// How often the service runs (cron syntax)
// ---------------------------------------------------------------------------
// '0 * * * *'   = every hour
// '0 3 * * *'   = every day at 3 AM
// '*/15 * * * *' = every 15 minutes
export const SCHEDULE = process.env.TAGGER_SCHEDULE || '0 * * * *';

// ---------------------------------------------------------------------------
// API throttle — ms to wait between product updates (avoid rate-limit 429s)
// ---------------------------------------------------------------------------
export const THROTTLE_MS = 500;

// ---------------------------------------------------------------------------
//  TAG RULES
//  Each rule is evaluated for every product on every run.
//  Rules are applied in order; a product can match multiple rules.
// ---------------------------------------------------------------------------
export const RULES = [

  // ── Inventory: "Last Chance" ────────────────────────────────────────────
  {
    id: 'last-chance',
    description: 'Tag products with fewer than 10 total units as "Last Chance"',

    // Should this tag be added?
    shouldAdd: (product) => getTotalInventory(product) < 10 && getTotalInventory(product) > 0,

    // Should this tag be removed? (product no longer qualifies)
    shouldRemove: (product) => getTotalInventory(product) >= 10,

    tags: ['Last Chance'],
  },

  // ── Out of stock ─────────────────────────────────────────────────────────
  {
    id: 'out-of-stock',
    description: 'Tag completely sold-out products',
    shouldAdd:    (product) => getTotalInventory(product) === 0,
    shouldRemove: (product) => getTotalInventory(product) > 0,
    tags: ['Out of Stock'],
  },

  // ── New Arrival (add on creation, remove after N months) ─────────────────
  {
    id: 'new-arrival',
    description: 'Tag products created within the last 90 days as "New Arrival"',
    shouldAdd:    (product) => daysSince(product.created_at) <= NEW_ARRIVAL_DAYS,
    shouldRemove: (product) => daysSince(product.created_at) >  NEW_ARRIVAL_DAYS,
    tags: ['New Arrival'],
  },

  // ── Product-type → tag mapping ────────────────────────────────────────────
  // Add as many product types as you like.
  // Keys are matched case-insensitively against product.product_type.
  ...buildProductTypeRules({
    cap:       ['Product:Hat', 'Page:Merch', 'Page:Accessories'],
    hat:       ['Product:Hat', 'Page:Merch', 'Page:Accessories'],
    hoodie:    ['Product:Hoodie', 'Page:Merch', 'Page:Apparel'],
    tee:       ['Product:Tee', 'Page:Merch', 'Page:Apparel'],
    't-shirt': ['Product:Tee', 'Page:Merch', 'Page:Apparel'],
    poster:    ['Product:Poster', 'Page:Art'],
    mug:       ['Product:Mug', 'Page:Accessories'],
    // ↑ Add / edit product types here
  }),

];

// ---------------------------------------------------------------------------
// Settings for the "New Arrival" rule
// ---------------------------------------------------------------------------
export const NEW_ARRIVAL_DAYS = 90; // set to 180 for 6-month window

// ============================================================
//  HELPERS  (no need to edit below this line)
// ============================================================

function getTotalInventory(product) {
  return (product.variants || []).reduce(
    (sum, v) => sum + (v.inventory_quantity ?? 0),
    0
  );
}

function daysSince(dateStr) {
  const ms = Date.now() - new Date(dateStr).getTime();
  return ms / (1000 * 60 * 60 * 24);
}

/**
 * Converts a product-type → tags map into rule objects.
 * Automatically handles add & remove for each type.
 */
function buildProductTypeRules(typeMap) {
  return Object.entries(typeMap).map(([type, tags]) => ({
    id: `product-type:${type}`,
    description: `Product type "${type}" → [${tags.join(', ')}]`,
    shouldAdd:    (p) => p.product_type?.toLowerCase() === type.toLowerCase(),
    shouldRemove: (p) => p.product_type?.toLowerCase() !== type.toLowerCase(),
    tags,
  }));
}
