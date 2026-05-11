/* ============================================================
   ShoppingCompare — app.js
   Frontend: busca, sugestões, Google OAuth, badges de conta,
   sistema de alertas de preço, menu usuário
   ============================================================ */

// ══════════════════════════════════════════════════════════════
// MENU HAMBÚRGUER MOBILE
// ══════════════════════════════════════════════════════════════

let _hamStartX = 0
let _hamCurrentX = 0
let _hamIsDragging = false

function openHamburger() {
  const drawer  = el('mob-drawer')
  const overlay = el('mob-overlay')
  const btn     = el('hamburger-btn')
  if (!drawer) return

  drawer.classList.remove('mob-drawer-closed')
  drawer.classList.add('mob-drawer-open')
  overlay.classList.remove('hidden')
  btn?.classList.add('is-open')
  document.body.classList.add('mob-menu-open')

  // Foca no campo de busca do drawer
  setTimeout(() => el('mob-search-input')?.focus(), 350)

  // Suporte a fechar com swipe ← no drawer
  drawer.addEventListener('touchstart', _hamTouchStart, { passive: true })
  drawer.addEventListener('touchmove',  _hamTouchMove,  { passive: false })
  drawer.addEventListener('touchend',   _hamTouchEnd,   { passive: true })
}

function closeHamburger() {
  const drawer  = el('mob-drawer')
  const overlay = el('mob-overlay')
  const btn     = el('hamburger-btn')
  if (!drawer) return

  drawer.classList.remove('mob-drawer-open')
  drawer.classList.add('mob-drawer-closed')
  overlay.classList.add('hidden')
  btn?.classList.remove('is-open')
  document.body.classList.remove('mob-menu-open')
  drawer.style.transform = '' // reseta transform manual do swipe

  drawer.removeEventListener('touchstart', _hamTouchStart)
  drawer.removeEventListener('touchmove',  _hamTouchMove)
  drawer.removeEventListener('touchend',   _hamTouchEnd)
}

function _hamTouchStart(e) {
  _hamStartX   = e.touches[0].clientX
  _hamCurrentX = _hamStartX
  _hamIsDragging = true
}

function _hamTouchMove(e) {
  if (!_hamIsDragging) return
  _hamCurrentX = e.touches[0].clientX
  const delta  = _hamCurrentX - _hamStartX
  if (delta < 0) {
    // só arrastar para esquerda (fechar)
    const drawer = el('mob-drawer')
    if (drawer) drawer.style.transform = `translateX(${delta}px)`
    e.preventDefault()
  }
}

function _hamTouchEnd() {
  if (!_hamIsDragging) return
  _hamIsDragging = false
  const delta = _hamCurrentX - _hamStartX
  if (delta < -80) {
    closeHamburger()
  } else {
    const drawer = el('mob-drawer')
    if (drawer) drawer.style.transform = ''
  }
}

// Fecha com tecla Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const drawer = el('mob-drawer')
    if (drawer && drawer.classList.contains('mob-drawer-open')) {
      closeHamburger()
    }
  }
})

// Toggle colapsável do grid de categorias no drawer
function toggleMobCats() {
  const grid    = el('mob-cats-grid')
  const chevron = el('mob-cats-chevron')
  if (!grid) return
  const isOpen = grid.style.display !== 'none'
  grid.style.display    = isOpen ? 'none' : ''
  if (chevron) chevron.style.transform = isOpen ? 'rotate(-90deg)' : 'rotate(0deg)'
  grid.style.transition = 'all 0.2s ease'
}

// Sincroniza estado do usuário no drawer (após loadUser)
function syncMobUserArea() {
  const u = State.user
  const areaLogin  = el('mob-user-area')
  const areaLogged = el('mob-user-logged')
  if (!areaLogin || !areaLogged) return

  if (u) {
    areaLogin.classList.add('hidden')
    areaLogged.classList.remove('hidden')
    const mobAvatar = el('mob-avatar')
    const mobName   = el('mob-user-name')
    if (mobAvatar) mobAvatar.src = u.avatar_url || ''
    if (mobName)   mobName.textContent = u.full_name?.split(' ')[0] || u.email
  } else {
    areaLogin.classList.remove('hidden')
    areaLogged.classList.add('hidden')
  }
}

