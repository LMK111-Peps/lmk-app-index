/*
 * LMK Square connector (browser side). No credentials live here.
 *
 * Attaches to the EXISTING Laboratori Massa Kritikal markup with data attributes, so the
 * black-and-gold design, product images, strength selectors, quantity inputs and cart stay yours.
 *
 * Product card:
 *   <article data-lmk-product="Square item name or item ID">
 *     <select data-lmk-strength></select>        <!-- options are filled from Square variations -->
 *     <span data-lmk-price></span>               <!-- price of the selected strength -->
 *     <span data-lmk-stock></span>               <!-- "In stock", "3 left", "Sold out" -->
 *     <input data-lmk-qty type="number" min="1" value="1">
 *     <button data-lmk-add>Add to cart</button>
 *   </article>
 *
 * Cart (anywhere on the page):
 *   <span data-lmk-cart-count></span>
 *   <div data-lmk-cart-lines></div>            <!-- rendered with your classes, see renderLine -->
 *   <span data-lmk-cart-subtotal></span>
 *   <span data-lmk-cart-tax></span>
 *   <span data-lmk-cart-total></span>
 *   <p data-lmk-cart-message></p>
 *   <button data-lmk-checkout>Checkout</button>
 *
 * Include:  <script src="/lmk-square.js" data-api="https://lmk-square.<you>.workers.dev" defer></script>
 */
