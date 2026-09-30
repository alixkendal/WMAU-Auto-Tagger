import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { runAllRules } from './tagger.js';
import { log } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ---------------------------------------------------------------------------
// Who may use the rules UI + API
//
// 1. Shopify admin users: the app is embedded in the store's admin, where App
//    Bridge attaches a short-lived ID token (a JWT signed with this app's client
//    secret) to every request. Nothing for staff to log in to.
// 2. ADMIN_PASSWORD (optional): HTTP Basic, for opening the Railway URL directly.
//
// Access is enforced when REQUIRE_SHOPIFY_AUTH=true or ADMIN_PASSWORD is set.
// With neither, the service is open to anyone with the URL.
// ---------------------------------------------------------------------------
const CLIENT_ID      = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET  = process.env.SHOPIFY_CLIENT_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const AUTH_REQUIRED  = process.env.REQUIRE_SHOPIFY_AUTH === 'true' || Boolean(ADMIN_PASSWORD);
const shopHost = (process.env.SHOPIFY_SHOP || '').trim().toLowerCase();

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

// True only for an unexpired Shopify ID token issued to this app for this store.
function isValidShopifyToken(token) {
  if (!token || !CLIENT_ID || !CLIENT_SECRET) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [header, payload, signature] = parts;
  try {
    if (JSON.parse(Buffer.from(header, 'base64url').toString()).alg !== 'HS256') return false;
    const expected = crypto.createHmac('sha256', CLIENT_SECRET).update(`${header}.${payload}`).digest();
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;

    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const now = Date.now() / 1000;
    const LEEWAY = 10; // seconds of clock drift tolerated
    if (!(claims.exp > now - LEEWAY) || !(claims.nbf <= now + LEEWAY)) return false;
    if (claims.aud !== CLIENT_ID) return false;
    const dest = hostOf(claims.dest);
    return Boolean(dest) && dest === hostOf(claims.iss) && dest === shopHost;
  } catch {
    return false;
  }
}

function hasValidPassword(req) {
  if (!ADMIN_PASSWORD) return false;
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Basic') return false;
  const given = Buffer.from(Buffer.from(encoded || '', 'base64').toString().split(':').slice(1).join(':'));
  const expected = Buffer.from(ADMIN_PASSWORD);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function authMethod(req) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Bearer' && isValidShopifyToken(token)) return 'shopify';
  if (hasValidPassword(req)) return 'password';
  return null;
}

// The rules page. Inside the Shopify admin (Shopify adds ?embedded=1&host=…) it is
// served with App Bridge, which supplies the ID tokens. Opened directly, it asks for
// ADMIN_PASSWORD when one is set.
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const APP_BRIDGE = CLIENT_ID
  ? `<meta name="shopify-api-key" content="${CLIENT_ID}">\n<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>\n`
  : '';

app.get(['/', '/index.html'], (req, res) => {
  const embedded = req.query.embedded === '1' || Boolean(req.query.host);
  if (!embedded && ADMIN_PASSWORD && !hasValidPassword(req)) {
    return res.set('WWW-Authenticate', 'Basic realm="Auto-Tagger"').status(401).send('Authentication required');
  }
  res.type('html').send(embedded ? INDEX_HTML.replace('<head>\n', `<head>\n${APP_BRIDGE}`) : INDEX_HTML);
});

// No WWW-Authenticate challenge here: a browser login box can't work inside the admin frame.
app.use('/api', (req, res, next) => {
  req.authMethod = authMethod(req);
  if (req.authMethod || !AUTH_REQUIRED) return next();
  res.status(401).json({ error: 'Open the Auto-Tagger from your Shopify admin to use it.' });
});

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
  res.json({
    storeName: STORE_NAME, shop: process.env.SHOPIFY_SHOP || null, dryRun: DRY_RUN, rulesDoc: RULES_DOC_ID,
    authRequired: AUTH_REQUIRED, signedInVia: req.authMethod,
  });
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
