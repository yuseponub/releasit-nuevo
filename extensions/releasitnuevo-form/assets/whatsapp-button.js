(() => {
  const container = document.getElementById('releasit-wa-btn');
  if (!container) return;

  const phone = container.dataset.phone;
  if (!phone) return;

  const msgProduct = container.dataset.msgProduct || '';
  const msgHome = container.dataset.msgHome || '';
  const msgCollection = container.dataset.msgCollection || '';
  const msgDefault = container.dataset.msgDefault || '';
  const pageType = container.dataset.pageType || '';
  const productName = container.dataset.productName || '';
  const productUrl = container.dataset.productUrl || '';
  const collectionName = container.dataset.collectionName || '';

  function buildMessage() {
    let msg = '';

    switch (pageType) {
      case 'product':
        msg = msgProduct
          .replace(/\[product_name\]/g, productName)
          .replace(/\[product_url\]/g, productUrl);
        break;
      case 'index':
        msg = msgHome;
        break;
      case 'collection':
        msg = msgCollection
          .replace(/\[collection_name\]/g, collectionName);
        break;
      default:
        msg = msgDefault;
        break;
    }

    return msg || msgDefault;
  }

  const btn = container.querySelector('.wa-btn');
  if (!btn) return;

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    const message = encodeURIComponent(buildMessage());
    const url = `https://wa.me/${phone}?text=${message}`;
    window.open(url, '_blank');
  });

  // Show tooltip briefly on load
  const tooltip = container.querySelector('.wa-tooltip');
  if (tooltip && tooltip.textContent.trim()) {
    setTimeout(() => {
      tooltip.classList.add('wa-tooltip-visible');
    }, 1500);
    setTimeout(() => {
      tooltip.classList.remove('wa-tooltip-visible');
    }, 5000);
  }
})();