(function () {
  'use strict';
  var script = document.currentScript;
  var API = ((script && script.getAttribute('data-api')) || '').replace(/\/$/, '');
  var CART_KEY = 'lmk-cart-v1';
  var catalog = null;
  var byVariation = {};
  var quoteTimer = null;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function money(m) {
    if (!m) return '';
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: m.currency }).format(Number(m.amount) / 100); }
    catch (e) { return (Number(m.amount) / 100).toFixed(2); }
  }
  function text(el, value) { if (el) el.textContent = value; }

  // Cart holds only variation IDs and quantities. Prices always come from the server.
  function readCart() { try { var c = JSON.parse(localStorage.getItem(CART_KEY) || '[]'); return Array.isArray(c) ? c : []; } catch (e) { return []; } }
  function writeCart(lines) { localStorage.setItem(CART_KEY, JSON.stringify(lines)); renderCart(); scheduleQuote(); }

  function findProduct(key) {
    if (!catalog) return null;
    var k = String(key).trim().toLowerCase();
    for (var i = 0; i < catalog.products.length; i++) {
      var p = catalog.products[i];
      if (p.id === key || p.name.trim().toLowerCase() === k) return p;
    }
    return null;
  }

  function stockLabel(v) {
    if (!v.price) return 'Unavailable';
    if (!v.available) return 'Sold out';
    if (v.stock === null) return 'In stock';
    return v.stock <= 5 ? v.stock + ' left' : 'In stock';
  }

  function bindCard(card) {
    var p = findProduct(card.getAttribute('data-lmk-product'));
    var select = $('[data-lmk-strength]', card);
    var add = $('[data-lmk-add]', card);
    var qty = $('[data-lmk-qty]', card);
    if (!p) { card.setAttribute('data-lmk-state', 'unmatched'); if (add) add.disabled = true; return; }
    card.setAttribute('data-lmk-state', 'ready');
    if (select) {
      var previous = select.value;
      select.innerHTML = '';
      p.variations.forEach(function (v) {
        var o = document.createElement('option');
        o.value = v.id;
        o.textContent = v.name + (v.available ? '' : ' (sold out)');
        o.disabled = !v.available;
        select.appendChild(o);
      });
      var keep = p.variations.filter(function (v) { return v.id === previous && v.available; })[0]
        || p.variations.filter(function (v) { return v.available; })[0] || p.variations[0];
      select.value = keep.id;
      select.onchange = function () { update(); };
    }
    function current() {
      var id = select ? select.value : p.variations[0].id;
      return p.variations.filter(function (v) { return v.id === id; })[0];
    }
    function update() {
      var v = current();
      text($('[data-lmk-price]', card), money(v.price));
      text($('[data-lmk-stock]', card), stockLabel(v));
      if (qty && v.stock !== null) qty.max = String(Math.min(99, v.stock));
      if (add) add.disabled = !v.available;
    }
    update();
    if (add) add.onclick = function (e) {
      e.preventDefault();
      var v = current();
      var n = Math.max(1, Math.min(99, parseInt(qty ? qty.value : '1', 10) || 1));
      var lines = readCart();
      var line = lines.filter(function (l) { return l.variationId === v.id; })[0];
      if (line) line.quantity = Math.min(99, line.quantity + n); else lines.push({ variationId: v.id, quantity: n });
      writeCart(lines);
      document.dispatchEvent(new CustomEvent('lmk:added', { detail: { product: p.name, strength: v.name, quantity: n } }));
    };
  }

  function renderLine(line) {
    var hit = byVariation[line.variationId];
    var row = document.createElement('div');
    row.className = 'lmk-cart-line';
    var img = hit && hit.product.images[0];
    row.innerHTML =
      (img ? '<img class="lmk-cart-img" alt="">' : '') +
      '<div class="lmk-cart-info"><span class="lmk-cart-name"></span><span class="lmk-cart-strength"></span></div>' +
      '<input class="lmk-cart-qty" type="number" min="1" max="99" aria-label="Quantity">' +
      '<span class="lmk-cart-price"></span>' +
      '<button class="lmk-cart-remove" type="button" aria-label="Remove">×</button>';
    if (img) row.querySelector('img').src = img;
    text(row.querySelector('.lmk-cart-name'), hit ? hit.product.name : 'Unavailable item');
    text(row.querySelector('.lmk-cart-strength'), hit ? hit.variation.name : '');
    text(row.querySelector('.lmk-cart-price'), hit && hit.variation.price ? money({ amount: Number(hit.variation.price.amount) * line.quantity, currency: hit.variation.price.currency }) : '');
    var q = row.querySelector('.lmk-cart-qty');
    q.value = String(line.quantity);
    q.onchange = function () {
      var n = Math.max(0, Math.min(99, parseInt(q.value, 10) || 0));
      writeCart(readCart().map(function (l) { return l.variationId === line.variationId ? { variationId: l.variationId, quantity: n } : l; }).filter(function (l) { return l.quantity > 0; }));
    };
    row.querySelector('.lmk-cart-remove').onclick = function () {
      writeCart(readCart().filter(function (l) { return l.variationId !== line.variationId; }));
    };
    return row;
  }

  function renderCart() {
    var lines = readCart();
    var count = lines.reduce(function (n, l) { return n + l.quantity; }, 0);
    $$('[data-lmk-cart-count]').forEach(function (el) { text(el, String(count)); });
    $$('[data-lmk-cart-lines]').forEach(function (box) {
      box.innerHTML = '';
      if (!lines.length) { var e = document.createElement('p'); e.className = 'lmk-cart-empty'; e.textContent = 'Your cart is empty.'; box.appendChild(e); return; }
      lines.forEach(function (l) { box.appendChild(renderLine(l)); });
    });
    if (!lines.length) {
      $$('[data-lmk-cart-subtotal],[data-lmk-cart-tax],[data-lmk-cart-total]').forEach(function (el) { text(el, ''); });
    }
    updateCheckoutButton();
  }

  function message(msg) { $$('[data-lmk-cart-message]').forEach(function (el) { text(el, msg || ''); }); }

  function updateCheckoutButton(quoteOk) {
    var enabled = !!(catalog && catalog.checkout && catalog.checkout.enabled);
    $$('[data-lmk-checkout]').forEach(function (b) {
      b.disabled = !enabled || !readCart().length || quoteOk === false;
      b.setAttribute('data-lmk-state', enabled ? 'enabled' : 'disabled');
    });
    if (catalog && !enabled && readCart().length) message('Online checkout is coming soon.');
  }

  function scheduleQuote() { clearTimeout(quoteTimer); quoteTimer = setTimeout(quote, 250); }

  function quote() {
    var lines = readCart();
    if (!lines.length) { message(''); return; }
    fetch(API + '/api/cart/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: lines }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) { message(res.j.message || 'Some items need attention.'); updateCheckoutButton(false); return; }
        var sub = res.j.lines.reduce(function (n, l) { return n + Number(l.unitPrice.amount) * l.quantity; }, 0);
        var cur = res.j.total.currency;
        $$('[data-lmk-cart-subtotal]').forEach(function (el) { text(el, money({ amount: sub, currency: cur })); });
        $$('[data-lmk-cart-tax]').forEach(function (el) { text(el, money(res.j.tax)); });
        $$('[data-lmk-cart-total]').forEach(function (el) { text(el, money(res.j.total)); });
        if (res.j.checkout.enabled) message('');
        updateCheckoutButton(true);
      })
      .catch(function () { message('Couldn’t update totals. Check your connection.'); });
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    var a = new Uint8Array(16); crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function checkout(btn) {
    var lines = readCart();
    if (!lines.length) return;
    btn.disabled = true;
    // One key per checkout attempt, so a double-click never creates two orders.
    var key = sessionStorage.getItem('lmk-checkout-key') || uuid();
    sessionStorage.setItem('lmk-checkout-key', key);
    fetch(API + '/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ lines: lines }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) { message(res.j.message || 'Checkout isn’t available right now.'); btn.disabled = false; sessionStorage.removeItem('lmk-checkout-key'); return; }
        sessionStorage.removeItem('lmk-checkout-key');
        localStorage.setItem('lmk-last-order', res.j.orderRef);
        window.location.href = res.j.checkoutUrl;
      })
      .catch(function () { message('Checkout couldn’t start. Please try again.'); btn.disabled = false; });
  }

  function load() {
    fetch(API + '/api/catalog')
      .then(function (r) { if (!r.ok) throw new Error('catalog ' + r.status); return r.json(); })
      .then(function (data) {
        catalog = data;
        byVariation = {};
        data.products.forEach(function (p) { p.variations.forEach(function (v) { byVariation[v.id] = { product: p, variation: v }; }); });
        // Drop cart lines whose product no longer exists in Square.
        var kept = readCart().filter(function (l) { return byVariation[l.variationId]; });
        localStorage.setItem(CART_KEY, JSON.stringify(kept));
        $$('[data-lmk-product]').forEach(bindCard);
        document.documentElement.setAttribute('data-lmk-env', data.environment);
        renderCart();
        scheduleQuote();
        document.dispatchEvent(new CustomEvent('lmk:ready', { detail: data }));
      })
      .catch(function () {
        document.documentElement.setAttribute('data-lmk-env', 'offline');
        $$('[data-lmk-add]').forEach(function (b) { b.disabled = true; });
        message('Products are temporarily unavailable.');
      });
  }

  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest && e.target.closest('[data-lmk-checkout]');
    if (b) { e.preventDefault(); checkout(b); }
  });

  // Public hook for sites that render product cards after load.
  window.LMKSquare = { refresh: load, bind: function (root) { $$('[data-lmk-product]', root).forEach(bindCard); } };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load); else load();
})();
