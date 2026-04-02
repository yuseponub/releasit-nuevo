/**
 * ReleasitNuevo COD Form
 * Mini-cart + Bundle pricing + COD order form
 * For Somnio Colombia
 */
(function () {
  'use strict';

  const APP_PROXY_BASE = '/apps/releasitnuevo';

  // Bundle pricing table (COP)
  const BUNDLE_PRICING = {
    1: 89900,
    2: 129900,
    3: 169900,
  };

  // Colombian departments
  const DEPARTMENTS = [
    'Amazonas', 'Antioquia', 'Arauca', 'Atlantico', 'Bolivar',
    'Boyaca', 'Caldas', 'Caqueta', 'Casanare', 'Cauca',
    'Cesar', 'Choco', 'Cordoba', 'Cundinamarca', 'Guainia',
    'Guaviare', 'Huila', 'La Guajira', 'Magdalena', 'Meta',
    'Narino', 'Norte de Santander', 'Putumayo', 'Quindio',
    'Risaralda', 'San Andres y Providencia', 'Santander', 'Sucre',
    'Tolima', 'Valle del Cauca', 'Vaupes', 'Vichada', 'Bogota D.C.'
  ];

  // State
  let cart = [];
  let extraProducts = [];
  let allProducts = [];
  let draftSent = false;
  let draftTimeout = null;
  let orderSubmitting = false;

  // ========== TRACKING HELPER ==========

  // Read Facebook cookies for attribution
  function getFbCookies() {
    var cookies = {};
    try {
      var match_fbp = document.cookie.match(/(^| )_fbp=([^;]+)/);
      var match_fbc = document.cookie.match(/(^| )_fbc=([^;]+)/);
      if (match_fbp) cookies.fbp = match_fbp[2];
      if (match_fbc) cookies.fbc = match_fbc[2];
      // If no fbc cookie but fbclid in URL, construct it
      if (!cookies.fbc) {
        var params = new URLSearchParams(window.location.search);
        var fbclid = params.get('fbclid');
        if (fbclid) {
          cookies.fbc = 'fb.1.' + Date.now() + '.' + fbclid;
        }
      }
    } catch(e) {}
    return cookies;
  }

  function trackEvent(eventName, data) {
    var eventId = 'rn_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    var fbCookies = getFbCookies();

    // Facebook Pixel (client-side)
    try {
      if (typeof fbq !== 'undefined') {
        var fbData = { currency: 'COP', content_type: 'product' };
        if (data.value) fbData.value = data.value;
        if (data.contents) fbData.contents = data.contents;
        if (data.content_name) fbData.content_name = data.content_name;
        if (data.content_ids) fbData.content_ids = data.content_ids;
        if (data.num_items) fbData.num_items = data.num_items;
        fbq('track', eventName, fbData, { eventID: eventId });
      }
    } catch(e) {}

    // Backend tracking (Conversions API + monitoring DB)
    try {
      fetch(APP_PROXY_BASE + '/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventName: eventName,
          eventId: eventId,
          data: data,
          userAgent: navigator.userAgent,
          sourceUrl: window.location.href,
          timestamp: Date.now(),
          fbc: fbCookies.fbc || '',
          fbp: fbCookies.fbp || '',
        }),
      }).catch(function(){});
    } catch(e) {}
  }

  // Real Shopify variant IDs mapped from config keys
  const REAL_VARIANT_IDS = {
    'elixir': '47357476634860',
    'ashwagandha': '47357499277548',
    'magnesio': '47357496197356',
    'magnesio-forte': '47357496197356',
    'melatonina-magnesio': '47357476634860',
  };

  // Resolve a real Shopify variant ID
  function resolveVariantId(item) {
    // If it already looks like a numeric Shopify ID, use it
    if (/^\d+$/.test(item.variantId)) return item.variantId;

    // Extract config key from fake variant ID (e.g., "elixir-variant-1" → "elixir")
    const vid = item.variantId || '';
    const configKey = vid.split('-variant-')[0]; // handles "elixir-variant-1"
    if (REAL_VARIANT_IDS[configKey]) return REAL_VARIANT_IDS[configKey];

    // Try full ID (e.g., "ashwagandha-1" → "ashwagandha")
    const baseKey = vid.replace(/-\d+$/, ''); // handles "ashwagandha-1"
    if (REAL_VARIANT_IDS[baseKey]) return REAL_VARIANT_IDS[baseKey];

    // Fallback: search in allProducts
    for (const prod of allProducts) {
      const prodTitle = (prod.title || '').toLowerCase();
      if (prodTitle.includes(configKey) || prodTitle.includes(baseKey)) {
        return prod.variantId;
      }
    }

    return item.variantId;
  }

  // Format COP currency
  function formatCOP(amount) {
    return '$' + amount.toLocaleString('es-CO');
  }

  // Calculate bundle price
  function calcBundlePrice(totalQty) {
    if (totalQty <= 0) return 0;
    if (BUNDLE_PRICING[totalQty]) return BUNDLE_PRICING[totalQty];
    // For quantities > 3, use the best per-unit price
    return totalQty * Math.round(BUNDLE_PRICING[3] / 3);
  }

  // Get total quantity in cart
  function getTotalQty() {
    return cart.reduce((sum, item) => sum + item.quantity, 0);
  }

  // Load products from backend
  async function loadProducts() {
    try {
      const resp = await fetch(APP_PROXY_BASE + '/products');
      const data = await resp.json();
      if (data.products) {
        allProducts = data.products;
      }
    } catch (e) {
      console.error('ReleasitNuevo: Failed to load products', e);
    }
  }

  // Add product to cart
  function addToCart(product) {
    const existing = cart.find(item => item.variantId === product.variantId);
    if (existing) {
      existing.quantity++;
    } else {
      cart.push({
        productId: product.productId,
        variantId: product.variantId,
        title: product.title,
        image: product.image,
        quantity: 1,
      });
    }
    renderCart();
  }

  // Remove product from cart
  function removeFromCart(variantId) {
    cart = cart.filter(item => item.variantId !== variantId);
    renderCart();
  }

  // Update quantity
  function updateQty(variantId, delta) {
    const item = cart.find(i => i.variantId === variantId);
    if (!item) return;
    item.quantity += delta;
    if (item.quantity <= 0) {
      removeFromCart(variantId);
      return;
    }
    renderCart();
  }

  // Product configurations
  const PRODUCT_CONFIGS = {
    elixir: {
      label: 'ELIXIR DEL SUEÑO',
      variants: [
        { key: 1, qty: 1, qtyLabel: 'X1', label: 'ELIXIR DEL SUEÑO', badgeColor: '#0E8C7B', image: 'https://cdn.shopify.com/s/files/1/0688/9606/3724/files/Diseno_sin_titulo_28_200x.jpg?v=1774672087' },
        { key: 2, qty: 2, qtyLabel: 'X2', label: 'ELIXIR DEL SUEÑO', badgeColor: '#2DD264', image: 'https://cdn.shopify.com/s/files/1/0688/9606/3724/files/Diseno_sin_titulo_21_30575912-a33d-49a2-bf0b-30fe508eca1f_200x.jpg?v=1774568076' },
        { key: 3, qty: 3, qtyLabel: 'X3', label: 'ELIXIR DEL SUEÑO', badgeColor: '#E2231A', image: 'https://cdn.shopify.com/s/files/1/0688/9606/3724/files/Diseno_sin_titulo_19_7e31291b-2bb9-431e-81a7-d20b858dac5b_200x.jpg?v=1774568076' },
      ],
      upsells: [
        { id: 'ashwagandha', variantId: 'ashwagandha-1', title: 'KSM-66 ASHWAGANDHA', image: 'https://cdn.shopify.com/s/files/1/0688/9606/3724/files/Diseno_sin_titulo_30.jpg?v=1774718221', price: 49900, comparePrice: 89900, bg: '#FFF1D5', border: '#AE3B04', benefits: '- Estrés<br>+ Calma', titleClass: 'rn-upsell-title-orange', btnClass: 'rn-upsell-btn-orange', cardClass: 'rn-upsell-dark' },
        { id: 'magnesio-forte', variantId: 'magnesio-forte-1', title: 'MAGNESIO FORTE', image: 'https://cdn.shopify.com/s/files/1/0688/9606/3724/files/Diseno_sin_titulo_29.jpg?v=1774718235', price: 49900, comparePrice: 89900, bg: '#FCEAED', border: '#343D5F', benefits: '+ Bisglicinato<br>+ Taurato<br>Relajación total', titleClass: 'rn-upsell-title-blue', btnClass: 'rn-upsell-btn-blue', cardClass: 'rn-upsell-light' },
      ],
    },
    magnesio: {
      label: 'MAGNESIO FORTE',
      variants: [
        { key: 1, qty: 1, qtyLabel: 'X1', label: 'MAGNESIO FORTE', badgeColor: '#0E8C7B', image: 'https://cdn.shopify.com/s/files/1/0688/9606/3724/files/Diseno_sin_titulo_29.jpg?v=1774807113' },
        { key: 2, qty: 2, qtyLabel: 'X2', label: 'MAGNESIO FORTE', badgeColor: '#2DD264', image: 'https://cdn.shopify.com/s/files/1/0688/9606/3724/files/Gemini_Generated_Image_n5f2cvn5f2cvn5f2.png?v=1774807113' },
        { key: 3, qty: 3, qtyLabel: 'X3', label: 'MAGNESIO FORTE', badgeColor: '#E2231A', image: 'https://cdn.shopify.com/s/files/1/0688/9606/3724/files/Gemini_Generated_Image_wn1q6gwn1q6gwn1q_1.png?v=1774807040' },
      ],
      upsells: [
        { id: 'ashwagandha', variantId: 'ashwagandha-1', title: 'KSM-66 ASHWAGANDHA', image: 'https://cdn.shopify.com/s/files/1/0688/9606/3724/files/Diseno_sin_titulo_30.jpg?v=1774718221', price: 49900, comparePrice: 89900, bg: '#FFF1D5', border: '#AE3B04', benefits: '- Estrés<br>+ Calma', titleClass: 'rn-upsell-title-orange', btnClass: 'rn-upsell-btn-orange', cardClass: 'rn-upsell-dark' },
        { id: 'melatonina-magnesio', variantId: 'melatonina-magnesio-1', title: 'MELATONINA+MAGNESIO', image: 'https://cdn.shopify.com/s/files/1/0688/9606/3724/files/Texto_del_parrafo_20.jpg?v=1774808896', price: 49900, comparePrice: 89900, bg: '#E8F5F2', border: '#2D9B83', benefits: 'Regula tu ciclo de sueño<br>Solución natural al insomnio', titleClass: 'rn-upsell-title-green', btnClass: 'rn-upsell-btn-green', cardClass: 'rn-upsell-green', smallTitle: true },
      ],
    },
    ashwagandha: {
      label: 'KSM-66 ASHWAGANDHA',
      variants: [
        { key: 1, qty: 1, qtyLabel: 'X1', label: 'KSM-66 ASHWAGANDHA', badgeColor: '#0E8C7B', image: 'https://cdn.shopify.com/s/files/1/0688/9606/3724/files/Diseno_sin_titulo_30.jpg?v=1774718221' },
        { key: 2, qty: 2, qtyLabel: 'X2', label: 'KSM-66 ASHWAGANDHA', badgeColor: '#2DD264', image: 'https://cdn.shopify.com/s/files/1/0688/9606/3724/files/Diseno_sin_titulo_33.jpg?v=1774816478' },
        { key: 3, qty: 3, qtyLabel: 'X3', label: 'KSM-66 ASHWAGANDHA', badgeColor: '#E2231A', image: 'https://cdn.shopify.com/s/files/1/0688/9606/3724/files/Diseno_sin_titulo_35.jpg?v=1774821848' },
      ],
      upsells: [
        { id: 'melatonina-magnesio', variantId: 'melatonina-magnesio-1', title: 'MELATONINA+MAGNESIO', image: 'https://cdn.shopify.com/s/files/1/0688/9606/3724/files/Texto_del_parrafo_20.jpg?v=1774808896', price: 49900, comparePrice: 89900, bg: '#E8F5F2', border: '#2D9B83', benefits: 'Regula tu ciclo de sueño<br>Solución natural al insomnio', titleClass: 'rn-upsell-title-green', btnClass: 'rn-upsell-btn-green', cardClass: 'rn-upsell-green', smallTitle: true },
        { id: 'magnesio-forte', variantId: 'magnesio-forte-1', title: 'MAGNESIO FORTE', image: 'https://cdn.shopify.com/s/files/1/0688/9606/3724/files/Diseno_sin_titulo_29.jpg?v=1774718235', price: 49900, comparePrice: 89900, bg: '#FCEAED', border: '#343D5F', benefits: '+ Bisglicinato<br>+ Taurato<br>Relajación total', titleClass: 'rn-upsell-title-blue', btnClass: 'rn-upsell-btn-blue', cardClass: 'rn-upsell-light' },
      ],
    },
  };

  // Active product config key
  let activeProduct = 'elixir';

  // Helper to add an upsell product as extra
  function addUpsellExtra(upsellId) {
    if (extraProducts.find(ep => ep.id === upsellId)) return;
    // Search across all product configs for the upsell
    for (const config of Object.values(PRODUCT_CONFIGS)) {
      const u = config.upsells.find(up => up.id === upsellId);
      if (u) {
        extraProducts.push({
          id: u.id, variantId: u.variantId, title: u.title, image: u.image,
          price: u.price, comparePrice: u.comparePrice, bg: u.bg,
          badge: formatCOP(u.comparePrice - u.price) + ' OFF',
        });
        // Track: AddToCart (upsell)
        trackEvent('AddToCart', {
          content_name: u.title + ' (upsell)',
          content_ids: [resolveVariantId(u)],
          value: u.price,
        });
        return;
      }
    }
  }

  // Helper to get current config
  function getConfig() { return PRODUCT_CONFIGS[activeProduct]; }
  function getVariantOptions() { return getConfig().variants; }

  // Detect which product page we're on by scanning for #rn-open-* links
  function detectPageProduct() {
    const openAsh = document.querySelector('a[href*="#rn-open-ash"], button[href*="#rn-open-ash"]');
    if (openAsh) return 'ashwagandha';
    const openMag = document.querySelector('a[href*="#rn-open-mag"], button[href*="#rn-open-mag"]');
    if (openMag) return 'magnesio';
    const openCod = document.querySelector('a[href*="#rn-open-cod"], button[href*="#rn-open-cod"]');
    if (openCod) return 'elixir';
    return activeProduct; // fallback to current
  }

  // Get compare-at prices for savings calculation
  const COMPARE_PRICES = { 1: 120000, 2: 240000, 3: 360000 };

  // Selected variant in modal
  let selectedModalVariant = 1;

  // Build the modal HTML
  function buildModal() {
    const overlay = document.createElement('div');
    overlay.className = 'rn-overlay';
    overlay.id = 'rn-overlay';

    overlay.innerHTML = `
      <div class="rn-modal-wrapper">
        <button class="rn-modal-close" id="rn-close" aria-label="Cerrar">&times;</button>
      <div class="rn-modal" id="rn-modal">
        <div class="rn-modal-content">
        <img class="rn-banner" src="https://cdn.shopify.com/s/files/1/0688/9606/3724/files/ALIADO_1_CONTRA_TU_INSOMNIO.jpg?v=1774669037" alt="Somnio - Aliado #1 contra tu insomnio">
        <div class="rn-header">
          <h2>🎉FELICITACIONES POR APROVECHAR EL DCTO! 🎉</h2>
        </div>

        <!-- Variant Cards with connector line -->
        <div class="rn-connected-section" id="rn-connected-section">
          <div class="rn-connected-content">
            <div class="rn-variants" id="rn-variants"></div>
          </div>
          <div class="rn-connected-line" id="rn-connected-line"></div>
        </div>

        <!-- Pricing -->
        <div class="rn-pricing" id="rn-pricing">
          <div class="rn-pricing-row">
            <span>Subtotal</span>
            <span id="rn-subtotal">$0</span>
          </div>
          <div class="rn-pricing-row rn-discount-row" id="rn-discount-row" style="display:none;">
            <span>Descuentos extra</span>
            <span class="rn-pricing-discount" id="rn-discount">-$0</span>
          </div>
          <div class="rn-pricing-row">
            <span>Envio</span>
            <span class="rn-pricing-free">Gratis</span>
          </div>
          <div class="rn-pricing-row rn-total">
            <span id="rn-total-label">Total</span>
            <span id="rn-total">$0</span>
          </div>
        </div>

        <div class="rn-upsell-header">
          <p class="rn-upsell-header-title">POTENCIA TU DESCANSO</p>
          <p class="rn-upsell-header-sub">$40,000 OFF EN LA COMPRA DE ESTOS PRODUCTOS:</p>
        </div>
        <div class="rn-upsell-row" id="rn-upsell-row"></div>

        <!-- Form -->
        <div class="rn-form" id="rn-form-section">
          <p class="rn-form-title">LLENE LOS SIGUIENTES DATOS PARA ENVIO CONTRAENTREGA:</p>

          <div class="rn-form-group">
            <label class="rn-form-label">Nombre <span class="rn-required">*</span></label>
            <div class="rn-input-wrap"><span class="rn-input-icon">👤</span><input type="text" class="rn-form-input" id="rn-firstName" placeholder="Nombre" required></div>
          </div>

          <div class="rn-form-group">
            <label class="rn-form-label">Apellido <span class="rn-required">*</span></label>
            <div class="rn-input-wrap"><span class="rn-input-icon">👤</span><input type="text" class="rn-form-input" id="rn-lastName" placeholder="Apellido" required></div>
          </div>

          <div class="rn-form-group">
            <label class="rn-form-label">Teléfono <span class="rn-required">*</span></label>
            <div class="rn-input-wrap"><span class="rn-input-icon">📞</span><input type="tel" class="rn-form-input" id="rn-phone" placeholder="Número de teléfono" required></div>
          </div>

          <div class="rn-form-group">
            <label class="rn-form-label">Confirma tu teléfono</label>
            <div class="rn-input-wrap"><span class="rn-input-icon">📞</span><input type="tel" class="rn-form-input" id="rn-phoneConfirm" placeholder="Confirma tu número"></div>
          </div>

          <div class="rn-form-group">
            <label class="rn-form-label">Dirección Completa <span class="rn-required">*</span></label>
            <div class="rn-input-wrap"><span class="rn-input-icon">📍</span><input type="text" class="rn-form-input" id="rn-address" placeholder="Dirección Completa" required></div>
          </div>

          <div class="rn-form-group">
            <label class="rn-form-label">Barrio</label>
            <div class="rn-input-wrap"><span class="rn-input-icon">📍</span><input type="text" class="rn-form-input" id="rn-neighborhood" placeholder="Agrega el nombre de tu barrio"></div>
          </div>

          <div class="rn-form-group">
            <label class="rn-form-label">Departamento <span class="rn-required">*</span></label>
            <select class="rn-form-select" id="rn-department" required>
              <option value="">Elige tu departamento</option>
              ${DEPARTMENTS.map(d => `<option value="${d}">${d}</option>`).join('')}
            </select>
          </div>

          <div class="rn-form-group">
            <label class="rn-form-label">Ciudad <span class="rn-required">*</span></label>
            <div class="rn-input-wrap"><span class="rn-input-icon">📍</span><input type="text" class="rn-form-input" id="rn-city" placeholder="Nombre ciudad/pueblo" required></div>
          </div>

          <div class="rn-form-group">
            <label class="rn-form-label">Correo electrónico</label>
            <div class="rn-input-wrap"><span class="rn-input-icon">✉️</span><input type="email" class="rn-form-input" id="rn-email" placeholder="correo@ejemplo.com"></div>
          </div>
        </div>

        <!-- Action Buttons -->
        <div class="rn-actions" id="rn-actions">
          <button class="rn-btn-primary" id="rn-submit">
            <svg class="rn-btn-icon" viewBox="0 0 24 24" fill="white" width="22" height="22"><path d="M20 8h-3V4H3c-1.1 0-2 .9-2 2v11h2c0 1.66 1.34 3 3 3s3-1.34 3-3h6c0 1.66 1.34 3 3 3s3-1.34 3-3h2v-5l-3-4zM6 18.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm13.5-9l1.96 2.5H17V9.5h2.5zm-1.5 9c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>
            <div class="rn-btn-text">
              <span class="rn-btn-main">CONFIRMA TU PEDIDO</span>
              <span class="rn-btn-sub">Pagaras al recibir</span>
            </div>
          </button>
          <button class="rn-btn-whatsapp" id="rn-whatsapp">
            <svg class="rn-btn-wa-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
            <div class="rn-btn-text">
              <span class="rn-btn-main">Pago Digital por Whatsapp</span>
              <span class="rn-btn-sub">Tarjeta credito/debito, Bancolombia, Nequi o Daviplata</span>
            </div>
          </button>
        </div>
        </div><!-- end rn-modal-content -->

        <!-- Success View -->
        <div class="rn-success-view" id="rn-success" style="display:none;">
          <div class="rn-success-icon">✅</div>
          <h3 class="rn-success-title">Pedido Confirmado!</h3>
          <p class="rn-success-msg">Tu pedido ha sido registrado exitosamente.</p>
          <p class="rn-success-msg">Recibiras una confirmacion por WhatsApp.</p>
          <p class="rn-success-order" id="rn-order-name"></p>
        </div>
      </div>
      </div>
    `;

    document.body.appendChild(overlay);
    bindModalEvents();
  }

  // Render upsell cards based on active product config
  function renderUpsells() {
    const container = document.getElementById('rn-upsell-row');
    if (!container) return;

    const config = getConfig();
    container.innerHTML = config.upsells.map(u => {
      const isAdded = extraProducts.some(ep => ep.id === u.id);
      return `
        <div class="rn-upsell-card ${u.cardClass} ${isAdded ? 'rn-upsell-added' : ''}" data-upsell-id="${u.id}">
          <div class="rn-upsell-added-overlay"><span>✅ Agregado al carrito</span></div>
          <p class="rn-upsell-title ${u.titleClass} ${u.smallTitle ? 'rn-upsell-title-sm' : ''}">${u.title}</p>
          <div class="rn-upsell-body">
            <img class="rn-upsell-img" src="${u.image}" alt="${u.title}">
            <div class="rn-upsell-text">
              <div class="rn-upsell-benefits">${u.benefits}</div>
            </div>
          </div>
          <button class="rn-upsell-btn ${u.btnClass}" data-upsell-add="${u.id}"><span class="rn-upsell-btn-plus">+</span><div class="rn-upsell-btn-left"><span class="rn-upsell-btn-main">AGREGA</span><span class="rn-upsell-btn-sub">SOLO POR</span></div><span class="rn-upsell-btn-price">${formatCOP(u.price)}</span></button>
        </div>
      `;
    }).join('');

    // Bind upsell add buttons
    container.querySelectorAll('[data-upsell-add]').forEach(btn => {
      btn.addEventListener('click', () => {
        const upsellId = btn.dataset.upsellAdd;
        const upsell = config.upsells.find(u => u.id === upsellId);
        if (upsell && !extraProducts.find(ep => ep.id === upsellId)) {
          extraProducts.push({
            id: upsell.id,
            variantId: upsell.variantId,
            title: upsell.title,
            image: upsell.image,
            price: upsell.price,
            comparePrice: upsell.comparePrice,
            bg: upsell.bg,
            badge: formatCOP(upsell.comparePrice - upsell.price) + ' OFF',
          });
          renderVariantCards();
          updatePricing();
          renderUpsells();
        }
      });
    });
  }

  // Render variant cards in modal
  function renderVariantCards() {
    const container = document.getElementById('rn-variants');
    if (!container) return;

    const VARIANT_OPTIONS = getVariantOptions();
    container.innerHTML = VARIANT_OPTIONS.map(v => {
      const isActive = v.qty === selectedModalVariant;
      const price = BUNDLE_PRICING[v.qty] || 0;
      const comparePrice = COMPARE_PRICES[v.qty] || 0;
      const savings = comparePrice > price ? Math.round((1 - price / comparePrice) * 100) : 0;

      // Render extras inside active card
      let extrasHtml = '';
      if (isActive && extraProducts.length > 0) {
        extrasHtml = extraProducts.map(ep => `
          <div class="rn-extra-item" style="background:${ep.bg || 'transparent'};">
            <img class="rn-extra-img" src="${ep.image}" alt="${ep.title}">
            <div class="rn-extra-info">
              <p class="rn-extra-name">+ 1X ${ep.title} ${ep.badge ? `<span class="rn-extra-badge">${ep.badge}</span>` : ''}</p>
            </div>
            <div class="rn-extra-prices">${ep.comparePrice ? `<span class="rn-extra-compare">${formatCOP(ep.comparePrice)}</span>` : ''}<span class="rn-extra-price">${formatCOP(ep.price)}</span></div>
            <button class="rn-extra-remove" data-extra-id="${ep.id}">&times;</button>
          </div>
        `).join('');
      }

      const hasExtras = isActive && extraProducts.length > 0;
      return `
        <div class="rn-variant-card ${isActive ? 'rn-variant-active' : ''}" data-variant-qty="${v.qty}">
          ${isActive ? '<span class="rn-variant-tab">CARRITO</span>' : ''}
          <div class="rn-variant-main ${hasExtras ? 'rn-variant-main-compact' : ''}">
            <img class="rn-variant-img" src="${v.image}" alt="${v.label}">
            <div class="rn-variant-info">
              <p class="rn-variant-name"><span class="rn-variant-qty">${v.qtyLabel}</span> ${v.label}${hasExtras && savings > 0 ? ` <span class="rn-variant-badge rn-variant-badge-inline" style="background:${v.badgeColor}">Ahorra ${savings}%</span>` : ''}</p>
              ${!hasExtras && savings > 0 ? `<span class="rn-variant-badge" style="background:${v.badgeColor}">Ahorra ${savings}%</span>` : ''}
            </div>
            <div class="rn-variant-prices">
              ${comparePrice > price ? `<span class="rn-variant-compare">${formatCOP(comparePrice)}</span>` : ''}
              <span class="rn-variant-price">${formatCOP(price)}</span>
            </div>
          </div>
          ${extrasHtml}
        </div>
      `;
    }).join('');

    // Bind click events on variant cards
    container.querySelectorAll('.rn-variant-card').forEach(card => {
      card.addEventListener('click', () => {
        const qty = parseInt(card.dataset.variantQty);
        selectedModalVariant = qty;
        const vopt = VARIANT_OPTIONS.find(v => v.qty === qty);
        cart = [{
          productId: activeProduct + '-product',
          variantId: activeProduct + '-variant-' + qty,
          title: vopt.qtyLabel + ' ' + vopt.label,
          image: vopt.image,
          quantity: qty,
        }];
        renderVariantCards();
        updatePricing();
      });
    });

    // Bind remove extra buttons
    container.querySelectorAll('.rn-extra-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        extraProducts = extraProducts.filter(ep => ep.id !== btn.dataset.extraId);
        renderVariantCards();
        updatePricing();
        renderUpsells();
      });
    });

    updatePricing();
    renderUpsells();

    // Show connector line from active card to bottom of variants section
    setTimeout(() => {
      const line = document.getElementById('rn-connected-line');
      const activeCard = document.querySelector('.rn-variant-card.rn-variant-active');
      const variants = document.getElementById('rn-variants');
      if (!line || !activeCard || !variants) return;

      // Reset first to get clean measurements
      line.style.marginTop = '0';
      line.style.height = '0';
      line.classList.remove('rn-line-visible');

      const variantsRect = variants.getBoundingClientRect();
      const cardRect = activeCard.getBoundingClientRect();

      const topOffset = cardRect.top + cardRect.height / 2 - variantsRect.top;
      const lineHeight = variantsRect.height - topOffset + 2;

      line.style.marginTop = topOffset + 'px';
      line.style.height = lineHeight + 'px';
      line.classList.add('rn-line-visible');
    }, 20);
  }

  // Update pricing display
  function updatePricing() {
    const basePrice = BUNDLE_PRICING[selectedModalVariant] || 0;
    const baseSubtotal = selectedModalVariant * 89900; // $89,900 per unit
    const baseDiscount = baseSubtotal - basePrice;
    const extrasCompareTotal = extraProducts.reduce((sum, ep) => sum + (ep.comparePrice || ep.price), 0);
    const extrasActualTotal = extraProducts.reduce((sum, ep) => sum + ep.price, 0);
    const extrasDiscount = extrasCompareTotal - extrasActualTotal;
    const totalDiscount = baseDiscount + extrasDiscount;
    const subtotal = baseSubtotal + extrasCompareTotal;
    const total = basePrice + extrasActualTotal;

    const subtotalEl = document.getElementById('rn-subtotal');
    const totalEl = document.getElementById('rn-total');
    const discountRow = document.getElementById('rn-discount-row');
    const discountEl = document.getElementById('rn-discount');

    if (subtotalEl) subtotalEl.textContent = formatCOP(subtotal);
    if (totalEl) totalEl.textContent = formatCOP(total);

    const totalLabel = document.getElementById('rn-total-label');
    if (totalLabel) {
      const totalProducts = selectedModalVariant + extraProducts.length;
      totalLabel.textContent = `TOTAL (${totalProducts} Producto${totalProducts > 1 ? 's' : ''})`;
    }

    if (discountRow && discountEl) {
      if (totalDiscount > 0) {
        discountRow.style.display = 'flex';
        discountEl.textContent = '-' + formatCOP(totalDiscount);
      } else {
        discountRow.style.display = 'none';
      }
    }

    const pricing = document.getElementById('rn-pricing');
    if (pricing) {
      if (totalDiscount > 0) {
        pricing.classList.add('rn-pricing-compact');
      } else {
        pricing.classList.remove('rn-pricing-compact');
      }
    }
  }

  // Update upsell cards state is now handled by renderUpsells()

  // Render cart items
  function renderCart() {
    const container = document.getElementById('rn-cart-items');
    if (!container) return;

    const totalQty = getTotalQty();
    const bundlePrice = calcBundlePrice(totalQty);
    const fullPrice = totalQty * BUNDLE_PRICING[1]; // full price at 1-unit rate

    // Render items
    container.innerHTML = cart.map(item => `
      <div class="rn-cart-item" data-variant="${item.variantId}">
        <img class="rn-cart-item-img" src="${item.image || ''}" alt="${item.title}">
        <div class="rn-cart-item-info">
          <p class="rn-cart-item-name">${item.title}</p>
          <p class="rn-cart-item-price">${formatCOP(Math.round(bundlePrice / totalQty))}/u</p>
        </div>
        <div class="rn-cart-item-controls">
          <button class="rn-qty-btn rn-qty-minus" data-variant="${item.variantId}">−</button>
          <span class="rn-qty-value">${item.quantity}</span>
          <button class="rn-qty-btn rn-qty-plus" data-variant="${item.variantId}">+</button>
          <button class="rn-cart-item-remove" data-variant="${item.variantId}">&times;</button>
        </div>
      </div>
    `).join('');

    // Bind qty buttons
    container.querySelectorAll('.rn-qty-minus').forEach(btn => {
      btn.addEventListener('click', () => updateQty(btn.dataset.variant, -1));
    });
    container.querySelectorAll('.rn-qty-plus').forEach(btn => {
      btn.addEventListener('click', () => updateQty(btn.dataset.variant, 1));
    });
    container.querySelectorAll('.rn-cart-item-remove').forEach(btn => {
      btn.addEventListener('click', () => removeFromCart(btn.dataset.variant));
    });

    // Update pricing
    document.getElementById('rn-subtotal').textContent = formatCOP(bundlePrice);
    document.getElementById('rn-total').textContent = formatCOP(bundlePrice);

    // Update savings banner
    const savingsEl = document.getElementById('rn-savings');
    const savingsText = document.getElementById('rn-savings-text');
    if (totalQty > 1 && fullPrice > bundlePrice) {
      const savings = fullPrice - bundlePrice;
      savingsEl.style.display = 'flex';
      savingsText.textContent = `¡Ahorras ${formatCOP(savings)} con tu bundle de ${totalQty} productos!`;
    } else {
      savingsEl.style.display = 'none';
    }

    // Update cross-sell
    renderCrossSell();
  }

  // Render cross-sell items (products not in cart)
  function renderCrossSell() {
    const container = document.getElementById('rn-crosssell-items');
    const section = document.getElementById('rn-crosssell');
    if (!container || !section) return;

    const cartVariantIds = cart.map(i => i.variantId);
    const available = allProducts.filter(p => !cartVariantIds.includes(p.variantId));

    if (available.length === 0) {
      section.style.display = 'none';
      return;
    }

    section.style.display = 'block';
    container.innerHTML = available.map(p => `
      <div class="rn-crosssell-item">
        <img class="rn-crosssell-item-img" src="${p.image || ''}" alt="${p.title}">
        <div class="rn-crosssell-item-info">
          <p class="rn-crosssell-item-name">${p.title}</p>
        </div>
        <button class="rn-crosssell-add" data-product='${JSON.stringify(p).replace(/'/g, "&#39;")}'>Agregar +</button>
      </div>
    `).join('');

    container.querySelectorAll('.rn-crosssell-add').forEach(btn => {
      btn.addEventListener('click', () => {
        const product = JSON.parse(btn.dataset.product);
        addToCart(product);
      });
    });
  }

  // Detect selected variant from Instant.so variant picker
  function getInstantVariant() {
    const active = document.querySelector('.instant-custom-variant-picker[data-instant-state="active"]');
    if (!active) return null;

    const optionValue = active.getAttribute('data-instant-option-value') || '';
    const titleEl = active.querySelector('[data-instant-dynamic-content-source="TITLE"]');
    const variantTitleEl = active.querySelector('[data-instant-dynamic-content-source="VARIANT_TITLE"]');
    const priceEl = active.querySelector('[data-instant-dynamic-content-source="PRICE"]');
    const imgEl = active.querySelector('img');

    // Parse quantity from option value (1, x2, x3)
    let qty = 1;
    const match = optionValue.match(/(\d+)/);
    if (match) qty = parseInt(match[1]);

    // Parse price
    let price = 0;
    if (priceEl) {
      const priceText = priceEl.textContent.replace(/[^0-9]/g, '');
      price = parseInt(priceText) || 0;
      // Shopify formats with cents (89900.00 -> 8990000), normalize to COP
      if (price > 1000000) price = Math.round(price / 100);
    }

    const title = (titleEl ? titleEl.textContent.trim() : 'Producto');
    const variantTitle = variantTitleEl ? variantTitleEl.textContent.trim() : '';
    const image = imgEl ? imgEl.src : '';

    return { qty, price, title, variantTitle, image };
  }

  // Open modal
  function openModal(productKeyOrData) {
    // Set active product if a key was passed
    if (typeof productKeyOrData === 'string' && PRODUCT_CONFIGS[productKeyOrData]) {
      activeProduct = productKeyOrData;
    }

    // Detect Instant.so variant to set initial selection
    const instantVariant = getInstantVariant();
    if (instantVariant) {
      selectedModalVariant = instantVariant.qty;
      if (instantVariant.price > 0) {
        BUNDLE_PRICING[instantVariant.qty] = instantVariant.price;
      }
    }

    const VARIANT_OPTIONS = getVariantOptions();

    // Update cart based on selected variant
    cart = [{
      productId: activeProduct + '-product',
      variantId: activeProduct + '-variant-' + selectedModalVariant,
      title: ((VARIANT_OPTIONS.find(v => v.qty === selectedModalVariant) || {}).qtyLabel || '') + ' ' + ((VARIANT_OPTIONS.find(v => v.qty === selectedModalVariant) || {}).label || 'Producto'),
      image: '',
      quantity: selectedModalVariant,
    }];

    const overlay = document.getElementById('rn-overlay');
    if (overlay) {
      overlay.classList.add('rn-active');
      overlay.setAttribute('data-product', activeProduct);
      document.body.style.overflow = 'hidden';
      renderUpsells();
      renderVariantCards();
    }

    // Track: ViewContent + AddToCart (once per modal open)
    trackEvent('ViewContent', {
      content_name: activeProduct,
      value: calcBundlePrice(selectedModalVariant),
    });
    trackEvent('AddToCart', {
      content_name: activeProduct,
      content_ids: [resolveVariantId(cart[0])],
      value: calcBundlePrice(selectedModalVariant),
    });
  }

  // Close modal
  function closeModal() {
    const overlay = document.getElementById('rn-overlay');
    if (overlay) {
      overlay.classList.remove('rn-active');
      document.body.style.overflow = '';
      // Reset cart and extras so next open starts fresh
      cart = [];
      extraProducts = [];
    }
  }

  // Bind modal events
  function bindModalEvents() {
    document.getElementById('rn-close').addEventListener('click', closeModal);
    document.getElementById('rn-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'rn-overlay') closeModal();
    });

    // Draft order on partial fill (name + phone)
    const firstNameEl = document.getElementById('rn-firstName');
    const phoneEl = document.getElementById('rn-phone');

    function checkDraftTrigger() {
      const firstName = firstNameEl.value.trim();
      const phone = phoneEl.value.trim();
      if (firstName && phone && phone.length >= 7 && !draftSent) {
        clearTimeout(draftTimeout);
        draftTimeout = setTimeout(() => createDraft(), 3000);
      }
    }

    // Track: InitiateCheckout on first form interaction (any field)
    var checkoutTracked = false;
    function trackInitiateCheckout() {
      if (checkoutTracked) return;
      checkoutTracked = true;
      var totalQty = getTotalQty();
      trackEvent('InitiateCheckout', {
        value: calcBundlePrice(totalQty),
        contents: cart.map(function(i) { return { id: resolveVariantId(i), quantity: i.quantity }; }),
      });
    }
    document.querySelectorAll('#rn-firstName, #rn-lastName, #rn-phone, #rn-phoneConfirm, #rn-email, #rn-address, #rn-neighborhood, #rn-city').forEach(function(el) {
      if (el) el.addEventListener('focus', trackInitiateCheckout);
    });

    firstNameEl.addEventListener('input', checkDraftTrigger);
    phoneEl.addEventListener('input', checkDraftTrigger);

    // Upsell buttons are now handled dynamically in renderUpsells()

    // Submit order
    document.getElementById('rn-submit').addEventListener('click', submitOrder);

    // WhatsApp button
    document.getElementById('rn-whatsapp').addEventListener('click', handleWhatsApp);
  }

  // Create draft order (abandonment tracking)
  async function createDraft() {
    if (draftSent) return;
    draftSent = true;

    const firstName = document.getElementById('rn-firstName').value.trim();
    const lastName = document.getElementById('rn-lastName').value.trim();
    const phone = document.getElementById('rn-phone').value.trim();

    try {
      await fetch(APP_PROXY_BASE + '/create-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName,
          lastName,
          phone,
          items: cart.map(i => ({
            variantId: resolveVariantId(i),
            title: i.title,
            quantity: i.quantity,
          })),
        }),
      });
    } catch (e) {
      console.error('ReleasitNuevo: Draft creation failed', e);
      draftSent = false;
    }
  }

  // Validate form
  function validateForm() {
    let valid = true;

    // Clear previous errors
    document.querySelectorAll('.rn-form-error').forEach(el => el.remove());
    document.querySelectorAll('.rn-error').forEach(el => el.classList.remove('rn-error'));

    function showError(id, msg) {
      const el = document.getElementById(id);
      el.classList.add('rn-error');
      const errDiv = document.createElement('div');
      errDiv.className = 'rn-form-error';
      errDiv.textContent = msg;
      el.parentNode.appendChild(errDiv);
      valid = false;
    }

    if (!document.getElementById('rn-firstName').value.trim()) showError('rn-firstName', 'Requerido');
    if (!document.getElementById('rn-lastName').value.trim()) showError('rn-lastName', 'Requerido');

    const phone = document.getElementById('rn-phone').value.trim();
    if (!phone) {
      showError('rn-phone', 'Requerido');
    } else if (phone.length < 7) {
      showError('rn-phone', 'Telefono invalido');
    }

    // Phone confirm is optional - no validation needed

    if (!document.getElementById('rn-address').value.trim()) showError('rn-address', 'Requerido');
    if (!document.getElementById('rn-department').value) showError('rn-department', 'Requerido');
    if (!document.getElementById('rn-city').value.trim()) showError('rn-city', 'Requerido');

    if (cart.length === 0) {
      valid = false;
      alert('Agrega al menos un producto a tu carrito');
    }

    return valid;
  }

  // Submit order
  async function submitOrder() {
    if (orderSubmitting) return;
    if (!validateForm()) return;

    orderSubmitting = true;
    const btn = document.getElementById('rn-submit');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="rn-spinner"></span> Procesando...';

    const totalQty = getTotalQty();
    const bundlePrice = calcBundlePrice(totalQty);

    // Build items: main cart + upsell extras
    var allItems = cart.map(i => ({
      variantId: resolveVariantId(i),
      title: i.title,
      quantity: i.quantity,
      isUpsell: false,
    }));

    // Add upsell extras with their discounted price
    extraProducts.forEach(function(ep) {
      allItems.push({
        variantId: resolveVariantId(ep),
        title: ep.title,
        quantity: 1,
        isUpsell: true,
        upsellPrice: ep.price,
        upsellComparePrice: ep.comparePrice || ep.price,
      });
    });

    const extrasTotal = extraProducts.reduce(function(sum, ep) { return sum + ep.price; }, 0);

    const data = {
      firstName: document.getElementById('rn-firstName').value.trim(),
      lastName: document.getElementById('rn-lastName').value.trim(),
      phone: document.getElementById('rn-phone').value.trim(),
      phoneConfirm: document.getElementById('rn-phoneConfirm').value.trim(),
      email: document.getElementById('rn-email').value.trim(),
      address: document.getElementById('rn-address').value.trim(),
      neighborhood: document.getElementById('rn-neighborhood').value.trim(),
      department: document.getElementById('rn-department').value,
      city: document.getElementById('rn-city').value.trim(),
      items: allItems,
      bundleSize: totalQty,
      total: bundlePrice + extrasTotal,
    };

    try {
      console.log('[RN] Submitting order to:', APP_PROXY_BASE + '/create-order');
      console.log('[RN] Data:', JSON.stringify(data));

      const resp = await fetch(APP_PROXY_BASE + '/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      console.log('[RN] Response status:', resp.status);

      // Check if response is JSON
      const contentType = resp.headers.get('content-type') || '';
      let result;
      if (contentType.includes('application/json')) {
        result = await resp.json();
      } else {
        // Shopify might return HTML error page
        const text = await resp.text();
        console.error('[RN] Non-JSON response:', text.substring(0, 500));
        throw new Error('El servidor no respondio correctamente (status: ' + resp.status + ')');
      }

      console.log('[RN] Result:', JSON.stringify(result));

      if (result.success) {
        // Track: Purchase
        trackEvent('Purchase', {
          value: data.total,
          contents: data.items.map(function(i) { return { id: i.variantId, quantity: i.quantity }; }),
          num_items: data.items.reduce(function(s,i){ return s + i.quantity; }, 0),
          order_id: result.orderName || result.orderId,
          external_id: result.orderId,
          email: data.email,
          phone: data.phone,
          firstName: data.firstName,
          lastName: data.lastName,
          city: data.city,
          department: data.department,
        });

        // TODO: Re-enable redirect after testing
        // if (result.statusPageUrl) {
        //   window.location.href = result.statusPageUrl;
        //   return;
        // }

        // Fallback: show success screen
        ['rn-cart-section', 'rn-crosssell', 'rn-savings', 'rn-pricing', 'rn-form-section', 'rn-actions'].forEach(function(id) {
          var el = document.getElementById(id);
          if (el) el.style.display = 'none';
        });

        var orderNameEl = document.getElementById('rn-order-name');
        if (orderNameEl) orderNameEl.textContent = 'Orden: ' + (result.orderName || result.orderId);
        var successEl = document.getElementById('rn-success');
        if (successEl) successEl.style.display = 'block';

        // Reset state
        cart = [];
        draftSent = false;
      } else {
        alert('Error al crear el pedido: ' + (result.error || 'Intenta de nuevo'));
        orderSubmitting = false;
        btn.disabled = false;
        btn.innerHTML = originalText;
      }
    } catch (e) {
      console.error('[RN] Order submission failed:', e);
      alert('Error: ' + (e.message || 'Error de conexion. Intenta de nuevo.'));
      orderSubmitting = false;
      btn.disabled = false;
      btn.innerHTML = originalText;
    }
  }

  // Handle WhatsApp button
  function handleWhatsApp() {
    const totalQty = getTotalQty();
    const bundlePrice = calcBundlePrice(totalQty);
    const extrasTotal = extraProducts.reduce(function(s, ep) { return s + ep.price; }, 0);
    const grandTotal = bundlePrice + extrasTotal;
    const itemsList = cart.map(i => `${i.title} x${i.quantity}`).join(', ');
    const extrasList = extraProducts.map(ep => `${ep.title} x1 (${formatCOP(ep.price)})`).join(', ');

    const firstName = document.getElementById('rn-firstName').value.trim();
    const lastName = document.getElementById('rn-lastName').value.trim();
    const phone = document.getElementById('rn-phone').value.trim();
    const address = document.getElementById('rn-address').value.trim();
    const city = document.getElementById('rn-city').value.trim();

    const message = encodeURIComponent(
      `Hola! Quiero hacer un pedido con pago digital:\n\n` +
      `Productos: ${itemsList}\n` +
      (extrasList ? `Extras: ${extrasList}\n` : '') +
      `Total: ${formatCOP(grandTotal)}\n\n` +
      `Nombre: ${firstName} ${lastName}\n` +
      `Telefono: ${phone}\n` +
      (address ? `Direccion: ${address}, ${city}\n` : '')
    );

    // Track: Purchase event for WhatsApp orders too
    trackEvent('Purchase', {
      value: grandTotal,
      contents: cart.map(function(i) { return { id: resolveVariantId(i), quantity: i.quantity }; }),
      num_items: totalQty + extraProducts.length,
      order_id: 'WA-' + Date.now(),
      email: document.getElementById('rn-email').value.trim(),
      phone: phone,
      firstName: firstName,
      lastName: lastName,
      city: city,
      department: document.getElementById('rn-department').value,
    });

    const whatsappNumber = '573105879824';
    window.open(`https://wa.me/${whatsappNumber}?text=${message}`, '_blank');
  }

  // Inject COD button on product page
  function injectCODButton() {
    // Try to find the add-to-cart form
    const productForm = document.querySelector('form[action*="/cart/add"]');
    if (!productForm) return;

    // Get current product info from the page
    const productData = getProductFromPage();
    if (!productData) return;

    // Check if button already exists
    if (document.getElementById('rn-cod-trigger')) return;

    const codBtn = document.createElement('button');
    codBtn.type = 'button';
    codBtn.id = 'rn-cod-trigger';
    codBtn.className = 'rn-cod-button';
    codBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
      </svg>
      PAGAR AL RECIBIR
    `;

    codBtn.addEventListener('click', (e) => {
      e.preventDefault();
      openModal(productData);
    });

    // Insert after the add-to-cart button or the form
    const addToCartBtn = productForm.querySelector('[type="submit"], button[name="add"]');
    if (addToCartBtn) {
      addToCartBtn.parentNode.insertBefore(codBtn, addToCartBtn.nextSibling);
    } else {
      productForm.appendChild(codBtn);
    }
  }

  // Extract product data from the current page
  function getProductFromPage() {
    // Try to get product data from Shopify's global object
    if (typeof meta !== 'undefined' && meta.product) {
      const p = meta.product;
      const variant = p.variants ? p.variants[0] : null;
      return {
        productId: String(p.id),
        variantId: String(variant ? variant.id : p.id),
        title: p.title || document.title,
        image: p.featured_image || '',
      };
    }

    // Fallback: try to parse from product JSON in the page
    const productJsonEl = document.querySelector('[data-product-json], script[type="application/json"][data-product]');
    if (productJsonEl) {
      try {
        const data = JSON.parse(productJsonEl.textContent);
        return {
          productId: String(data.id),
          variantId: String(data.variants[0].id),
          title: data.title,
          image: data.featured_image || (data.images && data.images[0]) || '',
        };
      } catch (e) { /* continue */ }
    }

    // Another fallback: get from ShopifyAnalytics
    if (typeof ShopifyAnalytics !== 'undefined' && ShopifyAnalytics.meta && ShopifyAnalytics.meta.product) {
      const p = ShopifyAnalytics.meta.product;
      return {
        productId: String(p.id),
        variantId: String(p.variants ? p.variants[0].id : p.id),
        title: p.title || document.querySelector('h1')?.textContent || document.title,
        image: '',
      };
    }

    return null;
  }

  // ========================================
  // Inline Product Slider (Product Page)
  // ========================================

  const SLIDER_PRODUCTS = [
    {
      id: 'ashwagandha',
      variantId: 'ashwagandha-1',
      title: 'KSM-66 ASHWAGANDHA',
      subtitle: '90 comprimidos',
      image: 'https://cdn.shopify.com/s/files/1/0688/9606/3724/files/Diseno_sin_titulo_30.jpg?v=1774718221',
      price: 49900,
      comparePrice: 89900,
      benefits: ['- Estrés', '+ Calma', '+ Enfoque'],
      accentColor: '#AE3B04',
      bgColor: '#FFF1D5',
    },
    {
      id: 'magnesio-forte',
      variantId: 'magnesio-forte-1',
      title: 'MAGNESIO FORTE',
      subtitle: '90 comprimidos',
      image: 'https://cdn.shopify.com/s/files/1/0688/9606/3724/files/Diseno_sin_titulo_29.jpg?v=1774718235',
      price: 49900,
      comparePrice: 89900,
      benefits: ['+ Bisglicinato', '+ Taurato', 'Relajación total'],
      accentColor: '#343D5F',
      bgColor: '#FCEAED',
    },
  ];

  let sliderCurrentIndex = 0;
  let touchStartX = 0;
  let touchEndX = 0;

  function buildVariantPicker() {
    const container = document.getElementById('rn-variant-picker');
    if (!container) return;
    renderSlider(container);
  }

  function renderSlider(container) {
    const product = SLIDER_PRODUCTS[sliderCurrentIndex];
    const savings = product.comparePrice > product.price
      ? Math.round((1 - product.price / product.comparePrice) * 100)
      : 0;
    const discount = product.comparePrice - product.price;

    const dots = SLIDER_PRODUCTS.map((_, i) =>
      `<span class="rn-slider-dot ${i === sliderCurrentIndex ? 'rn-slider-dot-active' : ''}" data-slide="${i}"></span>`
    ).join('');

    const tabs = SLIDER_PRODUCTS.map((p, i) =>
      `<button class="rn-slider-tab ${i === sliderCurrentIndex ? 'rn-slider-tab-active' : ''}" data-slide="${i}" style="${i === sliderCurrentIndex ? 'border-color:' + p.accentColor + '; color:' + p.accentColor : ''}">${p.title}</button>`
    ).join('');

    container.innerHTML = `
      <div class="rn-slider">
        <div class="rn-slider-tabs">${tabs}</div>
        <div class="rn-slider-card" id="rn-slider-card" style="border-color: ${product.accentColor}; background: ${product.bgColor}">
          <div class="rn-slider-badge" style="background: ${product.accentColor}">-${savings}% DCTO</div>
          <div class="rn-slider-content">
            <img class="rn-slider-img" src="${product.image}" alt="${product.title}">
            <div class="rn-slider-info">
              <p class="rn-slider-title" style="color: ${product.accentColor}">${product.title}</p>
              <p class="rn-slider-subtitle">${product.subtitle}</p>
              <div class="rn-slider-benefits">
                ${product.benefits.map(b => `<span class="rn-slider-benefit">${b}</span>`).join('')}
              </div>
            </div>
          </div>
          <div class="rn-slider-pricing">
            <div class="rn-slider-price-row">
              <span class="rn-slider-compare">${formatCOP(product.comparePrice)}</span>
              <span class="rn-slider-price">${formatCOP(product.price)}</span>
            </div>
            <span class="rn-slider-save" style="background: ${product.accentColor}">Ahorras ${formatCOP(discount)}</span>
          </div>
          <button class="rn-slider-cta" style="background: ${product.accentColor}" data-product-id="${product.id}">
            <svg viewBox="0 0 24 24" fill="white" width="18" height="18"><path d="M20 8h-3V4H3c-1.1 0-2 .9-2 2v11h2c0 1.66 1.34 3 3 3s3-1.34 3-3h6c0 1.66 1.34 3 3 3s3-1.34 3-3h2v-5l-3-4zM6 18.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm13.5-9l1.96 2.5H17V9.5h2.5zm-1.5 9c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>
            PEDIR AHORA - PAGO CONTRAENTREGA
          </button>
        </div>
        <div class="rn-slider-dots">${dots}</div>
        <div class="rn-slider-nav">
          <button class="rn-slider-arrow rn-slider-prev" ${sliderCurrentIndex === 0 ? 'disabled' : ''}>&lsaquo;</button>
          <span class="rn-slider-counter">${sliderCurrentIndex + 1} / ${SLIDER_PRODUCTS.length}</span>
          <button class="rn-slider-arrow rn-slider-next" ${sliderCurrentIndex === SLIDER_PRODUCTS.length - 1 ? 'disabled' : ''}>&rsaquo;</button>
        </div>
        <div class="rn-pick-badges">
          <span>🚚 Envío gratis</span>
          <span>💵 Pagas al recibir</span>
          <span>✅ Garantía 30 días</span>
        </div>
      </div>
    `;

    // Bind events
    bindSliderEvents(container);
  }

  function bindSliderEvents(container) {
    // Tab clicks
    container.querySelectorAll('.rn-slider-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        sliderCurrentIndex = parseInt(tab.dataset.slide);
        renderSlider(container);
      });
    });

    // Dot clicks
    container.querySelectorAll('.rn-slider-dot').forEach(dot => {
      dot.addEventListener('click', () => {
        sliderCurrentIndex = parseInt(dot.dataset.slide);
        renderSlider(container);
      });
    });

    // Arrow clicks
    const prev = container.querySelector('.rn-slider-prev');
    const next = container.querySelector('.rn-slider-next');
    if (prev) prev.addEventListener('click', () => {
      if (sliderCurrentIndex > 0) { sliderCurrentIndex--; renderSlider(container); }
    });
    if (next) next.addEventListener('click', () => {
      if (sliderCurrentIndex < SLIDER_PRODUCTS.length - 1) { sliderCurrentIndex++; renderSlider(container); }
    });

    // Swipe support
    const card = container.querySelector('#rn-slider-card');
    if (card) {
      card.addEventListener('touchstart', (e) => { touchStartX = e.changedTouches[0].screenX; }, { passive: true });
      card.addEventListener('touchend', (e) => {
        touchEndX = e.changedTouches[0].screenX;
        const diff = touchStartX - touchEndX;
        if (Math.abs(diff) > 50) {
          if (diff > 0 && sliderCurrentIndex < SLIDER_PRODUCTS.length - 1) {
            sliderCurrentIndex++;
            renderSlider(container);
          } else if (diff < 0 && sliderCurrentIndex > 0) {
            sliderCurrentIndex--;
            renderSlider(container);
          }
        }
      }, { passive: true });
    }

    // CTA button - opens modal and adds product as extra
    const cta = container.querySelector('.rn-slider-cta');
    if (cta) {
      cta.addEventListener('click', () => {
        const prod = SLIDER_PRODUCTS[sliderCurrentIndex];
        // Add this product as an extra in the modal
        if (!extraProducts.find(ep => ep.id === prod.id)) {
          extraProducts.push({
            id: prod.id,
            variantId: prod.variantId,
            title: prod.title,
            image: prod.image,
            price: prod.price,
            comparePrice: prod.comparePrice,
            bg: prod.bgColor,
            badge: formatCOP(prod.comparePrice - prod.price) + ' OFF',
          });
        }
        openModal();
      });
    }
  }

  // Initialize
  async function init() {
    // Load products for cross-sell
    await loadProducts();

    // Build modal
    buildModal();

    // Inject COD button on product pages
    if (window.location.pathname.includes('/products/')) {
      injectCODButton();
    }

    // Build inline variant picker on product pages
    buildVariantPicker();

    // Listen for custom events (from complementa-carrito block)
    document.addEventListener('rn:add-to-cart', (e) => {
      if (e.detail && e.detail.product) {
        addToCart(e.detail.product);
        openModal();
      }
    });

    document.addEventListener('rn:open-modal', () => {
      openModal();
    });

    // Intercept cart icon clicks in the header → open COD form instead
    document.addEventListener('click', (e) => {
      const cartLink = e.target.closest('a[href="/cart"], a[href*="/cart"], .cart-icon-bubble, .header__icon--cart, [data-cart-trigger], .cart-count-bubble, .icon-cart, details-modal cart-drawer');
      if (cartLink) {
        e.preventDefault();
        e.stopPropagation();
        openModal();
      }
    }, true);

    // Listen for anchor clicks (for Instant.so / custom buttons)
    document.addEventListener('click', (e) => {
      const link = e.target.closest('a[href*="#rn-open-cod"], a[href*="#rn-open-mag"], a[href*="#rn-open-ash"], a[href*="#rn-add-ash"], a[href*="#rn-add-mag"], a[href*="#rn-add-mel"], button[href*="#rn-open-cod"], button[href*="#rn-open-mag"], button[href*="#rn-open-ash"], button[href*="#rn-add-ash"], button[href*="#rn-add-mag"], button[href*="#rn-add-mel"]');
      if (!link) return;
      e.preventDefault();
      const href = link.getAttribute('href') || '';

      if (href.includes('#rn-open-ash')) {
        extraProducts = [];
        openModal('ashwagandha');
      } else if (href.includes('#rn-open-mag')) {
        extraProducts = [];
        openModal('magnesio');
      } else if (href.includes('#rn-add-ash')) {
        extraProducts = [];
        addUpsellExtra('ashwagandha');
        openModal(detectPageProduct());
      } else if (href.includes('#rn-add-mag')) {
        extraProducts = [];
        addUpsellExtra('magnesio-forte');
        openModal(detectPageProduct());
      } else if (href.includes('#rn-add-mel')) {
        extraProducts = [];
        addUpsellExtra('melatonina-magnesio');
        openModal(detectPageProduct());
      } else {
        // #rn-open-cod → Elixir del Sueño
        extraProducts = [];
        openModal('elixir');
      }
    });

    // Also check if page loaded with hash
    function handleHash() {
      const hash = window.location.hash;
      if (hash === '#rn-open-cod') { extraProducts = []; openModal('elixir'); }
      else if (hash === '#rn-open-mag') { extraProducts = []; openModal('magnesio'); }
      else if (hash === '#rn-open-ash') { extraProducts = []; openModal('ashwagandha'); }
      else if (hash === '#rn-add-ash') { extraProducts = []; addUpsellExtra('ashwagandha'); openModal(detectPageProduct()); }
      else if (hash === '#rn-add-mag') { extraProducts = []; addUpsellExtra('magnesio-forte'); openModal(detectPageProduct()); }
      else if (hash === '#rn-add-mel') { extraProducts = []; addUpsellExtra('melatonina-magnesio'); openModal(detectPageProduct()); }
    }

    handleHash();
    window.addEventListener('hashchange', handleHash);
  }

  // Wait for DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose for external use
  window.ReleasitNuevo = {
    openModal,
    addToCart,
    getCart: () => [...cart],
    buildVariantPicker,
  };
})();