// ── Estado global ─────────────────────────────────────────
const State = {
  searchTimer: null,
  currentQuery: '',
  isSearching: false,
  user: null,              // usuário logado (dados do /auth/me)
  storePrefs: [],          // [{store_id, has_account}]
  alerts: [],              // alertas ativos do usuário
  alertProductId: null,    // produto atual no modal de alerta
  alertCurrentPrice: null,
}

// ── Utilitários ───────────────────────────────────────────
const formatBRL = (v) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v)

const el = (id) => document.getElementById(id)

function showToast(msg, type = 'success', duration = 3500) {
  let toast = el('toast')
  if (!toast) {
    toast = document.createElement('div')
    toast.id = 'toast'
    document.body.appendChild(toast)
  }
  toast.textContent = msg
  toast.className = 'show ' + (type === 'error' ? 'toast-error' : '')
  clearTimeout(toast._timer)
  toast._timer = setTimeout(() => toast.classList.remove('show'), duration)
}

// ── Auth / Usuário ────────────────────────────────────────

async function loadUser() {
  try {
    const res  = await fetch('/auth/me')
    const data = await res.json()

    if (data.user) {
      State.user       = data.user
      State.storePrefs = data.store_prefs  || []
      State.alerts     = data.alerts       || []
      renderUserArea()
    }
  } catch (e) {
    // Não logado — mantém botão padrão
  }
}

function renderUserArea() {
  const u = State.user
  if (!u) return

  // ── Desktop: troca botão Entrar pelo avatar ────────────────
  const btnLogin = el('user-area')
  const menuArea = el('user-menu')
  if (btnLogin) btnLogin.classList.add('hidden')
  if (menuArea) {
    menuArea.classList.remove('hidden')
    const avatar = el('user-avatar')
    const name   = el('user-name')
    if (avatar) avatar.src = u.avatar_url || ''
    if (name)   name.textContent = u.full_name?.split(' ')[0] || u.email

    // Badge de alertas ativos
    const activeAlerts = State.alerts.length
    if (activeAlerts > 0) {
      const menuBtn = menuArea.querySelector('button')
      if (menuBtn) {
        const badge = document.createElement('span')
        badge.className = 'absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-xs font-bold rounded-full flex items-center justify-center'
        badge.textContent = activeAlerts > 9 ? '9+' : activeAlerts
        menuBtn.style.position = 'relative'
        menuBtn.appendChild(badge)
      }
    }
  }

  // ── Mobile drawer: atualiza área de usuário ────────────────
  syncMobUserArea()
}

function toggleUserMenu() {
  const dropdown = el('user-dropdown')
  if (dropdown) dropdown.classList.toggle('hidden')
}

// Fecha dropdown ao clicar fora
document.addEventListener('click', (e) => {
  const menu = el('user-menu')
  if (menu && !menu.contains(e.target)) {
    const d = el('user-dropdown')
    if (d) d.classList.add('hidden')
  }

  // Fecha sugestões ao clicar fora
  const input       = el('search-input')
  const suggestions = el('suggestions')
  if (suggestions && input && !input.contains(e.target) && !suggestions.contains(e.target)) {
    closeSuggestions()
  }
})

// ── Lojas onde o usuário tem conta ───────────────────────

function userHasAccount(storeId) {
  if (!State.user) return null // null = não sabemos
  const pref = State.storePrefs.find(p => p.store_id === storeId)
  return pref ? (pref.has_account === 1) : null
}

// Injeta badge nas offer-cards da página de produto
function injectStoreBadges() {
  if (!State.user || State.storePrefs.length === 0) return

  document.querySelectorAll('[data-store-id]').forEach(card => {
    const storeId   = parseInt(card.dataset.storeId)
    const hasAcc    = userHasAccount(storeId)
    if (hasAcc === null) return

    // Remove badge antigo se existir
    card.querySelectorAll('.store-account-badge').forEach(b => b.remove())

    const badge = document.createElement('span')
    badge.className = 'store-account-badge'

    if (hasAcc) {
      badge.innerHTML = '✅ Você tem conta aqui'
      badge.style.cssText = `
        display:inline-flex;align-items:center;gap:4px;
        background:#dcfce7;color:#15803d;border:1px solid #86efac;
        font-size:0.7rem;font-weight:600;padding:2px 8px;border-radius:999px;
        margin-left:6px;
      `
    } else {
      badge.innerHTML = '⚠️ Sem conta'
      badge.style.cssText = `
        display:inline-flex;align-items:center;gap:4px;
        background:#fef9c3;color:#a16207;border:1px solid #fde047;
        font-size:0.7rem;font-weight:600;padding:2px 8px;border-radius:999px;
        margin-left:6px;
      `
    }

    // Injeta no primeiro .flex do card (ao lado do logo da loja)
    const firstFlex = card.querySelector('.flex')
    if (firstFlex) firstFlex.appendChild(badge)
  })
}

