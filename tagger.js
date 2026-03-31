/**
 * Core tagging engine.
 * Reads rules from rules.json (managed via the UI) and applies them to all products.
 */

import { THROTTLE_MS } from './config.js';
import { fetchAllProducts, updateProductTags } from './shopify.js';
import { log } from './logger.js';
import { loadRules } from './server.js';

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

  const rules = loadRules().filter(r => r.enabled);
  log('info', `📋 Applying ${rules.length} active rules`);

  const stats = { checked: 0, updated: 0, unchanged: 0, errors: 0 };

  for (const product of products) {
    stats.checked++;
    try {
      const changed = await applyRulesToProduct(product, rules);
      if (changed) stats.updated++;
      else stats.unchanged++;
    } catch (err) {
      stats.errors++;
      log('error', `Product ${product.id} ("${product.title}"): ${err.message}`);
    }

    if (stats.checked % 10 === 0) {
      log('info', `  … processed ${stats.checked}/${products.length}`);
    }
    await sleep(THROTTLE_MS);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log('info', `✔  Run complete in ${elapsed}s — ${stats.updated} updated, ${stats.unchanged} unchanged, ${stats.errors} errors`);
}

async function applyRulesToProduct(product, rules) {
  const currentTags = parseTags(product.tags);
  const desiredTags = new Set(currentTags);
  const changes = [];

  for (const rule of rules) {
    const ruleTags = parseTags(rule.tags);
    const matches = evaluateCondition(rule, product);

    for (const tag of ruleTags) {
      const has = desiredTags.has(tag);
      if (matches && !has) { desiredTags.add(tag); changes.push(`+${tag}`); }
      if (!matches && has) { desiredTags.delete(tag); changes.push(`-${tag}`); }
    }
  }

  if (changes.length === 0) return false;
  log('info', `  🏷  "${product.title}": ${changes.join(' | ')}`);
  await updateProductTags(product.id, [...desiredTags]);
  return true;
}

function evaluateCondition(rule, product) {
  const val = rule.conditionValue;
  const inventory = getTotalInventory(product);
  switch (rule.condition) {
    case 'inventory_lt':          return inventory < parseInt(val);
    case 'inventory_eq':          return inventory === parseInt(val);
    case 'inventory_gt':          return inventory > parseInt(val);
    case 'product_type_is':       return product.product_type?.toLowerCase() === val.toLowerCase();
    case 'product_type_contains': return product.product_type?.toLowerCase().includes(val.toLowerCase());
    case 'vendor_is':             return product.vendor?.toLowerCase() === val.toLowerCase();
    case 'created_within_days':   return daysSince(product.created_at) <= parseInt(val);
    case 'older_than_days':       return daysSince(product.created_at) > parseInt(val);
    case 'status_is':             return product.status === val;
    case 'title_contains':        return product.title?.toLowerCase().includes(val.toLowerCase());
    default: return false;
  }
}

function getTotalInventory(p) {
  return (p.variants || []).reduce((s, v) => s + (v.inventory_quantity ?? 0), 0);
}
function daysSince(d) {
  return (Date.now() - new Date(d).getTime()) / (1000 * 60 * 60 * 24);
}
function parseTags(str) {
  if (!str) return [];
  return str.split(',').map(t => t.trim()).filter(Boolean);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
