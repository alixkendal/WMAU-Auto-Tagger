/**
 * One-time backfill script
 * Finds all products with an RD:DDMMYY tag and sets the
 * custom.pre_order_date metafield from it — if not already set.
 *
 * Run once with: node backfill-preorder-dates.js
 */

const SHOP        = process.env.SHOPIFY_SHOP;
const CLIENT_ID   = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = '2026-01';
const THROTTLE_MS = 500;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Parse RD:DDMMYY → ISO date string "YYYY-MM-DD"
// ---------------------------------------------------------------------------
function parseRDTag(tag) {
  const match = tag.match(/^RD:(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, dd, mm, yy] = match;
  const year = parseInt(yy) + 2000;
  return `${year}-${mm}-${dd}`; // ISO format for Shopify date metafield
}

// ---------------------------------------------------------------------------
// Fetch all products with at least one RD: tag, paginated
// ---------------------------------------------------------------------------
async function fetchProductsWithRDTags(token) {
  const products = [];
  let cursor = null;

  while (true) {
    const data = await gql(token, `
      query($cursor: String) {
        products(first: 250, after: $cursor, query: "tag:RD:*") {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            tags
            pre_order_date: metafield(namespace: "custom", key: "pre_order_date") { value }
          }
        }
      }
    `, { cursor });

    for (const p of data.products.nodes) {
      const rdTag = p.tags.find(t => /^RD:\d{6}$/.test(t));
      if (rdTag) products.push({ ...p, rdTag });
    }

    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
    console.log(`  Fetched ${products.length} products so far…`);
  }

  return products;
}

// ---------------------------------------------------------------------------
// Set pre_order_date metafield on a product
// ---------------------------------------------------------------------------
async function setPreOrderDate(token, productId, isoDate) {
  const data = await gql(token, `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { key value }
        userErrors { field message }
      }
    }
  `, {
    metafields: [{
      ownerId:   productId,
      namespace: 'custom',
      key:       'pre_order_date',
      type:      'date',
      value:     isoDate,
    }],
  });

  const errors = data.metafieldsSet?.userErrors ?? [];
  if (errors.length > 0) throw new Error(JSON.stringify(errors));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export async function backfillPreorderDates() {
  console.log('🚀 Pre-order date backfill starting…\n');

  const token = await getAccessToken();
  console.log('✅ Authenticated\n');

  console.log('🔍 Fetching products with RD: tags…');
  const products = await fetchProductsWithRDTags(token);
  console.log(`\n📦 Found ${products.length} products with RD: tags\n`);

  const stats = { set: 0, skipped: 0, errors: 0 };

  for (const product of products) {
    const isoDate = parseRDTag(product.rdTag);

    if (!isoDate) {
      console.log(`  ⚠  "${product.title}" — couldn't parse ${product.rdTag}, skipping`);
      stats.errors++;
      continue;
    }

    if (product.pre_order_date?.value) {
      console.log(`  ⏭  "${product.title}" — metafield already set (${product.pre_order_date.value}), skipping`);
      stats.skipped++;
      continue;
    }

    try {
      await setPreOrderDate(token, product.id, isoDate);
      console.log(`  ✅ "${product.title}" — set pre_order_date to ${isoDate} (from ${product.rdTag})`);
      stats.set++;
    } catch (err) {
      console.log(`  ✖  "${product.title}" — ${err.message}`);
      stats.errors++;
    }

    await sleep(THROTTLE_MS);
  }

  console.log(`\n✔  Done — ${stats.set} set, ${stats.skipped} already had date, ${stats.errors} errors`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