// ── Modal de Alerta de Preço ──────────────────────────────

function openAlertModal(productId, productName, imageUrl, currentPrice) {
  State.alertProductId    = productId
  State.alertCurrentPrice = typeof currentPrice === 'number' ? currentPrice : parseFloat((currentPrice || '0').replace(/[^0-9,.]/g, '').replace(',', '.')) || 0

  // Preenche info do produto no modal
  const img      = el('alert-product-img')
  const name     = el('alert-product-name')
  const price    = el('alert-current-price')
  const input    = el('alert-price-input')
  const pidInput = el('alert-product-id')
  const emailIn  = el('alert-email-input')

  if (img)      img.src = imageUrl || ''
  if (name)     name.textContent = productName
  if (price)    price.textContent = State.alertCurrentPrice ? `Preço atual: ${formatBRL(State.alertCurrentPrice)}` : ''
  if (pidInput) pidInput.value = productId || ''
  if (input) {
    // Sugere 10% abaixo do preço atual
    const suggested = State.alertCurrentPrice ? (State.alertCurrentPrice * 0.9).toFixed(2) : ''
    input.value = suggested
    input.placeholder = suggested ? `Ex: ${suggested}` : '0,00'
  }

  // Sempre mostra o botão e campo de email (alertas sem login)
  const loginMsg = el('alert-login-msg')
  const saveBtn  = el('alert-save-btn')
  if (loginMsg) loginMsg.classList.add('hidden')
  if (saveBtn)  saveBtn.classList.remove('hidden')

  // Pré-preenche email salvo no localStorage
  if (emailIn) {
    emailIn.value = localStorage.getItem('alert_email') || (State.user?.email || '')
  }

  const modal = el('alert-modal')
  if (modal) {
    modal.classList.remove('hidden')
    setTimeout(() => { if (emailIn && !emailIn.value) emailIn.focus(); else if (input) input.focus() }, 100)
  }
}

function closeAlertModal() {
  const modal = el('alert-modal')
  if (modal) modal.classList.add('hidden')
  State.alertProductId    = null
  State.alertCurrentPrice = null
}

async function saveAlert() {
  const input       = el('alert-price-input')
  const emailInput  = el('alert-email-input')
  const saveBtn     = el('alert-save-btn')
  const targetPrice = parseFloat(input?.value)
  const email       = emailInput?.value?.trim() || State.user?.email || ''

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showToast('⚠️ Digite um email válido', 'error')
    if (emailInput) emailInput.focus()
    return
  }

  if (!targetPrice || targetPrice <= 0) {
    showToast('⚠️ Digite um preço válido', 'error')
    if (input) input.focus()
    return
  }

  if (State.alertCurrentPrice && targetPrice >= State.alertCurrentPrice) {
    showToast('⚠️ O preço alvo deve ser menor que o preço atual', 'error')
    return
  }

  if (saveBtn) {
    saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Salvando...'
    saveBtn.disabled = true
  }

  try {
    const res = await fetch('/api/price-alerts', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        product_id:   parseInt(State.alertProductId),
        email:        email,
        target_price: targetPrice,
      }),
    })
    const data = await res.json()

    if (data.ok) {
      // Salva email no localStorage para próximas vezes
      localStorage.setItem('alert_email', email)
      closeAlertModal()
      showToast(`🔔 Alerta criado! Você receberá um email quando baixar para ${formatBRL(targetPrice)}`)
    } else {
      throw new Error(data.error || 'Erro ao salvar')
    }
  } catch (err) {
    showToast('❌ ' + (err.message || 'Erro ao criar alerta. Tente novamente.'), 'error')
  } finally {
    if (saveBtn) {
      saveBtn.innerHTML = 'Criar Alerta Gratuito'
      saveBtn.disabled = false
    }
  }
}

