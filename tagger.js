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

  const rules = (await loadRules()).filter(r => r.enabled);
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
    if (stats.checked % 10 === 0) log('info', `  … processed ${stats.checked}/${products.length}`);
    await sleep(THROTTLE_MS);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log('info', `✔  Done in ${elapsed}s — ${stats.updated} updated, ${stats.unchanged} unchanged, ${stats.errors} errors`);
}

async function applyRulesToProduct(product, rules) {
  const currentTags = parseTags(product.tags);
  const toAdd = new Set();
  const toRemove = new Set();

  for (const rule of rules) {
    if (rule.type === 'release_date') {
      applyReleaseDateRule(rule, product, toAdd, toRemove);
    } else {
      const matches = ruleMatches(rule, product);
      const autoRemove = rule.autoRemove !== false;
      for (const tag of parseTags(rule.tags)) {
        if (matches) toAdd.add(tag);
        else if (autoRemove) toRemove.add(tag);
      }
    }
  }

  // Never remove a tag another rule is actively adding
  const safeToRemove = new Set([...toRemove].filter(tag => !toAdd.has(tag)));

  const finalTags = new Set(currentTags);
  const changes = [];

  for (const tag of toAdd) {
    if (!finalTags.has(tag)) { finalTags.add(tag); changes.push(`+${tag}`); }
  }
  for (const tag of safeToRemove) {
    if (finalTags.has(tag)) { finalTags.delete(tag); changes.push(`-${tag}`); }
  }

  if (changes.length === 0) return false;
  log('info', `  🏷  "${product.title}": ${changes.join(' | ')}`);
  await updateProductTags(product.gid || product.id, [...finalTags]);
  return true;
}

// ---------------------------------------------------------------------------
// Release date rule logic
// ---------------------------------------------------------------------------
function applyReleaseDateRule(rule, product, toAdd, toRemove) {
  const metafieldKey = rule.metafieldKey; // e.g. "pre_order_date"
  const dateStr = product.metafields?.[metafieldKey];

  // No metafield set — ignore this product for this rule
  if (!dateStr) return;

  const releaseDate = new Date(dateStr);
  const now = new Date();
  const windowDays = parseInt(rule.windowDays) || 30;
  const daysSinceRelease = (now - releaseDate) / 86400000;

  if (daysSinceRelease < 0) {
    // Before release date → "before" tag
    toAdd.add(rule.beforeTag);
    toRemove.add(rule.afterTag);
  } else if (daysSinceRelease <= windowDays) {
    // Within window after release → "after" tag
    toRemove.add(rule.beforeTag);
    toAdd.add(rule.afterTag);
  } else {
    // Beyond window → remove both
    toRemove.add(rule.beforeTag);
    toRemove.add(rule.afterTag);
  }
}

// ---------------------------------------------------------------------------
// Standard rule evaluation
// ---------------------------------------------------------------------------
function ruleMatches(rule, product) {
  const conds = rule.conditions || [{ condition: rule.condition, conditionValue: rule.conditionValue, logic: null }];
  if (conds.length === 0) return false;
  let result = evaluateCondition(conds[0], product);
  for (let i = 1; i < conds.length; i++) {
    const val = evaluateCondition(conds[i], product);
    result = conds[i].logic === 'AND' ? result && val : result || val;
  }
  return result;
}

function evaluateCondition(c, product) {
  const val = c.conditionValue;
  const inv = getTotalInventory(product);
  switch (c.condition) {
    case 'inventory_lt':          return inv < parseInt(val);
    case 'inventory_eq':          return inv === parseInt(val);
    case 'inventory_gt':          return inv > parseInt(val);
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

function getTotalInventory(p) { return (p.variants||[]).reduce((s,v) => s+(v.inventory_quantity??0), 0); }
function daysSince(d) { return (Date.now() - new Date(d).getTime()) / 86400000; }
function parseTags(str) { return str ? str.split(',').map(t=>t.trim()).filter(Boolean) : []; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
