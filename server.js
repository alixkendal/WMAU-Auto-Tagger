import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { runAllRules } from './tagger.js';
import { log } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Optional password for the rules UI + API. Set ADMIN_PASSWORD to turn it on
// (any username). Without it the service is open to anyone with the URL.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (ADMIN_PASSWORD) {
  app.use((req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    const password = scheme === 'Basic' ? Buffer.from(encoded || '', 'base64').toString().split(':').slice(1).join(':') : '';
    if (password === ADMIN_PASSWORD) return next();
    res.set('WWW-Authenticate', 'Basic realm="Auto-Tagger"').status(401).send('Authentication required');
  });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

initializeApp({
  credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
});
const db = getFirestore();
// One rules document per store. RULES_DOC_ID defaults to 'rules' (the original
// Warner Music Australia document), so existing deployments are unaffected.
const RULES_DOC_ID = process.env.RULES_DOC_ID || 'rules';
const RULES_DOC = db.collection('auto-tagger').doc(RULES_DOC_ID);
const STORE_NAME = process.env.STORE_NAME || 'Warner Music Australia';
const DRY_RUN = process.env.DRY_RUN === 'true';

export async function loadRules() {
  try {
    const snap = await RULES_DOC.get();
    if (snap.exists) return snap.data().list || [];
  } catch (err) {
    log('error', `Firestore load failed: ${err.message}`);
  }
  return getDefaultRules();
}

async function saveRules(rules) {
  await RULES_DOC.set({ list: rules });
}

app.get('/api/config', (req, res) => {
  res.json({ storeName: STORE_NAME, shop: process.env.SHOPIFY_SHOP || null, dryRun: DRY_RUN, rulesDoc: RULES_DOC_ID });
});

// Backfills write metafields/tags directly, so they are switched off in dry-run mode.
function blockedInDryRun(req, res, next) {
  if (!DRY_RUN) return next();
  res.status(409).json({ ok: false, message: 'Backfills are disabled while DRY_RUN=true' });
}

app.get('/api/rules', async (req, res) => { res.json(await loadRules()); });

app.post('/api/rules', async (req, res) => {
  const rules = await loadRules();
  const rule = { ...req.body, id: Date.now().toString(), enabled: true };
  rules.push(rule);
  await saveRules(rules);
  res.json(rule);
});

app.put('/api/rules/:id', async (req, res) => {
  const rules = await loadRules();
  const idx = rules.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  rules[idx] = { ...rules[idx], ...req.body };
  await saveRules(rules);
  res.json(rules[idx]);
});

app.delete('/api/rules/:id', async (req, res) => {
  const rules = (await loadRules()).filter(r => r.id !== req.params.id);
  await saveRules(rules);
  res.json({ ok: true });
});

app.post('/api/run-now', async (req, res) => {
  res.json({ ok: true });
  runAllRules().catch(err => log('error', err.message));
});

app.post('/api/run-genres', async (req, res) => {
  res.json({ ok: true });
  const { runGenreTagger } = await import('./genre-tagger.js');
  runGenreTagger().catch(err => log('error', err.message));
});

app.post('/api/backfill-product-prefix', blockedInDryRun, async (req, res) => {
  res.json({ ok: true, message: 'Product: prefix cleanup started — check Railway logs' });
  const { backfillRemoveProductPrefix } = await import('./backfill-remove-product-prefix.js');
  backfillRemoveProductPrefix().catch(err => log('error', err.message));
});

app.post('/api/backfill-collection-genres', blockedInDryRun, async (req, res) => {
  res.json({ ok: true, message: 'Collection genre backfill started — check Railway logs' });
  const { backfillCollectionGenres } = await import('./backfill-collection-genres.js');
  backfillCollectionGenres().catch(err => log('error', err.message));
});

app.post('/api/backfill-preorder-dates', blockedInDryRun, async (req, res) => {
  res.json({ ok: true, message: 'Pre-order date backfill started — check Railway logs' });
  const { backfillPreorderDates } = await import('./backfill-preorder-dates.js');
  backfillPreorderDates().catch(err => log('error', err.message));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log('info', `🌐 Rules UI at http://localhost:${PORT}`));

// Starter rules for a store with nothing saved yet: default-rules.json if present
// (a snapshot of the Warner Music Australia rule set), else the built-in list below.
function getDefaultRules() {
  try {
    const seeded = JSON.parse(fs.readFileSync(path.join(__dirname, 'default-rules.json'), 'utf8'));
    if (Array.isArray(seeded) && seeded.length > 0) return seeded;
  } catch {
    // no seed file, or unreadable: fall through to the built-in defaults
  }
  return [
    {
      id: '1', enabled: true, autoRemove: true,
      description: 'New arrivals',
      conditions: [{ condition: 'created_within_days', conditionValue: '90', logic: null }],
      tags: 'New Arrival',
    },
    {
      id: '2', enabled: true, autoRemove: false,
      description: 'Hats',
      conditions: [
        { condition: 'product_type_is', conditionValue: 'hat',    logic: null },
        { condition: 'product_type_is', conditionValue: 'beanie', logic: 'OR' },
      ],
      tags: 'Product:Hat, Product:Merch, Product:Accessories',
    },
    {
      id: '3', enabled: true, autoRemove: false,
      description: 'Jewellery',
      conditions: [
        { condition: 'product_type_is', conditionValue: 'Bracelet',  logic: null },
        { condition: 'product_type_is', conditionValue: 'Necklace',  logic: 'OR' },
        { condition: 'product_type_is', conditionValue: 'Earrings',  logic: 'OR' },
        { condition: 'product_type_is', conditionValue: 'Pendant',   logic: 'OR' },
        { condition: 'product_type_is', conditionValue: 'Jewellery', logic: 'OR' },
        { condition: 'product_type_is', conditionValue: 'Jewelry',   logic: 'OR' },
      ],
      tags: 'Product:Jewellery, Product:Merch, Product:Accessories',
    },
    {
      id: '4', enabled: true, autoRemove: false,
      description: 'Bags',
      conditions: [
        { condition: 'product_type_is', conditionValue: 'Bum Bag', logic: null },
        { condition: 'product_type_is', conditionValue: 'Tote',    logic: 'OR' },
        { condition: 'product_type_is', conditionValue: 'Bag',     logic: 'OR' },
      ],
      tags: 'Product:Bag, Product:Merch, Product:Accessories',
    },
    {
      id: '5', enabled: true, autoRemove: false,
      description: 'Vinyl',
      conditions: [
        { condition: 'product_type_contains', conditionValue: 'Vinyl', logic: null },
        { condition: 'product_type_contains', conditionValue: 'LP',    logic: 'OR' },
      ],
      tags: 'Product:Vinyl, Product:Music',
    },
    {
      id: '6', enabled: false, autoRemove: true,
      description: 'Low stock',
      conditions: [{ condition: 'inventory_lt', conditionValue: '10', logic: null }],
      tags: 'Last Chance',
    },
    {
      id: '7', enabled: false, autoRemove: true,
      description: 'Out of stock',
      conditions: [{ condition: 'inventory_eq', conditionValue: '0', logic: null }],
      tags: 'Out of Stock',
    },
  ];
}
