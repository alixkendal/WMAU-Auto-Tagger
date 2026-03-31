/**
 * Core tagging engine.
 * Evaluates all RULES against all products and applies the minimal
 * set of tag additions / removals needed.
 */

import { RULES, THROTTLE_MS } from './config.js';
import { fetchAllProducts, updateProductTags } from './shopify.js';
import { log } from './logger.js';

// ---------------------------------------------------------------------------
// Main entry point — called by the scheduler
// ---------------------------------------------------------------------------
export async function runAllRules() {
  const startTime = Date.now();
  log('info', '▶  Starting tagging run…');

  let products;
  try {
    products = await fetchAllProducts();
    log('info', `✅ Fetched ${products.length} products`);
  } catch (err) {
    log('error', `Failed to fetch products: ${err.message}`);
    return;
  }

  const stats = { checked: 0, updated: 0, unchanged: 0, errors: 0 };

  for (const product of products) {
    stats.checked++;
    try {
      const changed = await applyRulesToProduct(product);
      if (changed) stats.updated++;
      else stats.unchanged++;
    } catch (err) {
      stats.errors++;
      log('error', `Product ${product.id} ("${product.title}"): ${err.message}`);
    }

    // Throttle between updates to stay within Shopify's rate limits
    if (stats.checked % 10 === 0) {
      log('info', `  … processed ${stats.checked}/${products.length}`);
    }
    await sleep(THROTTLE_MS);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log('info', `✔  Run complete in ${elapsed}s — ${stats.updated} updated, ${stats.unchanged} unchanged, ${stats.errors} errors`);
}

// ---------------------------------------------------------------------------
// Evaluate all rules for a single product and update if needed
// ---------------------------------------------------------------------------
async function applyRulesToProduct(product) {
  // Parse existing tags into a Set for fast lookups
  const currentTags = parseTags(product.tags);
  const desiredTags = new Set(currentTags);

  const changes = [];

  for (const rule of RULES) {
    for (const tag of rule.tags) {
      const has = desiredTags.has(tag);

      if (!has && rule.shouldAdd(product)) {
        desiredTags.add(tag);
        changes.push(`+${tag} (rule: ${rule.id})`);
      }

      if (has && rule.shouldRemove && rule.shouldRemove(product)) {
        desiredTags.delete(tag);
        changes.push(`-${tag} (rule: ${rule.id})`);
      }
    }
  }

  if (changes.length === 0) return false; // nothing to do

  log('info', `  🏷  "${product.title}" [${product.id}]: ${changes.join(' | ')}`);
  await updateProductTags(product.id, [...desiredTags]);
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseTags(tagsString) {
  if (!tagsString) return [];
  return tagsString.split(',').map(t => t.trim()).filter(Boolean);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
