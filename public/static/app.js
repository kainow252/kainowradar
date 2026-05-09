/* ============================================================
   ShoppingCompare — app.js
   Frontend JavaScript: busca, sugestões, cliques, UI
   ============================================================ */

// ── Estado global ─────────────────────────────────────────
const State = {
  searchTimer: null,
  currentQuery: '',
  isSearching: false,
}

// ── Utilitários ───────────────────────────────────────────
const formatBRL = (v) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v)

const el = (id) => document.getElementById(id)

function showToast(msg, duration = 3000) {
  let toast = el('toast')
  if (!toast) {
    toast = document.createElement('div')
    toast.id = 'toast'
    document.body.appendChild(toast)
  }
  toast.textContent = msg
  toast.classList.add('show')
  clearTimeout(toast._timer)
  toast._timer = setTimeout(() => toast.classList.remove('show'), duration)
}

// ── Busca principal ───────────────────────────────────────
async function searchProducts(query) {
  const input = el('search-input')
  const q = query || (input ? input.value.trim() : '')
  if (!q) return

  State.currentQuery = q
  State.isSearching = true

  // Atualiza ambos os inputs
  if (input) input.value = q
  const heroInput = el('hero-search')
  if (heroInput) heroInput.value = q

  // Fecha sugestões
  closeSuggestions()

  // Mostra seção de resultados
  const section = el('search-results-section')
  const title = el('search-results-title')
  const grid = el('search-results-grid')
  const loading = el('search-loading')
  const empty = el('search-empty')

  if (!section) return

  section.classList.remove('hidden')
  grid.innerHTML = ''
  loading.classList.remove('hidden')
  empty.classList.add('hidden')
  title.textContent = `Buscando "${q}"...`

  // Scroll suave até os resultados
  section.scrollIntoView({ behavior: 'smooth', block: 'start' })

  try {
    const res = await fetch(`/api/products?q=${encodeURIComponent(q)}&per_page=24`)
    const data = await res.json()

    loading.classList.add('hidden')

    if (!data.products || data.products.length === 0) {
      title.textContent = `Nenhum resultado para "${q}"`
      empty.classList.remove('hidden')
      return
    }

    title.textContent = `${data.total} resultado${data.total !== 1 ? 's' : ''} para "${q}"`
    grid.innerHTML = data.products.map(renderProductCard).join('')
    grid.querySelectorAll('.product-card').forEach((card, i) => {
      card.style.animationDelay = `${i * 40}ms`
      card.classList.add('fade-in-up')
    })
  } catch (err) {
    loading.classList.add('hidden')
    title.textContent = 'Erro ao buscar produtos'
    grid.innerHTML = '<p class="text-red-500 col-span-full text-center py-8">Erro ao conectar. Tente novamente.</p>'
    console.error('Search error:', err)
  } finally {
    State.isSearching = false
  }
}

function closeSearch() {
  const section = el('search-results-section')
  if (section) section.classList.add('hidden')
  State.currentQuery = ''
  const input = el('search-input')
  if (input) input.value = ''
}

function quickSearch(term) {
  const input = el('search-input')
  if (input) input.value = term
  searchProducts(term)
}

// ── Renderiza card de produto (JS version) ─────────────────
function renderProductCard(p) {
  const price = p.best_price ? formatBRL(p.best_price) : 'Ver preço'
  const storeName = p.best_store_name || ''
  const offerBadge = p.offer_count > 1
    ? `<span class="offer-badge">${p.offer_count} lojas</span>` : ''
  const brandHTML = p.brand
    ? `<span style="font-size:0.75rem;color:#2563eb;font-weight:600;text-transform:uppercase;letter-spacing:.05em">${p.brand}</span>` : ''

  return `
    <a href="/produto/${p.slug}" class="product-card group fade-in-up">
      <div class="product-card-img">
        <img src="${p.image_url || 'https://via.placeholder.com/300x300?text=Produto'}"
             alt="${p.name}" loading="lazy"
             style="width:100%;height:100%;object-fit:contain;transition:transform .3s"
             onerror="this.src='https://via.placeholder.com/300x300?text=Sem+Imagem'">
        ${offerBadge}
      </div>
      <div class="product-card-body">
        ${brandHTML}
        <h3 class="product-card-title">${p.name}</h3>
        <div style="margin-top:auto;padding-top:0.75rem">
          <div style="font-size:0.75rem;color:#94a3b8;margin-bottom:0.25rem">${storeName ? `em ${storeName}` : ''}</div>
          <div style="font-size:1.25rem;font-weight:800;color:#0f172a">${price}</div>
          <div class="btn-compare" style="margin-top:0.5rem">Comparar preços →</div>
        </div>
      </div>
    </a>
  `
}

