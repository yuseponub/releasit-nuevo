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
    3: 159900,
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

  // Variant options for the modal
  const VARIANT_OPTIONS = [
    { key: 1, label: 'X1 ELIXIR DEL SUEÑO', qty: 1, image: 'https://cdn.shopify.com/s/files/1/0688/9606/3724/files/Diseno_sin_titulo_28_200x.jpg?v=1774672087' },
    { key: 2, label: 'X2 ELIXIR DEL SUEÑO', qty: 2, image: 'https://cdn.shopify.com/s/files/1/0688/9606/3724/files/Diseno_sin_titulo_21_30575912-a33d-49a2-bf0b-30fe508eca1f_200x.jpg?v=1774568076' },
    { key: 3, label: 'X3 ELIXIR DEL SUEÑO', qty: 3, image: 'https://cdn.shopify.com/s/files/1/0688/9606/3724/files/Diseno_sin_titulo_19_7e31291b-2bb9-431e-81a7-d20b858dac5b_200x.jpg?v=1774568076' },
  ];

  // Get compare-at prices for savings calculation
  const COMPARE_PRICES = { 1: 110000, 2: 220000, 3: 330000 };

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
          <div class="rn-pricing-row">
            <span>Envio</span>
            <span class="rn-pricing-free">Gratis</span>
          </div>
          <div class="rn-pricing-row rn-total">
            <span>Total</span>
            <span id="rn-total">$0</span>
          </div>
        </div>

        <div class="rn-upsell-row">
          <div class="rn-upsell-card rn-upsell-dark">
            <p class="rn-upsell-title rn-upsell-title-orange">KSM -66 ASHWAGANDHA</p>
            <div class="rn-upsell-body">
              <img class="rn-upsell-img" src="https://cdn.shopify.com/s/files/1/0688/9606/3724/files/Diseno_sin_titulo_30.jpg?v=1774718221" alt="Ashwagandha">
              <div class="rn-upsell-text">
                <div class="rn-upsell-benefits">- Estrés<br>+ Calma</div>
              </div>
            </div>
            <button class="rn-upsell-btn rn-upsell-btn-orange" id="rn-add-ashwagandha"><span class="rn-upsell-btn-plus">+</span><div class="rn-upsell-btn-left"><span class="rn-upsell-btn-main">AGREGA</span><span class="rn-upsell-btn-sub">SOLO POR</span></div><span class="rn-upsell-btn-price">$49,900</span></button>
          </div>
          <div class="rn-upsell-card rn-upsell-light">
            <p class="rn-upsell-title rn-upsell-title-blue">MAGNESIO FORTE</p>
            <div class="rn-upsell-body">
              <img class="rn-upsell-img" src="https://cdn.shopify.com/s/files/1/0688/9606/3724/files/Diseno_sin_titulo_29.jpg?v=1774718235" alt="Magnesio Forte">
              <div class="rn-upsell-text">
                <div class="rn-upsell-benefits">+ Bisglicinato<br>+ Taurato<br>Relajación total</div>
              </div>
            </div>
            <button class="rn-upsell-btn rn-upsell-btn-blue" id="rn-add-magnesio"><span class="rn-upsell-btn-plus">+</span><div class="rn-upsell-btn-left"><span class="rn-upsell-btn-main">AGREGA</span><span class="rn-upsell-btn-sub">SOLO POR</span></div><span class="rn-upsell-btn-price">$49,900</span></button>
          </div>
        </div>

        <!-- Form -->
        <div class="rn-form" id="rn-form-section">
          <p class="rn-form-title">Llene los siguientes datos para envio contraentrega:</p>

          <div class="rn-form-group">
            <label class="rn-form-label">Nombre <span class="rn-required">*</span></label>
            <input type="text" class="rn-form-input" id="rn-firstName" placeholder="Nombre" required>
          </div>

          <div class="rn-form-group">
            <label class="rn-form-label">Apellido <span class="rn-required">*</span></label>
            <input type="text" class="rn-form-input" id="rn-lastName" placeholder="Apellido" required>
          </div>

          <div class="rn-form-group">
            <label class="rn-form-label">Telefono <span class="rn-required">*</span></label>
            <input type="tel" class="rn-form-input" id="rn-phone" placeholder="300 123 4567" required>
          </div>

          <div class="rn-form-group">
            <label class="rn-form-label">Confirmar telefono</label>
            <input type="tel" class="rn-form-input" id="rn-phoneConfirm" placeholder="300 123 4567">
          </div>

          <div class="rn-form-group">
            <label class="rn-form-label">Direccion completa <span class="rn-required">*</span></label>
            <input type="text" class="rn-form-input" id="rn-address" placeholder="Calle, carrera, numero, apto/casa" required>
          </div>

          <div class="rn-form-group">
            <label class="rn-form-label">Barrio</label>
            <input type="text" class="rn-form-input" id="rn-neighborhood" placeholder="Nombre del barrio">
          </div>

          <div class="rn-form-group">
            <label class="rn-form-label">Departamento <span class="rn-required">*</span></label>
            <select class="rn-form-select" id="rn-department" required>
              <option value="">Seleccionar...</option>
              ${DEPARTMENTS.map(d => `<option value="${d}">${d}</option>`).join('')}
            </select>
          </div>

          <div class="rn-form-group">
            <label class="rn-form-label">Ciudad <span class="rn-required">*</span></label>
            <input type="text" class="rn-form-input" id="rn-city" placeholder="Ciudad" required>
          </div>

          <div class="rn-form-group">
            <label class="rn-form-label">Correo electronico</label>
            <input type="email" class="rn-form-input" id="rn-email" placeholder="correo@ejemplo.com">
          </div>
        </div>

        <!-- Action Buttons -->
        <div class="rn-actions" id="rn-actions">
          <button class="rn-btn-primary" id="rn-submit">
            CONFIRMA TU PEDIDO - Pagaras al recibir
          </button>
          <button class="rn-btn-whatsapp" id="rn-whatsapp">
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
            Pago Digital por Whatsapp
          </button>
        </div>

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

  // Render variant cards in modal
  function renderVariantCards() {
    const container = document.getElementById('rn-variants');
    if (!container) return;

    // Get product image from Instant.so
    const activeInstant = document.querySelector('.instant-custom-variant-picker[data-instant-state="active"]');
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
              <p class="rn-extra-name">+ ${ep.title}</p>
            </div>
            <div class="rn-extra-price">${formatCOP(ep.price)}</div>
            <button class="rn-extra-remove" data-extra-id="${ep.id}">&times;</button>
          </div>
        `).join('');
      }

      const hasExtras = isActive && extraProducts.length > 0;
      return `
        <div class="rn-variant-card ${isActive ? 'rn-variant-active' : ''}" data-variant-qty="${v.qty}">
          <div class="rn-variant-main ${hasExtras ? 'rn-variant-main-compact' : ''}">
            <img class="rn-variant-img" src="${v.image}" alt="${v.label}">
            <div class="rn-variant-info">
              <p class="rn-variant-name">${v.label}${hasExtras && savings > 0 ? ` <span class="rn-variant-badge rn-variant-badge-inline">Ahorra ${savings}%</span>` : ''}</p>
              ${!hasExtras && savings > 0 ? `<span class="rn-variant-badge">Ahorra ${savings}%</span>` : ''}
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
        cart = [{
          productId: 'instant-product',
          variantId: 'instant-variant-' + qty,
          title: VARIANT_OPTIONS.find(v => v.qty === qty).label,
          image: VARIANT_OPTIONS.find(v => v.qty === qty).image,
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
      });
    });

    updatePricing();

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
    const extrasTotal = extraProducts.reduce((sum, ep) => sum + ep.price, 0);
    const total = basePrice + extrasTotal;
    const subtotalEl = document.getElementById('rn-subtotal');
    const totalEl = document.getElementById('rn-total');
    if (subtotalEl) subtotalEl.textContent = formatCOP(total);
    if (totalEl) totalEl.textContent = formatCOP(total);
  }

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
  function openModal(product) {
    // Detect Instant.so variant to set initial selection
    const instantVariant = getInstantVariant();
    if (instantVariant) {
      selectedModalVariant = instantVariant.qty;
      if (instantVariant.price > 0) {
        BUNDLE_PRICING[instantVariant.qty] = instantVariant.price;
      }
    }

    // Update cart based on selected variant
    cart = [{
      productId: 'instant-product',
      variantId: 'instant-variant-' + selectedModalVariant,
      title: (VARIANT_OPTIONS.find(v => v.qty === selectedModalVariant) || {}).label || 'Producto',
      image: '',
      quantity: selectedModalVariant,
    }];

    const overlay = document.getElementById('rn-overlay');
    if (overlay) {
      overlay.classList.add('rn-active');
      document.body.style.overflow = 'hidden';
      renderVariantCards();
    }
  }

  // Close modal
  function closeModal() {
    const overlay = document.getElementById('rn-overlay');
    if (overlay) {
      overlay.classList.remove('rn-active');
      document.body.style.overflow = '';
      // Reset cart so next open picks up current Instant.so variant
      cart = [];
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

    firstNameEl.addEventListener('input', checkDraftTrigger);
    phoneEl.addEventListener('input', checkDraftTrigger);

    // Cross-sell add buttons
    document.getElementById('rn-add-ashwagandha').addEventListener('click', () => {
      if (!extraProducts.find(ep => ep.id === 'ashwagandha')) {
        extraProducts.push({
          id: 'ashwagandha',
          variantId: 'ashwagandha-1',
          title: 'KSM-66 Ashwagandha',
          image: 'https://cdn.shopify.com/s/files/1/0688/9606/3724/files/Diseno_sin_titulo_30.jpg?v=1774718221',
          price: 49900,
          bg: '#FFF1D5',
        });
        renderVariantCards();
        updatePricing();
      }
    });

    document.getElementById('rn-add-magnesio').addEventListener('click', () => {
      if (!extraProducts.find(ep => ep.id === 'magnesio-forte')) {
        extraProducts.push({
          id: 'magnesio-forte',
          variantId: 'magnesio-forte-1',
          title: 'Magnesio Forte',
          image: 'https://cdn.shopify.com/s/files/1/0688/9606/3724/files/Diseno_sin_titulo_29.jpg?v=1774718235',
          price: 49900,
          bg: '#FCEAED',
        });
        renderVariantCards();
        updatePricing();
      }
    });

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
            variantId: i.variantId,
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

    const phoneConfirm = document.getElementById('rn-phoneConfirm').value.trim();
    if (phoneConfirm && phoneConfirm !== phone) {
      showError('rn-phoneConfirm', 'Los telefonos no coinciden');
    }

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
    if (!validateForm()) return;

    const btn = document.getElementById('rn-submit');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="rn-spinner"></span> Procesando...';

    const totalQty = getTotalQty();
    const bundlePrice = calcBundlePrice(totalQty);

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
      items: cart.map(i => ({
        variantId: i.variantId,
        title: i.title,
        quantity: i.quantity,
      })),
      bundleSize: totalQty,
      total: bundlePrice,
    };

    try {
      const resp = await fetch(APP_PROXY_BASE + '/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      const result = await resp.json();

      if (result.success) {
        // Show success
        document.getElementById('rn-cart-section').style.display = 'none';
        document.getElementById('rn-crosssell').style.display = 'none';
        document.getElementById('rn-savings').style.display = 'none';
        document.getElementById('rn-pricing').style.display = 'none';
        document.getElementById('rn-form-section').style.display = 'none';
        document.getElementById('rn-actions').style.display = 'none';

        document.getElementById('rn-order-name').textContent =
          'Orden: ' + (result.orderName || result.orderId);
        document.getElementById('rn-success').style.display = 'block';

        // Reset state
        cart = [];
        draftSent = false;
      } else {
        alert('Error al crear el pedido: ' + (result.error || 'Intenta de nuevo'));
        btn.disabled = false;
        btn.innerHTML = originalText;
      }
    } catch (e) {
      console.error('ReleasitNuevo: Order submission failed', e);
      alert('Error de conexion. Por favor intenta de nuevo.');
      btn.disabled = false;
      btn.innerHTML = originalText;
    }
  }

  // Handle WhatsApp button
  function handleWhatsApp() {
    const totalQty = getTotalQty();
    const bundlePrice = calcBundlePrice(totalQty);
    const itemsList = cart.map(i => `${i.title} x${i.quantity}`).join(', ');

    const message = encodeURIComponent(
      `Hola! Quiero hacer un pedido con pago digital:\n\n` +
      `Productos: ${itemsList}\n` +
      `Total: ${formatCOP(bundlePrice)}\n\n` +
      `Nombre: ${document.getElementById('rn-firstName').value.trim()} ${document.getElementById('rn-lastName').value.trim()}\n` +
      `Telefono: ${document.getElementById('rn-phone').value.trim()}`
    );

    // Replace with actual WhatsApp number
    const whatsappNumber = '573000000000';
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

    // Listen for #rn-open-cod anchor clicks (for Instant.so / custom buttons)
    document.addEventListener('click', (e) => {
      const link = e.target.closest('a[href*="#rn-open-cod"], button[href*="#rn-open-cod"]');
      if (link) {
        e.preventDefault();
        const productData = getProductFromPage();
        openModal(productData);
      }
    });

    // Also check if page loaded with #rn-open-cod hash
    if (window.location.hash === '#rn-open-cod') {
      const productData = getProductFromPage();
      openModal(productData);
    }
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
  };
})();
