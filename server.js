/**
 * Rules management server
 * Serves the UI and exposes a simple REST API for managing tagging rules.
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runAllRules } from './tagger.js';
import { log } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_FILE = path.join(__dirname, 'rules.json');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Load / save rules from disk
// ---------------------------------------------------------------------------
export function loadRules() {
  if (!fs.existsSync(RULES_FILE)) return getDefaultRules();
  try {
    return JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
  } catch {
    return getDefaultRules();
  }
}

function saveRules(rules) {
  fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2));
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
app.get('/api/rules', (req, res) => {
  res.json(loadRules());
});

app.post('/api/rules', (req, res) => {
  const rules = loadRules();
  const rule = { ...req.body, id: Date.now().toString(), enabled: true };
  rules.push(rule);
  saveRules(rules);
  res.json(rule);
});

app.put('/api/rules/:id', (req, res) => {
  const rules = loadRules();
  const idx = rules.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  rules[idx] = { ...rules[idx], ...req.body };
  saveRules(rules);
  res.json(rules[idx]);
});

app.delete('/api/rules/:id', (req, res) => {
  const rules = loadRules().filter(r => r.id !== req.params.id);
  saveRules(rules);
  res.json({ ok: true });
});

app.post('/api/run-now', async (req, res) => {
  res.json({ ok: true, message: 'Tagging run started' });
  runAllRules().catch(err => log('error', err.message));
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log('info', `🌐 Rules UI available at http://localhost:${PORT}`);
});

// ---------------------------------------------------------------------------
// Default rules (used on first run)
// ---------------------------------------------------------------------------
function getDefaultRules() {
  return [
    {
      id: '1',
      enabled: true,
      description: 'Low stock warning',
      condition: 'inventory_lt',
      conditionValue: '10',
      tags: 'Last Chance',
    },
    {
      id: '2',
      enabled: true,
      description: 'Out of stock',
      condition: 'inventory_eq',
      conditionValue: '0',
      tags: 'Out of Stock',
    },
    {
      id: '3',
      enabled: true,
      description: 'New arrivals',
      condition: 'created_within_days',
      conditionValue: '90',
      tags: 'New Arrival',
    },
    {
      id: '4',
      enabled: true,
      description: 'Caps & hats',
      condition: 'product_type_is',
      conditionValue: 'cap',
      tags: 'Product:Hat, Page:Merch, Page:Accessories',
    },
  ];
}
