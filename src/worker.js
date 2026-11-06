// SoukMate worker: AI assistant (Gemini) + PayPal Orders API v2 (sandbox) + static assets.
import { CATALOG } from "./catalog.js";

const GEMINI_MODEL = "gemini-2.0-flash";
const PP_BASE = "https://api-m.sandbox.paypal.com"; // sandbox only - no real money

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/assistant" && request.method === "POST") return await handleAssistant(request, env);
      if (url.pathname === "/api/catalog") return json({ items: CATALOG });
      if (url.pathname === "/api/config") return json({ paypalClientId: env.PAYPAL_CLIENT_ID || null, currency: "USD", sandbox: true });
      if (url.pathname === "/api/paypal/order" && request.method === "POST") return await createPaypalOrder(request, env);
      const cap = url.pathname.match(/^\/api\/paypal\/order\/([A-Za-z0-9]+)\/capture$/);
      if (cap && request.method === "POST") return await capturePaypalOrder(cap[1], env);
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  }
};

// ---------- AI assistant ----------
async function handleAssistant(request, env) {
  const body = await request.json().catch(() => ({}));
  const message = String(body.message || "").slice(0, 1000);
  if (!message.trim()) return json({ error: "message is required" }, 400);

  const compact = CATALOG.map(c => `${c.id} | ${c.name} | $${c.price} | ${c.tag}`).join("\n");
  const prompt = [
    "You are SoukMate, a shopping assistant for a Moroccan artisan goods store.",
    "From the customer message, choose products ONLY from this catalog (id | name | price | tags):",
    compact,
    "Rules: respect any stated budget; pick 1-4 items; qty 1-3 each.",
    'Answer with STRICT JSON only: {"items":[{"id":"...","qty":1}],"reply":"one or two friendly sentences naming what you picked and why"}.',
    "If nothing fits, return empty items and explain in reply.",
    "Customer message: " + JSON.stringify(message)
  ].join("\n");

  // AI path 1: Cloudflare Workers AI (free daily allocation on the Workers Free plan, no key needed).
  // AI path 2: Gemini, only when GEMINI_API_KEY is set. Path 3: offline matcher.
  let parsed = null, source = "offline-matcher";
  if (env.AI) {
    try {
      const out = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages: [{ role: "user", content: prompt + "\nRespond with JSON only, no markdown." }],
        max_tokens: 400
      });
      const text = (typeof out?.response === "string" && out.response)
        || out?.choices?.[0]?.message?.content || "";
      parsed = text ? JSON.parse(String(text).replace(/```json|```/g, "").trim()) : null;
      if (parsed) source = "workers-ai";
    } catch (e) { parsed = null; aiErr = String((e && e.message) || e); }
  }
  if (!parsed && env.GEMINI_API_KEY) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
        { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.3 } }) });
      const data = await r.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      if (parsed) source = "gemini";
    } catch (e) { parsed = null; }
  }
  if (!parsed) parsed = offlineMatch(message);

  // Validate against catalog; recompute prices server-side (never trust the client or the model).
  const byId = new Map(CATALOG.map(c => [c.id, c]));
  const items = [];
  for (const it of Array.isArray(parsed.items) ? parsed.items : []) {
    const c = byId.get(String(it.id));
    const qty = Math.max(1, Math.min(3, parseInt(it.qty, 10) || 1));
    if (c) items.push({ id: c.id, name: c.name, price: c.price, qty, lineTotal: +(c.price * qty).toFixed(2) });
  }
  // Hard budget enforcement, server-side: never trust the model to respect a stated budget.
  const bm = message.toLowerCase().match(/(?:under|below|max|less than|budget(?: of)?|\$)\s*\$?\s*(\d+)/);
  let trimmed = false, budget = 0;
  if (bm) {
    budget = parseInt(bm[1], 10);
    let sum = items.reduce((s2, i) => s2 + i.lineTotal, 0);
    while (items.length > 1 && sum > budget) { sum -= items.pop().lineTotal; trimmed = true; }
    if (items.length === 1 && sum > budget) { items.pop(); trimmed = true; }
  }
  const total = +items.reduce((s, i) => s + i.lineTotal, 0).toFixed(2);
  let reply = String(parsed.reply || "Here is what I found.");
  if (trimmed) reply += items.length
    ? " I kept the cart within your $" + budget + " budget."
    : " Nothing in the catalog fits that budget - try a higher one.";
  return json({ reply, items, total, ai: source });
}

