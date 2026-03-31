/**
 * Shopify API client
 * Auto-fetches a fresh OAuth access token using client credentials.
 */

import { SHOP } from './config.js';
import { log } from './logger.js';

const API_VERSION = '2026-01';
const BASE = `https://${SHOP}/admin/api/${API_VERSION}`;

const CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

let cachedToken = null;
let tokenExpiry = 0;

// ---------------------------------------------------------------------------
// Get a valid access token (fetches a new one if expired)
// ---------------------------------------------------------------------------
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  log('info', '🔑 Fetching fresh Shopify access token…');

  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token fetch failed ${res.status}: ${body}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  // Refresh a minute before expiry
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;

  log('info', '✅ Access token acquired');
  return cachedToken;
}

function getHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': token,
  };
}

// ---------------------------------------------------------------------------
// Fetch ALL products (handles pagination automatically)
// ---------------------------------------------------------------------------
export async function fetchAllProducts() {
  const token = await getAccessToken();
  const products = [];
  let url = `${BASE}/products.json?limit=250&fields=id,title,product_type,tags,variants,created_at,status`;

  while (url) {
    const res = await fetch(url, { headers: getHeaders(token) });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Shopify REST error ${res.status}: ${body}`);
    }

    const data = await res.json();
    products.push(...data.products);
    url = getNextPageUrl(res.headers.get('Link'));

    if (url) log('info', `  📄 Fetched ${products.length} products so far, loading next page…`);
  }

  return products;
}

// ---------------------------------------------------------------------------
// Update a single product's tags via GraphQL
// ---------------------------------------------------------------------------
export async function updateProductTags(productId, tags) {
  const token = await getAccessToken();
  const gqlId = `gid://shopify/Product/${productId}`;
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
    headers: getHeaders(token),
    body: JSON.stringify({
      query,
      variables: { input: { id: gqlId, tags } },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GraphQL HTTP error ${res.status}: ${body}`);
  }

  const json = await res.json();
  const errors = json?.data?.productUpdate?.userErrors ?? [];
  if (errors.length > 0) {
    throw new Error(`GraphQL userErrors: ${JSON.stringify(errors)}`);
  }

  return json.data.productUpdate.product;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getNextPageUrl(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}
