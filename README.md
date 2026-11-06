# SoukMate - AI Souk Shopping Assistant with PayPal Checkout

**PayPal AI Hackathon 2026 entry.** SoukMate is a web app where a shopper describes what they
want in plain language ("a gift for my mother under $60"), an AI assistant builds a cart from a
catalog of Moroccan artisan goods, and the shopper pays through a real PayPal checkout flow -
all running against the **PayPal sandbox** (no real money moves).

## What it does

1. **AI cart building** - the shopper's free-text request goes to a Gemini model
   (`gemini-2.0-flash`) which reads the product catalog and returns strict JSON
   (`{items:[{id, qty}], reply}`). The worker validates every id against the catalog,
   recomputes all prices server-side, and clamps quantities - the model never sets prices.
2. **PayPal checkout (sandbox)** - the frontend uses the PayPal JS SDK Smart Buttons.
   Order creation and capture happen server-side through the **PayPal Orders API v2**
   (`/v2/checkout/orders`, intent `CAPTURE`) with OAuth client-credentials auth, so the
   client secret never reaches the browser. Itemized amounts (per-product lines) are sent
   with each order.
3. **Order confirmation** - after buyer approval the worker captures the order and the UI
   shows the capture id, amount, and sandbox payer email.

## Architecture

```
Browser (public/)                Cloudflare Worker (src/worker.js)              External APIs
 chat UI + cart        POST /api/assistant  ->  Gemini generateContent (JSON)  -> generativelanguage.googleapis.com
 PayPal Smart Buttons  POST /api/paypal/order -> OAuth + Orders v2 create      -> api-m.sandbox.paypal.com
                       POST /api/paypal/order/:id/capture -> Orders v2 capture
```

- **Frontend**: vanilla HTML/CSS/JS in `public/` (served via Workers static assets).
- **Backend**: a single dependency-free Cloudflare Worker (`src/worker.js`).
- **AI**: Google Gemini 2.0 Flash via REST. A clearly-labelled offline keyword matcher
  (`offlineMatch`) exists only as a fallback when no API key is configured.
- **Payments**: PayPal sandbox only (`api-m.sandbox.paypal.com` is hard-coded).

## Run it locally (judges)

Prerequisites: Node.js 20+ and a free PayPal developer account.

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in the three values
npm run dev                      # http://localhost:8787
```

`.dev.vars` needs (all free):

| Key | Where to get it |
| --- | --- |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | <https://developer.paypal.com/dashboard> -> Apps & Credentials -> Sandbox -> create a REST app (default sandbox business account) |
| `GEMINI_API_KEY` | <https://aistudio.google.com/apikey> (free tier) |

To approve a payment in the demo, log into the PayPal popup with a **sandbox personal
(buyer) account** from the same developer dashboard (Sandbox -> Testing tools -> Accounts).

## Deploy (free tier)

```bash
npx wrangler deploy
npx wrangler secret put PAYPAL_CLIENT_SECRET
npx wrangler secret put GEMINI_API_KEY
# PAYPAL_CLIENT_ID is safe as a public var: npx wrangler secret put PAYPAL_CLIENT_ID (or [vars])
```

## Notes for judges

- Everything runs on free tiers: Cloudflare Workers + PayPal sandbox + Gemini free tier.
- The PayPal integration is central: real OAuth token exchange, real order creation with
  itemized breakdown, and real capture - exercised end-to-end in the demo video.
- Secrets are never committed; see `.dev.vars.example`.
- MIT License, (c) 2026 ISSAM MARHLIFI.
