/**
 * Genre Backfill Script
 * Fetches Shopify_Collections_Missing_Genres.xlsx from GitHub and sets
 * the custom.genre metafield on each artist collection.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const SHOP          = process.env.SHOPIFY_SHOP;
const CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION   = '2026-01';
const THROTTLE_MS   = 500;

const EXCEL_URL = 'https://raw.githubusercontent.com/alixkendal/WMAU-Auto-Tagger/main/Shopify%20Collections_Missing%20Genres.xlsx';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
async function getAccessToken() {
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
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
// Fetch all Genre metaobjects → map handle → GID
// ---------------------------------------------------------------------------
async function fetchGenreMap(token) {
  const map = {};
  let cursor = null;

  while (true) {
    const data = await gql(token, `
      query($cursor: String) {
        metaobjects(type: "genre", first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            handle
            fields { key value }
          }
        }
      }
    `, { cursor });

    for (const obj of data.metaobjects.nodes) {
      map[`genre.${obj.handle}`] = obj.id;
      map[obj.handle] = obj.id;
      const titleField = obj.fields.find(f => f.key === 'title' || f.key === 'name');
      if (titleField) map[titleField.value.toLowerCase()] = obj.id;
    }

    if (!data.metaobjects.pageInfo.hasNextPage) break;
    cursor = data.metaobjects.pageInfo.endCursor;
  }

  console.log(`✅ Fetched ${Object.keys(map).length / 2} genre metaobjects`);
  return map;
}

// ---------------------------------------------------------------------------
// Fetch collection by handle
// ---------------------------------------------------------------------------
async function fetchCollectionByHandle(token, handle) {
  const data = await gql(token, `
    query($handle: String!) {
      collectionByHandle(handle: $handle) {
        id
        title
        metafield(namespace: "custom", key: "genre") {
          references(first: 20) {
            nodes { ... on Metaobject { id handle } }
          }
        }
      }
    }
  `, { handle });
  return data.collectionByHandle;
}

// ---------------------------------------------------------------------------
// Set genre metafield on a collection
// ---------------------------------------------------------------------------
async function setCollectionGenres(token, collectionId, genreGids) {
  const data = await gql(token, `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { key value }
        userErrors { field message }
      }
    }
  `, {
    metafields: [{
      ownerId:   collectionId,
      namespace: 'custom',
      key:       'genre',
      type:      'list.metaobject_reference',
      value:     JSON.stringify(genreGids),
    }],
  });

  const errors = data.metafieldsSet?.userErrors ?? [];
  if (errors.length > 0) throw new Error(JSON.stringify(errors));
}

// ---------------------------------------------------------------------------
// Fetch and parse Excel from GitHub
// ---------------------------------------------------------------------------
async function readExcelFromURL(url) {
  console.log('📥 Fetching Excel from GitHub…');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch Excel: ${res.status} ${res.statusText}`);
  const buffer = await res.arrayBuffer();
  const wb = XLSX.read(buffer, { type: 'array' });
  const ws = wb.Sheets['Collections_missing_genre'];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  return rows.map(row => ({
    handle: row['Handle']?.toString().trim(),
    title:  row['Title']?.toString().trim(),
    genres: row['Metafield: custom.genre [list.metaobject_reference]']
      ?.toString()
      .split(',')
      .map(g => g.trim())
      .filter(Boolean) ?? [],
  })).filter(r => r.handle && r.genres.length > 0);
}

// ---------------------------------------------------------------------------
// Main — exported so server.js can call it via the UI button
// ---------------------------------------------------------------------------
export async function backfillCollectionGenres() {
  console.log('🚀 Genre backfill starting…\n');

  const token = await getAccessToken();
  console.log('✅ Authenticated\n');

  const genreMap = await fetchGenreMap(token);
  const rows = await readExcelFromURL(EXCEL_URL);
  console.log(`📊 Found ${rows.length} collections to process\n`);

  const stats = { updated: 0, skipped: 0, errors: 0, missing_genres: [] };

  for (const row of rows) {
    try {
      const collection = await fetchCollectionByHandle(token, row.handle);

      if (!collection) {
        console.log(`  ⚠  "${row.handle}" — not found in Shopify, skipping`);
        stats.skipped++;
        await sleep(THROTTLE_MS);
        continue;
      }

      // Resolve genre handles to GIDs
      const genreGids = [];
      const missing = [];

      for (const genreHandle of row.genres) {
        const gid = genreMap[genreHandle] || genreMap[genreHandle.replace('genre.', '')];
        if (gid) genreGids.push(gid);
        else missing.push(genreHandle);
      }

      if (missing.length > 0) {
        console.log(`  ⚠  "${collection.title}" — unknown genres: ${missing.join(', ')}`);
        stats.missing_genres.push(...missing);
      }

      if (genreGids.length === 0) {
        console.log(`  ⏭  "${collection.title}" — no resolvable genres, skipping`);
        stats.skipped++;
        await sleep(THROTTLE_MS);
        continue;
      }

      // Merge with existing genres
      const existingGids = (collection.metafield?.references?.nodes ?? []).map(n => n.id);
      const mergedGids = [...new Set([...existingGids, ...genreGids])];

      if (mergedGids.length === existingGids.length &&
          mergedGids.every(g => existingGids.includes(g))) {
        console.log(`  ⏭  "${collection.title}" — already up to date, skipping`);
        stats.skipped++;
        await sleep(THROTTLE_MS);
        continue;
      }

      await setCollectionGenres(token, collection.id, mergedGids);
      const added = genreGids.filter(g => !existingGids.includes(g));
      console.log(`  ✅ "${collection.title}" — added ${added.length} genre(s): ${row.genres.join(', ')}`);
      stats.updated++;

    } catch (err) {
      console.log(`  ✖  "${row.handle}" — ${err.message}`);
      stats.errors++;
    }

    await sleep(THROTTLE_MS);
  }

  console.log(`\n✔  Done — ${stats.updated} updated, ${stats.skipped} skipped, ${stats.errors} errors`);

  if (stats.missing_genres.length > 0) {
    const unique = [...new Set(stats.missing_genres)];
    console.log(`\n⚠  Unresolved genre handles:\n  ${unique.join('\n  ')}`);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
