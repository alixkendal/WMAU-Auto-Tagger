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
    if (stats.checked % 10 === 0) log('info', `  … processed ${stats.checked}/${products.length}`);
    await sleep(THROTTLE_MS);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log('info', `✔  Done in ${elapsed}s — ${stats.updated} updated, ${stats.unchanged} unchanged, ${stats.errors} errors`);
}

async function applyRulesToProduct(product, rules) {
  const desiredTags = new Set(parseTags(product.tags));
  const changes = [];

  for (const rule of rules) {
    const matches = ruleMatches(rule, product);
    for (const tag of parseTags(rule.tags)) {
      const has = desiredTags.has(tag);
      if (matches && !has)  { desiredTags.add(tag);    changes.push(`+${tag}`); }
      if (!matches && has)  { desiredTags.delete(tag); changes.push(`-${tag}`); }
    }
  }

  if (changes.length === 0) return false;
  log('info', `  🏷  "${product.title}": ${changes.join(' | ')}`);
  await updateProductTags(product.id, [...desiredTags]);
  return true;
}

/**
 * Evaluate a rule's conditions against a product.
 * Conditions are evaluated left-to-right with AND/OR operators.
 * First condition has no operator (logic: null) — treated as the initial value.
 */
function ruleMatches(rule, product) {
  // Support legacy single-condition rules
  const conds = rule.conditions || [{ condition: rule.condition, conditionValue: rule.conditionValue, logic: null }];
  if (conds.length === 0) return false;

  let result = evaluateCondition(conds[0], product);

  for (let i = 1; i < conds.length; i++) {
    const c = conds[i];
    const val = evaluateCondition(c, product);
    if (c.logic === 'AND') result = result && val;
    else                   result = result || val;  // default OR
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
