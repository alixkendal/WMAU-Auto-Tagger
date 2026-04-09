/**
 * Genre Tagger
 * Reads artist collections (custom.is_artist = true), resolves their
 * custom.genre metafield (list of Genre metaobject references),
 * and adds Genre:X tags to all products in those collections.
 * Never removes genre tags — only adds.
 */

import { THROTTLE_MS } from './config.js';
import { updateProductTags } from './shopify.js';
import { log } from './logger.js';

const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = '2026-01';

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  if (!res.ok) throw new Error(`Token fetch failed: ${await res.text()}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function gql(query, variables = {}) {
  const token = await getAccessToken();
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP error ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

// ---------------------------------------------------------------------------
// Step 1: Fetch all artist collections with their genre metafields
// ---------------------------------------------------------------------------
async function fetchArtistCollections() {
  const collections = [];
  let cursor = null;

  while (true) {
    const data = await gql(`
      query($cursor: String) {
        collections(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            is_artist: metafield(namespace: "custom", key: "is_artist") { value }
            genre: metafield(namespace: "custom", key: "genre") { 
              value
              references(first: 20) {
                nodes {
                  ... on Metaobject {
                    fields { key value }
                  }
                }
              }
            }
          }
        }
      }
    `, { cursor });

    for (const c of data.collections.nodes) {
      if (c.is_artist?.value !== 'true') continue;

      // Resolve genre titles from metaobject references
      const genres = [];
      if (c.genre?.references?.nodes) {
        for (const node of c.genre.references.nodes) {
          const titleField = node.fields?.find(f => f.key === 'title');
          if (titleField?.value) genres.push(titleField.value.trim());
        }
      }

      if (genres.length > 0) {
        collections.push({ id: c.id, title: c.title, genres });
      }
    }

    if (!data.collections.pageInfo.hasNextPage) break;
    cursor = data.collections.pageInfo.endCursor;
  }

  log('info', `🎵 Found ${collections.length} artist collections with genres`);
  return collections;
}

// ---------------------------------------------------------------------------
// Step 2: Fetch all products in a collection
// ---------------------------------------------------------------------------
async function fetchCollectionProducts(collectionId) {
  const products = [];
  let cursor = null;

  while (true) {
    const data = await gql(`
      query($id: ID!, $cursor: String) {
        collection(id: $id) {
          products(first: 250, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { id title tags }
          }
        }
      }
    `, { id: collectionId, cursor });

    const nodes = data.collection?.products?.nodes ?? [];
    products.push(...nodes.map(p => ({
      gid: p.id,
      id: p.id.replace('gid://shopify/Product/', ''),
      title: p.title,
      tags: p.tags,
    })));

    if (!data.collection.products.pageInfo.hasNextPage) break;
    cursor = data.collection.products.pageInfo.endCursor;
  }

  return products;
}

// ---------------------------------------------------------------------------
// Normalise a genre title to a tag: "Rock" → "Genre:Rock"
// Strips any accidental spaces after the colon
// ---------------------------------------------------------------------------
function genreTag(title) {
  return `Genre:${title.trim()}`;
}

// ---------------------------------------------------------------------------
// Fix existing malformed tags like "Genre: Rock" → "Genre:Rock"
// ---------------------------------------------------------------------------
function normaliseTags(tags) {
  return tags.map(t => t.replace(/^Genre:\s+/, 'Genre:'));
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
export async function runGenreTagger() {
  const startTime = Date.now();
  log('info', '▶  Starting genre tagging run…');

  let artistCollections;
  try {
    artistCollections = await fetchArtistCollections();
  } catch (err) {
    log('error', `Failed to fetch artist collections: ${err.message}`);
    return;
  }

  // Build a map of productId → Set of genre tags to add
  const productGenres = new Map(); // gid → Set<string>

  for (const collection of artistCollections) {
    log('info', `  🎨 "${collection.title}" → ${collection.genres.map(genreTag).join(', ')}`);
    let products;
    try {
      products = await fetchCollectionProducts(collection.id);
    } catch (err) {
      log('error', `  Failed to fetch products for "${collection.title}": ${err.message}`);
      continue;
    }

    for (const product of products) {
      if (!productGenres.has(product.gid)) productGenres.set(product.gid, { product, tags: new Set() });
      for (const genre of collection.genres) {
        productGenres.get(product.gid).tags.add(genreTag(genre));
      }
    }

    await sleep(THROTTLE_MS);
  }

  log('info', `📦 Applying genre tags to ${productGenres.size} products…`);

  const stats = { updated: 0, unchanged: 0, errors: 0 };

  for (const { product, tags: genreTags } of productGenres.values()) {
    try {
      // Normalise existing tags, then add new genre tags
      const existing = normaliseTags(product.tags);
      const finalTags = new Set(existing);
      const additions = [];

      for (const tag of genreTags) {
        if (!finalTags.has(tag)) {
          finalTags.add(tag);
          additions.push(`+${tag}`);
        }
      }

      if (additions.length === 0) { stats.unchanged++; continue; }

      log('info', `  🏷  "${product.title}": ${additions.join(' | ')}`);
      await updateProductTags(product.gid, [...finalTags]);
      stats.updated++;
    } catch (err) {
      stats.errors++;
      log('error', `  Product "${product.title}": ${err.message}`);
    }

    await sleep(THROTTLE_MS);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log('info', `✔  Genre run complete in ${elapsed}s — ${stats.updated} updated, ${stats.unchanged} unchanged, ${stats.errors} errors`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
