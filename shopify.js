/**
 * Shopify API client
 * Handles REST product fetching (with full pagination) and GraphQL tag updates.
 */

import { SHOP, TOKEN } from './config.js';
import { log } from './logger.js';

const API_VERSION = '2026-01';
const BASE = `https://${SHOP}/admin/api/${API_VERSION}`;

const HEADERS = {
  'Content-Type': 'application/json',
  'X-Shopify-Access-Token': TOKEN,
};

// ---------------------------------------------------------------------------
// Fetch ALL products (handles pagination automatically via Link headers)
// ---------------------------------------------------------------------------
export async function fetchAllProducts() {
  const products = [];
  let url = `${BASE}/products.json?limit=250&fields=id,title,product_type,tags,variants,created_at,status`;

  while (url) {
    const res = await fetch(url, { headers: HEADERS });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Shopify REST error ${res.status}: ${body}`);
    }

    const data = await res.json();
    products.push(...data.products);

    // Parse the Link header for the next page
    url = getNextPageUrl(res.headers.get('Link'));

    if (url) log('info', `  📄 Fetched ${products.length} products so far, loading next page…`);
  }

  return products;
}

// ---------------------------------------------------------------------------
// Update a single product's tags via GraphQL (safer for large tag lists)
// ---------------------------------------------------------------------------
export async function updateProductTags(productId, tags) {
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
    headers: HEADERS,
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
  // Link: <https://...>; rel="next", <https://...>; rel="previous"
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}