// Enter no input de preço salva o alerta
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeSuggestions()
    closeAlertModal()
  }
  if (e.key === 'Enter' && el('alert-modal') && !el('alert-modal').classList.contains('hidden')) {
    saveAlert()
  }
})

// ── Busca principal ───────────────────────────────────────

async function searchProducts(query) {
  const input = el('search-input')
  const q     = query || (input ? input.value.trim() : '')
  if (!q) return

  State.currentQuery = q
  State.isSearching  = true

  if (input) input.value = q
  const heroInput = el('hero-search')
  if (heroInput) heroInput.value = q

  closeSuggestions()

  const section = el('search-results-section')
  const title   = el('search-results-title')
  const grid    = el('search-results-grid')
  const loading = el('search-loading')
  const empty   = el('search-empty')

  if (!section) return

  section.classList.remove('hidden')
  grid.innerHTML = ''
  loading.classList.remove('hidden')
  empty.classList.add('hidden')
  title.textContent = `Buscando "${q}"...`
  section.scrollIntoView({ behavior: 'smooth', block: 'start' })

  try {
    const res  = await fetch(`/api/products?q=${encodeURIComponent(q)}&per_page=24`)
    const data = await res.json()

    loading.classList.add('hidden')

    if (!data.products || data.products.length === 0) {
      title.textContent = `Nenhum resultado para "${q}"`
      empty.classList.remove('hidden')
      return
    }

    title.textContent = `${data.total} resultado${data.total !== 1 ? 's' : ''} para "${q}"`
    grid.innerHTML    = data.products.map(renderProductCard).join('')
    grid.querySelectorAll('.product-card').forEach((card, i) => {
      card.style.animationDelay = `${i * 40}ms`
      card.classList.add('fade-in-up')
    })
  } catch (err) {
    loading.classList.add('hidden')
    title.textContent = 'Erro ao buscar produtos'
    grid.innerHTML    = '<p class="text-red-500 col-span-full text-center py-8">Erro ao conectar. Tente novamente.</p>'
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

// ── Renderiza card de produto ─────────────────────────────

function renderProductCard(p) {
  const price     = p.best_price ? formatBRL(p.best_price) : 'Ver preço'
  const storeName = p.best_store_name || ''
  const offerBadge = p.offer_count > 1
    ? `<span class="offer-badge">${p.offer_count} lojas</span>` : ''
  const brandHTML = p.brand
    ? `<span style="font-size:.75rem;color:#2563eb;font-weight:600;text-transform:uppercase;letter-spacing:.05em">${p.brand}</span>` : ''

  // Badge de conta (se soubermos)
  const hasAcc    = userHasAccount(p.best_store_id)
  const accBadge  = hasAcc === true
    ? `<span style="font-size:.65rem;background:#dcfce7;color:#15803d;border:1px solid #86efac;padding:1px 6px;border-radius:999px;font-weight:600;">✅ Tem conta</span>`
    : hasAcc === false
    ? `<span style="font-size:.65rem;background:#fef9c3;color:#a16207;border:1px solid #fde047;padding:1px 6px;border-radius:999px;font-weight:600;">⚠️ Sem conta</span>`
    : ''

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
        <div style="margin-top:auto;padding-top:.75rem">
          <div style="font-size:.75rem;color:#94a3b8;margin-bottom:.25rem;display:flex;align-items:center;gap:4px">
            ${storeName ? `em ${storeName}` : ''} ${accBadge}
          </div>
          <div style="font-size:1.25rem;font-weight:800;color:#0f172a">${price}</div>
          <div class="btn-compare" style="margin-top:.5rem">Comparar preços →</div>
        </div>
      </div>
    </a>
  `
}

// ── Sugestões de busca ────────────────────────────────────

async function fetchSuggestions(q) {
  if (q.length < 2) { closeSuggestions(); return }
  try {
    const res   = await fetch(`/api/search/suggestions?q=${encodeURIComponent(q)}`)
    const items = await res.json()
    renderSuggestions(items, q)
  } catch (e) { closeSuggestions() }
}

function renderSuggestions(items, q) {
  const box = el('suggestions')
  if (!box) return
  if (!items || items.length === 0) { closeSuggestions(); return }

  box.innerHTML = items.map(item => {
    const hasAcc   = userHasAccount(item.best_store_id)
    const accBadge = hasAcc === true
      ? `<span style="font-size:.6rem;background:#dcfce7;color:#15803d;padding:1px 5px;border-radius:999px;font-weight:600;">✅ Tem conta</span>`
      : hasAcc === false
      ? `<span style="font-size:.6rem;background:#fef9c3;color:#a16207;padding:1px 5px;border-radius:999px;font-weight:600;">⚠️ Sem conta</span>`
      : ''
    return `
      <a href="/produto/${item.slug}" class="suggestion-item">
        <img src="${item.image_url || 'https://via.placeholder.com/40?text=P'}"
             alt="${item.name}" onerror="this.style.display='none'">
        <div style="flex:1;min-width:0">
          <div style="font-size:.875rem;font-weight:500;color:#1e293b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            ${highlightQuery(item.name, q)}
          </div>
          <div style="font-size:.75rem;color:#64748b;display:flex;align-items:center;gap:4px">
            ${item.best_price ? formatBRL(item.best_price) : ''}
            ${item.brand ? '· ' + item.brand : ''}
            ${accBadge}
          </div>
        </div>
      </a>
    `
  }).join('')

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

// ── Rastreamento de clique ────────────────────────────────

async function trackClick(offerId, productId, storeId) {
  try {
    await fetch('/api/click', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ offer_id: offerId, product_id: productId, store_id: storeId }),
    })
  } catch (e) { /* Silencioso */ }
}

// ── Compartilhar ──────────────────────────────────────────

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
  const btn    = document.createElement('button')
  btn.id       = 'scroll-top'
  btn.innerHTML = '↑'
  btn.title    = 'Voltar ao topo'
  btn.onclick  = () => window.scrollTo({ top: 0, behavior: 'smooth' })
  document.body.appendChild(btn)
  window.addEventListener('scroll', () => {
    btn.classList.toggle('show', window.scrollY > 400)
  }, { passive: true })
}

// ── Header shadow no scroll ───────────────────────────────

function initHeaderScroll() {
  const header = document.querySelector('header')
  if (!header) return
  window.addEventListener('scroll', () => {
    header.style.boxShadow = window.scrollY > 10
      ? '0 2px 20px rgba(0,0,0,0.1)' : ''
  }, { passive: true })
}

// ── Lazy images ───────────────────────────────────────────

function initLazyImages() {
  if (!('IntersectionObserver' in window)) return
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target
        if (img.dataset.src) { img.src = img.dataset.src; observer.unobserve(img) }
      }
    })
  }, { rootMargin: '100px' })
  document.querySelectorAll('img[data-src]').forEach(img => observer.observe(img))
}

// ── Price chart ───────────────────────────────────────────

function initPriceChart() {
  const canvas = el('price-chart')
  if (!canvas || typeof Chart === 'undefined') return
  const labels = JSON.parse(canvas.dataset.labels || '[]')
  const prices = JSON.parse(canvas.dataset.prices || '[]')
  const colors = prices.map((_, i) => i === 0 ? '#16a34a' : '#3b82f6')
  new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: 'Preço (R$)', data: prices, backgroundColor: colors, borderRadius: 8, borderSkipped: false }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: false, ticks: { callback: (v) => formatBRL(v) } } }
    }
  })
}

// ── Init ──────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  initScrollTop()
  initLazyImages()
  initHeaderScroll()
  initPriceChart()

  // Carrega usuário logado (se houver)
  await loadUser()

  // Injeta badges de conta nas offer-cards (página de produto)
  injectStoreBadges()

  // Auto-foco hero
  const heroInput = el('hero-search')
  if (heroInput && window.location.pathname === '/') {
    setTimeout(() => heroInput.focus(), 300)
  }

  // Exibe mensagem de erro de auth se veio da URL
  if (window.location.search.includes('auth_error=1')) {
    showToast('❌ Erro ao entrar com Google. Tente novamente.', 'error')
  }
})
