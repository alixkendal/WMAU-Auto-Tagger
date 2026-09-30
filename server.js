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
// One rules document per store, named after the store unless RULES_DOC_ID says
// otherwise: warner-music-australia.myshopify.com -> "rules-warner-music-australia".
// No store is the built-in default, so two services can never share rules by accident.
const SHOP_HANDLE = (process.env.SHOPIFY_SHOP || '').trim().toLowerCase().replace(/\.myshopify\.com$/, '');
const RULES_DOC_ID = process.env.RULES_DOC_ID || (SHOP_HANDLE ? `rules-${SHOP_HANDLE}` : '');
if (!RULES_DOC_ID) throw new Error('Set SHOPIFY_SHOP (or RULES_DOC_ID) so this service knows which rules to use.');
const RULES = db.collection('auto-tagger');
const RULES_DOC = RULES.doc(RULES_DOC_ID);
const STORE_NAME = process.env.STORE_NAME || SHOP_HANDLE || RULES_DOC_ID;
const DRY_RUN = process.env.DRY_RUN === 'true';
// One-off rename helper: if this service's rules document does not exist yet, copy it
// from the document named here (the source is left untouched). Remove once copied.
const RULES_MIGRATE_FROM = process.env.RULES_MIGRATE_FROM;

log('info', `📒 Store "${STORE_NAME}" — rules document "auto-tagger/${RULES_DOC_ID}"`);

// Returns the saved rules, or the starter set when nothing has been saved yet.
// Throws if Firestore can't be read: callers must not act on starter rules just
// because the real ones were unreachable.
export async function loadRules() {
  const snap = await RULES_DOC.get();
  if (snap.exists) return snap.data().list || [];

  if (RULES_MIGRATE_FROM && RULES_MIGRATE_FROM !== RULES_DOC_ID) {
    const source = await RULES.doc(RULES_MIGRATE_FROM).get();
    if (source.exists) {
      const list = source.data().list || [];
      await RULES_DOC.set({ list });
      log('info', `📒 Copied ${list.length} rules from "${RULES_MIGRATE_FROM}" to "${RULES_DOC_ID}"`);
      return list;
    }
    log('warn', `RULES_MIGRATE_FROM="${RULES_MIGRATE_FROM}" not found — starting from the starter rules`);
  }
  return getDefaultRules();
}

// Express 4 doesn't catch rejected async handlers; answer 503 instead of crashing.
const route = (handler) => (req, res) => handler(req, res).catch((err) => {
  log('error', `${req.method} ${req.path} failed: ${err.message}`);
  if (!res.headersSent) res.status(503).json({ error: 'Rules storage unavailable, try again shortly' });
});

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

app.get('/api/rules', route(async (req, res) => { res.json(await loadRules()); }));

app.post('/api/rules', route(async (req, res) => {
  const rules = await loadRules();
  const rule = { ...req.body, id: Date.now().toString(), enabled: true };
  rules.push(rule);
  await saveRules(rules);
  res.json(rule);
}));

app.put('/api/rules/:id', route(async (req, res) => {
  const rules = await loadRules();
  const idx = rules.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  rules[idx] = { ...rules[idx], ...req.body };
  await saveRules(rules);
  res.json(rules[idx]);
}));

app.delete('/api/rules/:id', route(async (req, res) => {
  const rules = (await loadRules()).filter(r => r.id !== req.params.id);
  await saveRules(rules);
  res.json({ ok: true });
}));

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
