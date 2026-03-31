# Shopify Auto-Tagger

A lightweight Node.js service that automatically adds and removes product tags on your Shopify store based on configurable rules. Runs on a cron schedule — no third-party app subscriptions required.

---

## Features

- ✅ Inventory-based tags — `Last Chance` when stock < 10, `Out of Stock` when 0
- ✅ Time-based tags — `New Arrival` for N days, then automatically removed
- ✅ Product-type → tag mapping (e.g. `cap` → `Product:Hat`, `Page:Merch`)
- ✅ Fully configurable rules in one file (`config.js`)
- ✅ Handles stores of any size via automatic pagination
- ✅ Rate-limit safe — built-in throttling between API calls
- ✅ Runs on any server, VPS, or cloud function

---

## Quick Start

### 1. Prerequisites

- Node.js 18+
- A Shopify **Custom App** with an Admin API access token

### 2. Create a Shopify Custom App

1. Go to **Shopify Admin → Settings → Apps and sales channels → Develop apps**
2. Click **Create an app**, give it a name (e.g. "Auto Tagger")
3. Under **Configuration → Admin API scopes**, enable:
   - `read_products`
   - `write_products`
   - `read_inventory` *(needed for inventory counts)*
4. Click **Install app** and copy the **Admin API access token** (shown once)

### 3. Install & configure

```bash
# Clone / download the project
cd shopify-auto-tagger

# Install dependencies
npm install

# Set up credentials
cp .env.example .env
# Edit .env with your shop domain and token
```

### 4. Configure your rules

Open `config.js` — this is the only file you need to edit for most use cases:

```js
// Change the New Arrival window:
export const NEW_ARRIVAL_DAYS = 90; // or 180 for 6 months

// Add / edit product-type → tag mappings:
...buildProductTypeRules({
  cap:    ['Product:Hat', 'Page:Merch', 'Page:Accessories'],
  hoodie: ['Product:Hoodie', 'Page:Merch', 'Page:Apparel'],
  // add more types here...
}),
```

### 5. Run

```bash
# Run once (great for testing)
npm run run-once

# Run as a persistent service (stays alive, runs on schedule)
npm start
```

---

## Rule Reference

Each rule in `config.js` has this shape:

```js
{
  id: 'my-rule',             // Unique identifier (used in logs)
  description: 'What it does',
  shouldAdd:    (product) => boolean,   // Add the tags when true
  shouldRemove: (product) => boolean,   // Remove the tags when true
  tags: ['Tag One', 'Tag Two'],
}
```

The `product` object is the standard Shopify REST product resource, so you can use any field:
- `product.product_type` — product type
- `product.tags` — current tag string
- `product.created_at` — creation date
- `product.variants[].inventory_quantity` — stock per variant
- `product.vendor`, `product.status`, etc.

### Example custom rules

```js
// Tag products by vendor
{
  id: 'vendor-nike',
  description: 'Nike products',
  shouldAdd:    (p) => p.vendor === 'Nike',
  shouldRemove: (p) => p.vendor !== 'Nike',
  tags: ['Brand:Nike'],
},

// Tag draft/hidden products
{
  id: 'draft-status',
  description: 'Unpublished products',
  shouldAdd:    (p) => p.status === 'draft',
  shouldRemove: (p) => p.status !== 'draft',
  tags: ['Hidden'],
},

// Tag products with a price over $100 (requires variants field)
{
  id: 'premium-price',
  description: 'Products over $100',
  shouldAdd:    (p) => parseFloat(p.variants?.[0]?.price) > 100,
  shouldRemove: (p) => parseFloat(p.variants?.[0]?.price) <= 100,
  tags: ['Premium'],
},
```

---

## Deployment Options

### Option A — Always-on VPS / server (recommended)

Use [PM2](https://pm2.keymetrics.io/) to keep the process alive:

```bash
npm install -g pm2
pm2 start index.js --name shopify-auto-tagger
pm2 save
pm2 startup   # Auto-restart on reboot
```

### Option B — Scheduled cloud function (serverless)

Deploy `tagger.js` as a serverless function and invoke it via a cloud scheduler:

| Platform | Scheduler |
|---|---|
| AWS | Lambda + EventBridge |
| GCP | Cloud Functions + Cloud Scheduler |
| Vercel | Vercel Cron Jobs |
| Railway / Render | Built-in cron |

For serverless, call `runAllRules()` directly from your handler — no `node-cron` needed.

### Option C — GitHub Actions (free, simple)

```yaml
# .github/workflows/auto-tag.yml
name: Auto-Tag Products
on:
  schedule:
    - cron: '0 * * * *'   # every hour
jobs:
  tag:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm run run-once
        env:
          SHOPIFY_SHOP:  ${{ secrets.SHOPIFY_SHOP }}
          SHOPIFY_TOKEN: ${{ secrets.SHOPIFY_TOKEN }}
```

---

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `SHOPIFY_SHOP` | `your-store.myshopify.com` | *(required)* |
| `SHOPIFY_TOKEN` | Admin API access token | *(required)* |
| `TAGGER_SCHEDULE` | Cron expression | `0 * * * *` (hourly) |

---

## File Structure

```
shopify-auto-tagger/
├── index.js       — Entry point & cron scheduler
├── config.js      — ⭐ All rules & settings (edit this)
├── tagger.js      — Rule evaluation engine
├── shopify.js     — Shopify API client (REST + GraphQL)
├── logger.js      — Timestamped console logger
├── package.json
└── .env.example
```

---

## Extending

To add a **webhook-triggered** run (e.g. instantly tag a product the moment it's created), expose an HTTP endpoint that calls `runAllRules()` or a targeted single-product version, and register it as a Shopify webhook under **Settings → Notifications → Webhooks**.
