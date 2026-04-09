/**
 * One-time cleanup script
 * Finds all products with "Product:X" tags and removes the "Product:" prefix,
 * leaving just "X". Skips if the unprefixed tag already exists.
 *
 * Run once with: node backfill-remove-product-prefix.js
 */

const SHOP          = process.env.SHOPIFY_SHOP;
const CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION   = '2026-01';
const THROTTLE_MS   = 500;

async function getAccessToken() {
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  if (!res.ok) throw new Error(`Token fetch failed: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function gql(token, query, variables = {}) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function fetchProductsWithProductPrefix(token) {
  const products = [];
  let cursor = null;
  let totalFetched = 0;

  while (true) {
    const data = await gql(token, `
      query($cursor: String) {
        products(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { id title tags }
        }
      }
    `, { cursor });

    totalFetched += data.products.nodes.length;

    // Filter client-side — wildcard tag queries are unreliable in Shopify
    for (const p of data.products.nodes) {
      if (p.tags.some(t => t.startsWith('Product:'))) {
        products.push(p);
      }
    }

    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
    console.log(`  Scanned ${totalFetched} products, found ${products.length} to clean up so far…`);
  }

  return products;
}

async function updateTags(token, productId, tags) {
  const data = await gql(token, `
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id tags }
        userErrors { field message }
      }
    }
  `, { input: { id: productId, tags } });

  const errors = data.productUpdate?.userErrors ?? [];
  if (errors.length > 0) throw new Error(JSON.stringify(errors));
}

export async function backfillRemoveProductPrefix() {
  console.log('🚀 Product: prefix cleanup starting…\n');

  const token = await getAccessToken();
  console.log('✅ Authenticated\n');

  console.log('🔍 Fetching products with Product:X tags…');
  const products = await fetchProductsWithProductPrefix(token);
  console.log(`\n📦 Found ${products.length} products to clean up\n`);

  const stats = { updated: 0, skipped: 0, errors: 0 };

  for (const product of products) {
    try {
      const originalTags = new Set(product.tags);
      const updatedTags  = new Set(product.tags);

      for (const tag of product.tags) {
        if (!tag.startsWith('Product:')) continue;
        const stripped = tag.replace(/^Product:/, '').trim();
        updatedTags.delete(tag);           // remove "Product:X"
        updatedTags.add(stripped);         // add "X"
      }

      // Check if anything actually changed
      const changed = [...updatedTags].some(t => !originalTags.has(t)) ||
                      [...originalTags].some(t => !updatedTags.has(t));

      if (!changed) {
        console.log(`  ⏭  "${product.title}" — no changes needed`);
        stats.skipped++;
        continue;
      }

      const removedTags   = [...originalTags].filter(t => !updatedTags.has(t));
      const addedTags     = [...updatedTags].filter(t => !originalTags.has(t));
      console.log(`  ✅ "${product.title}"`);
      if (removedTags.length) console.log(`      - removed: ${removedTags.join(', ')}`);
      if (addedTags.length)   console.log(`      + added:   ${addedTags.join(', ')}`);

      await updateTags(token, product.id, [...updatedTags]);
      stats.updated++;
    } catch (err) {
      console.log(`  ✖  "${product.title}" — ${err.message}`);
      stats.errors++;
    }

    await sleep(THROTTLE_MS);
  }

  console.log(`\n✔  Done — ${stats.updated} updated, ${stats.skipped} skipped, ${stats.errors} errors`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

