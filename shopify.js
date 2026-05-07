/**
 * Shopify API client
 * Uses GraphQL for all fetching (supports metafields) and tag updates.
 * Auto-fetches OAuth token from client credentials.
 */

import { SHOP } from './config.js';
import { log } from './logger.js';

const API_VERSION = '2026-01';
const CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  log('info', '🔑 Fetching fresh Shopify access token…');
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Token fetch failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  log('info', '✅ Access token acquired');
  return cachedToken;
}

function headers(token) {
  return { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token };
}

// ---------------------------------------------------------------------------
// Fetch ALL products via GraphQL (includes metafields in one query)
// ---------------------------------------------------------------------------
export async function fetchAllProducts() {
  const token = await getAccessToken();
  const products = [];
  let cursor = null;
  let page = 0;

  while (true) {
    const query = `
      query($cursor: String) {
        products(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            productType
            status
            tags
            createdAt
            vendor
            variants(first: 100) {
              nodes { inventoryQuantity }
            }
            pre_order_date: metafield(namespace: "custom", key: "pre_order_date") { value }
            back_order_date: metafield(namespace: "custom", key: "back_order_date") { value }
            pre_order_override: metafield(namespace: "custom", key: "pre_order_override") { value }
          }
        }
      }
    `;

    const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ query, variables: { cursor } }),
    });

    if (!res.ok) throw new Error(`GraphQL fetch error ${res.status}: ${await res.text()}`);
    const json = await res.json();

    if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);

    const { nodes, pageInfo } = json.data.products;

    // Normalise GraphQL shape to match what tagger.js expects
    for (const p of nodes) {
      products.push({
        id: p.id.replace('gid://shopify/Product/', ''),
        gid: p.id,
        title: p.title,
        product_type: p.productType,
        status: p.status.toLowerCase(),
        tags: p.tags.join(', '),
        created_at: p.createdAt,
        vendor: p.vendor,
        variants: p.variants.nodes.map(v => ({ inventory_quantity: v.inventoryQuantity ?? 0 })),
        metafields: {
          pre_order_date: p.pre_order_date?.value || null,
          back_order_date: p.back_order_date?.value || null,
          pre_order_override: p.pre_order_override?.value === "true",
        },
      });
    }

    page++;
    if (page % 10 === 0) log('info', `  📄 Fetched ${products.length} products so far, loading next page…`);

    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }

  return products;
}

// ---------------------------------------------------------------------------
// Update a single product's tags via GraphQL
// ---------------------------------------------------------------------------
export async function updateProductTags(productGid, tags) {
  const token = await getAccessToken();
  // Accept either a GID or a numeric ID
  const id = productGid.startsWith('gid://') ? productGid : `gid://shopify/Product/${productGid}`;

  const query = `
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id tags }
        userErrors { field message }
      }
    }
  `;

  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ query, variables: { input: { id, tags } } }),
  });

  if (!res.ok) throw new Error(`GraphQL update error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const errors = json?.data?.productUpdate?.userErrors ?? [];
  if (errors.length > 0) throw new Error(`GraphQL userErrors: ${JSON.stringify(errors)}`);
  return json.data.productUpdate.product;
}
