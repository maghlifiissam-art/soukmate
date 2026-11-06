const chatLog = document.getElementById('chat-log');
const cartItemsEl = document.getElementById('cart-items');
const cartTotalEl = document.getElementById('cart-total');
const orderResult = document.getElementById('order-result');
let cart = [];
let paypalClientId = null;

function addMsg(text, who) {
  const d = document.createElement('div');
  d.className = 'msg ' + who;
  d.textContent = text;
  chatLog.appendChild(d);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function renderCart() {
  cartItemsEl.innerHTML = cart.length ? '' : '<li class="empty">Cart is empty - ask the assistant.</li>';
  let total = 0;
  for (const it of cart) {
    total += it.lineTotal;
    const li = document.createElement('li');
    li.innerHTML = `<span>${it.qty} x ${it.name}</span><span>$${it.lineTotal.toFixed(2)}</span>`;
    cartItemsEl.appendChild(li);
  }
  cartTotalEl.textContent = cart.length ? `Total: $${total.toFixed(2)} USD` : '';
}

async function init() {
  const cfg = await (await fetch('/api/config')).json();
  paypalClientId = cfg.paypalClientId;
  if (paypalClientId) {
    const s = document.createElement('script');
    s.src = `https://www.paypal.com/sdk/js?client-id=${paypalClientId}&currency=USD&intent=capture`;
    s.onload = renderPaypalButtons;
    document.head.appendChild(s);
  } else {
    document.getElementById('paypal-buttons').textContent = 'PayPal sandbox client ID not configured.';
  }
}

function renderPaypalButtons() {
  paypal.Buttons({
    createOrder: async () => {
      const r = await fetch('/api/paypal/order', { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: cart.map(i => ({ id: i.id, qty: i.qty })) }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'order failed');
      return d.orderID;
    },
    onApprove: async (data) => {
      const r = await fetch(`/api/paypal/order/${data.orderID}/capture`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) { addMsg('Payment failed: ' + (d.error || r.status), 'bot'); return; }
      orderResult.className = 'order-result show';
      orderResult.textContent = `Payment captured (sandbox)\nOrder: ${d.orderID}\nCapture: ${d.captureID}\nAmount: $${d.amount} ${d.currency}\nPayer: ${d.payerEmail}`;
      addMsg(`Order confirmed! ${d.orderID} - $${d.amount} ${d.currency} (sandbox). Choukran!`, 'bot');
    },
    onError: (err) => addMsg('PayPal error: ' + err, 'bot')
  }).render('#paypal-buttons');
}

document.getElementById('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message) return;
  addMsg(message, 'user');
  input.value = '';
  addMsg('...', 'bot');
  try {
    const r = await fetch('/api/assistant', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }) });
    const d = await r.json();
    chatLog.lastChild.remove();
    addMsg(d.reply + (d.ai === 'offline-matcher' ? ' [offline matcher]' : ''), 'bot');
    if (d.items && d.items.length) { cart = d.items; renderCart(); }
  } catch (err) {
    chatLog.lastChild.remove();
    addMsg('Assistant error: ' + err, 'bot');
  }
});

init();
