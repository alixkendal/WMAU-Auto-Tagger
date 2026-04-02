import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { runAllRules } from './tagger.js';
import { log } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
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
const RULES_DOC = db.collection('auto-tagger').doc('rules');

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

app.get('/api/rules', async (req, res) => {
  res.json(await loadRules());
});

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log('info', `🌐 Rules UI at http://localhost:${PORT}`));

function getDefaultRules() {
  return [
    {
      id: '1', enabled: true,
      description: 'New arrivals',
      conditions: [{ condition: 'created_within_days', conditionValue: '90', logic: null }],
      tags: 'New Arrival',
    },
    {
      id: '2', enabled: true,
      description: 'Hats',
      conditions: [
        { condition: 'product_type_is', conditionValue: 'hat',    logic: null },
        { condition: 'product_type_is', conditionValue: 'beanie', logic: 'OR' },
      ],
      tags: 'Product:Hat, Product:Merch, Product:Accessories',
    },
    {
      id: '3', enabled: true,
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
      id: '4', enabled: true,
      description: 'Bags',
      conditions: [
        { condition: 'product_type_is', conditionValue: 'Bum Bag', logic: null },
        { condition: 'product_type_is', conditionValue: 'Tote',    logic: 'OR' },
        { condition: 'product_type_is', conditionValue: 'Bag',     logic: 'OR' },
      ],
      tags: 'Product:Bag, Product:Merch, Product:Accessories',
    },
    {
      id: '5', enabled: true,
      description: 'Vinyl',
      conditions: [
        { condition: 'product_type_contains', conditionValue: 'Vinyl', logic: null },
        { condition: 'product_type_contains', conditionValue: 'LP',    logic: 'OR' },
      ],
      tags: 'Product:Vinyl, Product:Music',
    },
    {
      id: '6', enabled: false,
      description: 'Low stock',
      conditions: [{ condition: 'inventory_lt', conditionValue: '10', logic: null }],
      tags: 'Last Chance',
    },
    {
      id: '7', enabled: false,
      description: 'Out of stock',
      conditions: [{ condition: 'inventory_eq', conditionValue: '0', logic: null }],
      tags: 'Out of Stock',
    },
  ];
}