// ── Sugestões de busca ────────────────────────────────────
async function fetchSuggestions(q) {
  if (q.length < 2) { closeSuggestions(); return }

  try {
    const res = await fetch(`/api/search/suggestions?q=${encodeURIComponent(q)}`)
    const items = await res.json()
    renderSuggestions(items, q)
  } catch (e) {
    closeSuggestions()
  }
}

function renderSuggestions(items, q) {
  const box = el('suggestions')
  if (!box) return

  if (!items || items.length === 0) { closeSuggestions(); return }

  box.innerHTML = items.map(item => `
    <a href="/produto/${item.slug}" class="suggestion-item">
      <img src="${item.image_url || 'https://via.placeholder.com/40?text=P'}"
           alt="${item.name}"
           onerror="this.style.display='none'">
      <div style="flex:1;min-width:0">
        <div style="font-size:0.875rem;font-weight:500;color:#1e293b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${highlightQuery(item.name, q)}</div>
        <div style="font-size:0.75rem;color:#64748b">${item.best_price ? formatBRL(item.best_price) : ''} ${item.brand ? '· ' + item.brand : ''}</div>
      </div>
    </a>
  `).join('')

  box.classList.remove('hidden')
}

function highlightQuery(text, query) {
  if (!query) return text
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
  return text.replace(regex, '<strong>$1</strong>')
}

function closeSuggestions() {
  const box = el('suggestions')
  if (box) box.classList.add('hidden')
}

function debounceSearch(value) {
  clearTimeout(State.searchTimer)
  if (!value || value.length < 2) { closeSuggestions(); return }
  State.searchTimer = setTimeout(() => fetchSuggestions(value), 280)
}

// ── Rastreamento de clique em oferta ──────────────────────
async function trackClick(offerId, productId, storeId) {
  try {
    await fetch('/api/click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offer_id: offerId, product_id: productId, store_id: storeId }),
    })
  } catch (e) {
    // Silencioso — não bloqueia o clique do usuário
  }
}

// ── Copiar link de compartilhamento ──────────────────────
function shareProduct() {
  const url = window.location.href
  if (navigator.share) {
    navigator.share({ title: document.title, url })
  } else {
    navigator.clipboard.writeText(url).then(() => showToast('✓ Link copiado!'))
  }
}

// ── Scroll to top ─────────────────────────────────────────
function initScrollTop() {
  const btn = document.createElement('button')
  btn.id = 'scroll-top'
  btn.innerHTML = '↑'
  btn.title = 'Voltar ao topo'
  btn.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' })
  document.body.appendChild(btn)

  window.addEventListener('scroll', () => {
    btn.classList.toggle('show', window.scrollY > 400)
  }, { passive: true })
}

// ── Fecha sugestões ao clicar fora ───────────────────────
document.addEventListener('click', (e) => {
  const input = el('search-input')
  const suggestions = el('suggestions')
  if (suggestions && input && !input.contains(e.target) && !suggestions.contains(e.target)) {
    closeSuggestions()
  }
})

// ── ESC fecha resultados e sugestões ─────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeSuggestions()
  }
})

// ── Lazy load images com IntersectionObserver ─────────────
function initLazyImages() {
  if (!('IntersectionObserver' in window)) return
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target
        if (img.dataset.src) {
          img.src = img.dataset.src
          observer.unobserve(img)
        }
      }
    })
  }, { rootMargin: '100px' })

  document.querySelectorAll('img[data-src]').forEach(img => observer.observe(img))
}

// ── Adiciona header shadow no scroll ─────────────────────
function initHeaderScroll() {
  const header = document.querySelector('header')
  if (!header) return
  window.addEventListener('scroll', () => {
    header.style.boxShadow = window.scrollY > 10
      ? '0 2px 20px rgba(0,0,0,0.1)' : ''
  }, { passive: true })
}

// ── Price chart (se tiver canvas na página) ───────────────
function initPriceChart() {
  const canvas = el('price-chart')
  if (!canvas || typeof Chart === 'undefined') return

  // Pega preços dos data attributes
  const labels = JSON.parse(canvas.dataset.labels || '[]')
  const prices = JSON.parse(canvas.dataset.prices || '[]')
  const colors = prices.map((_, i) => i === 0 ? '#16a34a' : '#3b82f6')

  new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Preço (R$)',
        data: prices,
        backgroundColor: colors,
        borderRadius: 8,
        borderSkipped: false,
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          beginAtZero: false,
          ticks: {
            callback: (v) => formatBRL(v)
          }
        }
      }
    }
  })
}

// ── Init ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initScrollTop()
  initLazyImages()
  initHeaderScroll()
  initPriceChart()

  // Auto-foco no campo de busca na home
  const heroInput = el('hero-search')
  if (heroInput && window.location.pathname === '/') {
    setTimeout(() => heroInput.focus(), 300)
  }
})