// Used only when GEMINI_API_KEY is missing/unreachable; the real path is the model above.
function offlineMatch(message) {
  const m = message.toLowerCase();
  const budget = (m.match(/(?:under|below|max|\$)\s*\$?\s*(\d+)/) || [])[1];
  const words = m.split(/[^a-z']+/).filter(Boolean);
  const scored = CATALOG.map(c => {
    const hay = (c.name + " " + c.tag).toLowerCase();
    let s = 0; for (const w of words) if (w.length > 3 && hay.includes(w)) s++;
    if (/gift/.test(m) && /gift/.test(hay)) s++;
    if (/mother|mom|woman|her/.test(m) && /cosmetic|rose|argan|tea/.test(hay)) s++;
    return { c, s };
  }).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
  let items = [], sum = 0;
  for (const { c } of scored) {
    if (items.length >= 3) break;
    if (budget && sum + c.price > +budget) continue;
    items.push({ id: c.id, qty: 1 }); sum += c.price;
  }
  return { items, reply: items.length ? "Picked from catalog keywords (offline matcher)." : "No catalog match found." };
}

// ---------- PayPal Orders API v2 (sandbox) ----------
let cachedToken = null, tokenExp = 0;
async function paypalToken(env) {
  if (cachedToken && Date.now() < tokenExp) return cachedToken;
  const r = await fetch(`${PP_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { authorization: "Basic " + btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`),
      "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials"
  });
  const d = await r.json();
  if (!r.ok) throw new Error("PayPal auth failed: " + (d.error_description || r.status));
  cachedToken = d.access_token; tokenExp = Date.now() + (d.expires_in - 60) * 1000;
  return cachedToken;
}

async function createPaypalOrder(request, env) {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET)
    return json({ error: "PayPal sandbox credentials not configured" }, 501);
  const { items } = await request.json().catch(() => ({}));
  const byId = new Map(CATALOG.map(c => [c.id, c]));
  const lines = (Array.isArray(items) ? items : [])
    .map(i => ({ c: byId.get(String(i.id)), q: Math.max(1, Math.min(3, parseInt(i.qty, 10) || 1)) }))
    .filter(x => x.c);
  if (!lines.length) return json({ error: "no valid items" }, 400);
  const total = lines.reduce((s, x) => s + x.c.price * x.q, 0).toFixed(2);
  const order = {
    intent: "CAPTURE",
    purchase_units: [{
      description: "SoukMate artisan order",
      amount: { currency_code: "USD", value: total,
        breakdown: { item_total: { currency_code: "USD", value: total } } },
      items: lines.map(x => ({ name: x.c.name, quantity: String(x.q),
        unit_amount: { currency_code: "USD", value: x.c.price.toFixed(2) }, category: "PHYSICAL_GOODS" }))
    }]
  };
  const token = await paypalToken(env);
  const r = await fetch(`${PP_BASE}/v2/checkout/orders`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(order)
  });
  const d = await r.json();
  if (!r.ok) return json({ error: "PayPal create failed", detail: d }, 502);
  return json({ orderID: d.id, status: d.status, total, currency: "USD" });
}

async function capturePaypalOrder(orderId, env) {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET)
    return json({ error: "PayPal sandbox credentials not configured" }, 501);
  const token = await paypalToken(env);
  const r = await fetch(`${PP_BASE}/v2/checkout/orders/${orderId}/capture`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }
  });
  const d = await r.json();
  if (!r.ok) return json({ error: "PayPal capture failed", detail: d }, 502);
  const cap = d.purchase_units?.[0]?.payments?.captures?.[0];
  return json({ orderID: d.id, status: d.status, captureID: cap?.id || null,
    amount: cap?.amount?.value || null, currency: cap?.amount?.currency_code || "USD",
    payerEmail: d.payer?.email_address || null });
}
