// ============================================================
// MAIN: Entry point do Hono — Shopping Comparador
// ============================================================

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import type { Bindings } from './types'
import api from './routes/api'
import admin from './routes/admin'
import auth from './routes/auth'
import onboarding from './routes/onboarding'
import pages, { renderLayout, renderProductCard, formatCurrency } from './routes/pages'
import { CacheManager } from './lib/cache'

const app = new Hono<{ Bindings: Bindings }>()

// ── Middlewares ───────────────────────────────────────────
app.use('/api/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}))

// ── Static Files ──────────────────────────────────────────
app.use('/static/*', serveStatic({ root: './' }))

// ── Favicon ───────────────────────────────────────────────
app.get('/favicon.ico', (c) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
    <rect width="32" height="32" rx="8" fill="#2563eb"/>
    <text x="16" y="23" font-size="20" text-anchor="middle" fill="white" font-family="Arial" font-weight="bold">S</text>
  </svg>`
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } })
})

// ── API Routes ────────────────────────────────────────────
app.route('/api', api)

// ── Auth Routes (Google OAuth + Alertas) ─────────────────
app.route('/auth', auth)

// ── Onboarding (seleção de lojas pós-login) ──────────────
app.route('/onboarding', onboarding)

// ── Admin Routes (protegido por Bearer token / ADMIN_SECRET) ─
app.route('/admin', admin)

// ── Page Routes ───────────────────────────────────────────
app.route('/', pages)

// ── Homepage ─────────────────────────────────────────────
app.get('/', async (c) => {
  const { DB, CACHE } = c.env
  const cache = new CacheManager(CACHE)

  // Lojas parceiras fixas com dados visuais
  const storePartners = [
    { name: 'Amazon',          slug: 'amazon',         color: '#FF9900', bg: '#fff8ee', text: 'Até 40% OFF',  initial: 'A' },
    { name: 'Magalu',          slug: 'magalu',         color: '#0086FF', bg: '#eef5ff', text: 'Frete Grátis', initial: 'M' },
    { name: 'Mercado Livre',   slug: 'mercadolivre',   color: '#FFE600', bg: '#fffde6', text: 'Menor Preço',  initial: 'ML' },
    { name: 'Americanas',      slug: 'americanas',     color: '#E60014', bg: '#fff0f1', text: 'Cupons',       initial: 'Am' },
    { name: 'Casas Bahia',     slug: 'casasbahia',     color: '#0057A8', bg: '#eef3ff', text: '12x sem juros',initial: 'CB' },
    { name: 'Kabum',           slug: 'kabum',          color: '#F47920', bg: '#fff5ee', text: 'Tech & Games', initial: 'K' },
    { name: 'Fast Shop',       slug: 'fastshop',       color: '#00843D', bg: '#eefff5', text: 'Premium',      initial: 'FS' },
    { name: 'Ponto Frio',      slug: 'pontofrio',      color: '#00AAFF', bg: '#eef8ff', text: 'Parcelas',     initial: 'PF' },
  ]

  // Busca dados em paralelo
  const [featuredResult, dealsResult, categoriesResult, storesResult] = await Promise.all([
    DB.prepare(`
      SELECT p.*, s.name as best_store_name, s.slug as best_store_slug
      FROM products p LEFT JOIN stores s ON s.id = p.best_store_id
      WHERE p.is_active = 1 AND p.best_price IS NOT NULL
      ORDER BY p.offer_count DESC, p.created_at DESC LIMIT 8
    `).all(),
    DB.prepare(`
      SELECT p.*, s.name as best_store_name, o.discount_percent as top_discount
      FROM products p
      LEFT JOIN stores s ON s.id = p.best_store_id
      JOIN offers o ON o.product_id = p.id AND o.store_id = p.best_store_id AND o.is_active = 1
      WHERE p.is_active = 1 AND o.discount_percent > 0
      ORDER BY o.discount_percent DESC LIMIT 8
    `).all(),
    DB.prepare(`SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order ASC`).all(),
    DB.prepare(`SELECT id, name, slug, logo_url FROM stores WHERE is_active = 1 LIMIT 8`).all(),
  ])

  const featured  = featuredResult.results  as any[]
  const deals     = dealsResult.results     as any[]
  const categories = categoriesResult.results as any[]
  const dbStores  = storesResult.results    as any[]

  // Mescla lojas do banco com dados visuais fixos
  const stores = storePartners.map(sp => {
    const db = dbStores.find((s: any) => s.slug === sp.slug) || {}
    return { ...sp, ...db, ...sp } // sp tem prioridade para visual
  })

  // ── HERO ─────────────────────────────────────────────────
  const heroHTML = `
    <section class="hero-section">
      <div class="hero-orb hero-orb-1"></div>
      <div class="hero-orb hero-orb-2"></div>
      <div class="hero-orb hero-orb-3"></div>

      <div class="max-w-5xl mx-auto px-4 py-10 md:py-14 relative z-10">

        <!-- Badge topo -->
        <div class="flex justify-center mb-5">
          <span class="inline-flex items-center gap-2 bg-white/15 backdrop-blur-sm border border-white/25 text-white text-xs font-semibold px-4 py-1.5 rounded-full">
            <span class="w-2 h-2 bg-green-400 rounded-full animate-pulse"></span>
            Comparando preços em tempo real
          </span>
        </div>

        <!-- Título -->
        <div class="text-center mb-7">
          <h1 class="text-4xl md:text-5xl lg:text-6xl font-black text-white mb-3 leading-[1.1] tracking-tight">
            Compare preços e<br>
            <span class="hero-gradient-text">economize de verdade</span>
          </h1>
          <p class="text-blue-100/80 text-base md:text-lg max-w-xl mx-auto">
            Veja de uma vez só o menor preço em Amazon, Magalu, Mercado Livre e muito mais.
          </p>
        </div>

        <!-- Barra de busca grande -->
        <div class="max-w-2xl mx-auto mb-7">
          <div class="relative">
            <svg class="absolute left-5 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
            </svg>
            <input type="text" id="hero-search"
              placeholder="O que você quer comprar hoje?"
              class="w-full pl-14 pr-32 py-4 rounded-2xl text-gray-900 text-base md:text-lg shadow-2xl outline-none focus:ring-4 focus:ring-yellow-300/60 border-0 font-medium"
              autocomplete="off"
              onkeydown="if(event.key==='Enter'){ document.getElementById('search-input').value=this.value; searchProducts(); }"
              oninput="document.getElementById('search-input').value=this.value; debounceSearch(this.value)">
            <button
              onclick="document.getElementById('search-input').value=document.getElementById('hero-search').value; searchProducts();"
              class="absolute right-2 top-1/2 -translate-y-1/2 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 active:scale-95 text-white px-5 py-2.5 rounded-xl font-bold text-sm transition-all shadow-lg">
              Buscar
            </button>
          </div>
          <!-- Tags rápidas -->
          <div class="flex flex-wrap justify-center gap-2 mt-3">
            ${['iPhone 15', 'Galaxy S24', 'PS5', 'Notebook', 'AirPods', 'Smart TV'].map(t =>
              `<button onclick="quickSearch('${t}')" class="quick-tag">${t}</button>`
            ).join('')}
          </div>
        </div>

        <!-- Grade de categorias DENTRO do hero -->
        ${categories.length > 0 ? `
        <div class="hero-cats-panel">
          <p class="text-white/60 text-xs font-bold uppercase tracking-widest text-center mb-4 flex items-center justify-center gap-2">
            <span class="w-6 h-px bg-white/30"></span>
            Escolha uma categoria
            <span class="w-6 h-px bg-white/30"></span>
          </p>
          <div class="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2">
            ${categories.map((cat: any) => `
              <a href="/categoria/${cat.slug}" class="hero-cat-btn">
                <span class="hero-cat-icon">${cat.icon || '🛒'}</span>
                <span class="hero-cat-name">${cat.name}</span>
                ${cat.product_count > 0 ? `<span class="hero-cat-count">${cat.product_count}</span>` : ''}
              </a>
            `).join('')}
          </div>
        </div>
        ` : ''}

      </div>
    </section>
  `

  // ── FAIXA DE LOJAS PARCEIRAS ──────────────────────────────
  const storesHTML = `
    <section class="bg-white border-b border-gray-100">
      <div class="max-w-7xl mx-auto px-4 py-6">
        <div class="flex items-center gap-3 mb-5">
          <h2 class="text-base font-bold text-gray-800">Compare preços em</h2>
          <span class="text-xs text-gray-400 font-medium">${stores.length}+ lojas parceiras</span>
        </div>
        <div class="grid grid-cols-4 sm:grid-cols-8 gap-3">
          ${stores.map(s => `
            <a href="/categoria/smartphones?loja=${s.slug}"
               class="store-pill group"
               title="${s.name}">
              <div class="store-pill-logo" style="background:${s.bg}; border-color:${s.color}20;">
                ${s.logo_url
                  ? `<img src="${s.logo_url}" alt="${s.name}" class="w-8 h-8 object-contain">`
                  : `<span class="font-black text-sm" style="color:${s.color}">${s.initial}</span>`
                }
              </div>
              <span class="store-pill-name">${s.name}</span>
              <span class="store-pill-tag" style="color:${s.color}">${s.text}</span>
            </a>
          `).join('')}
        </div>
      </div>
    </section>
  `

  // ── BANNER DESTAQUE (sem imagem externa — todo CSS) ────────
  const bannerHTML = `
    <section class="max-w-7xl mx-auto px-4 py-6">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">

        <!-- Banner principal -->
        <div class="md:col-span-2 promo-banner promo-banner-main group cursor-pointer"
             onclick="quickSearch('Smartphone')">
          <div class="promo-banner-orb"></div>
          <div class="relative z-10">
            <span class="inline-block bg-yellow-400 text-yellow-900 text-xs font-black px-3 py-1 rounded-full mb-3 uppercase tracking-wide">
              🔥 Destaque do dia
            </span>
            <h3 class="text-2xl md:text-3xl font-black text-white mb-2 leading-tight">
              Smartphones<br>com o menor<br>preço garantido
            </h3>
            <p class="text-blue-100/80 text-sm mb-4">Compare em todas as lojas e economize até R$ 800</p>
            <span class="inline-flex items-center gap-2 bg-white text-blue-700 font-bold text-sm px-4 py-2 rounded-xl group-hover:bg-yellow-400 group-hover:text-yellow-900 transition-colors">
              Ver comparativos →
            </span>
          </div>
          <div class="absolute right-4 bottom-0 text-8xl opacity-20 select-none pointer-events-none">📱</div>
        </div>

        <!-- Banners secundários -->
        <div class="flex flex-col gap-4">
          <div class="promo-banner promo-banner-secondary group cursor-pointer flex-1"
               onclick="quickSearch('Notebook')">
            <div class="relative z-10">
              <span class="text-xs font-bold text-indigo-300 uppercase tracking-wide">Notebooks</span>
              <h4 class="text-lg font-black text-white mt-1 leading-tight">Até 30% OFF<br>nos melhores modelos</h4>
            </div>
            <div class="absolute right-3 bottom-2 text-5xl opacity-20 select-none pointer-events-none">💻</div>
          </div>
          <div class="promo-banner promo-banner-green group cursor-pointer flex-1"
               onclick="quickSearch('Smart TV')">
            <div class="relative z-10">
              <span class="text-xs font-bold text-emerald-300 uppercase tracking-wide">Smart TVs</span>
              <h4 class="text-lg font-black text-white mt-1 leading-tight">Compare 4K e OLED<br>nas melhores lojas</h4>
            </div>
            <div class="absolute right-3 bottom-2 text-5xl opacity-20 select-none pointer-events-none">📺</div>
          </div>
        </div>

      </div>
    </section>
  `

  // ── SEÇÃO DE BUSCA (aparece ao buscar) ────────────────────
  const searchResultsHTML = `
    <section id="search-results-section" class="hidden max-w-7xl mx-auto px-4 py-8">
      <div class="flex items-center justify-between mb-5">
        <h2 class="section-title mb-0" id="search-results-title">Resultados da busca</h2>
        <button onclick="closeSearch()" class="text-sm text-gray-400 hover:text-gray-700 flex items-center gap-1">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
          Fechar
        </button>
      </div>
      <div id="search-results-grid" class="product-grid"></div>
      <div id="search-loading" class="hidden text-center py-12">
        <div class="inline-block animate-spin rounded-full h-10 w-10 border-4 border-blue-600 border-t-transparent"></div>
        <p class="text-gray-500 mt-3 font-medium">Buscando produtos...</p>
      </div>
      <div id="search-empty" class="hidden text-center py-16">
        <div class="text-6xl mb-4">🔍</div>
        <p class="text-gray-700 font-bold text-lg">Nenhum produto encontrado</p>
        <p class="text-sm text-gray-400 mt-1">Tente outros termos ou navegue pelas categorias abaixo</p>
      </div>
    </section>
  `

  // ── MAIORES DESCONTOS ─────────────────────────────────────
  const dealsHTML = deals.length > 0 ? `
    <section class="py-8">
      <div class="max-w-7xl mx-auto px-4">
        <div class="flex items-center justify-between mb-5">
          <div class="flex items-center gap-3">
            <div class="w-1 h-7 bg-gradient-to-b from-red-500 to-orange-400 rounded-full"></div>
            <h2 class="text-xl font-black text-gray-900">Maiores Descontos</h2>
            <span class="bg-red-100 text-red-600 text-xs font-bold px-2.5 py-1 rounded-full">HOT</span>
          </div>
          <a href="/ofertas" class="text-sm text-blue-600 hover:text-blue-800 font-semibold flex items-center gap-1">
            Ver todas <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
          </a>
        </div>
        <div class="product-grid">
          ${deals.map((p: any) => {
            const discount = Math.round(p.top_discount || 0)
            const card = renderProductCard(p)
            return card.replace('product-card group', 'product-card group relative').replace(
              '</a>',
              `${discount > 0 ? `<div class="absolute top-3 left-3 bg-red-500 text-white text-xs font-black px-2 py-0.5 rounded-lg shadow">-${discount}%</div>` : ''}</a>`
            )
          }).join('')}
        </div>
      </div>
    </section>
  ` : ''

  // ── CATEGORIAS EM BLOCOS (estilo Buscapé com nossa cara) ──
  const catBlocksHTML = categories.length > 0 ? `
    <section class="bg-white border-y border-gray-100 py-8">
      <div class="max-w-7xl mx-auto px-4">
        <div class="flex items-center justify-between mb-5">
          <div class="flex items-center gap-3">
            <div class="w-1 h-7 bg-gradient-to-b from-blue-500 to-blue-700 rounded-full"></div>
            <h2 class="text-xl font-black text-gray-900">Explorar por Categoria</h2>
          </div>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-4 lg:grid-cols-8 gap-3">
          ${categories.map((cat: any) => `
            <a href="/categoria/${cat.slug}" class="cat-block">
              <div class="cat-block-icon">${cat.icon || '🛒'}</div>
              <span class="cat-block-name">${cat.name}</span>
              ${cat.product_count > 0 ? `<span class="cat-block-count">${cat.product_count} produtos</span>` : ''}
            </a>
          `).join('')}
        </div>
      </div>
    </section>
  ` : ''

  // ── EM DESTAQUE ───────────────────────────────────────────
  const featuredHTML = featured.length > 0 ? `
    <section class="py-8">
      <div class="max-w-7xl mx-auto px-4">
        <div class="flex items-center justify-between mb-5">
          <div class="flex items-center gap-3">
            <div class="w-1 h-7 bg-gradient-to-b from-blue-500 to-indigo-600 rounded-full"></div>
            <h2 class="text-xl font-black text-gray-900">Em Destaque</h2>
          </div>
        </div>
        <div class="product-grid">
          ${featured.map(renderProductCard).join('')}
        </div>
      </div>
    </section>
  ` : ''

  // ── COMO FUNCIONA ─────────────────────────────────────────
  const howHTML = `
    <section class="how-section">
      <div class="max-w-5xl mx-auto px-4 text-center">
        <h2 class="text-2xl font-black text-white mb-2">Como o ShoppingCompare funciona</h2>
        <p class="text-blue-200/70 text-sm mb-10">Simples, rápido e gratuito — sempre</p>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div class="how-step">
            <div class="how-step-num">1</div>
            <div class="how-step-icon">🔍</div>
            <h3 class="font-bold text-white mb-1">Busque</h3>
            <p class="text-blue-200/70 text-sm">Digite o nome, modelo ou marca do produto.</p>
          </div>
          <div class="how-step">
            <div class="how-step-num">2</div>
            <div class="how-step-icon">📊</div>
            <h3 class="font-bold text-white mb-1">Compare</h3>
            <p class="text-blue-200/70 text-sm">Veja os preços de todas as lojas lado a lado.</p>
          </div>
          <div class="how-step">
            <div class="how-step-num">3</div>
            <div class="how-step-icon">💰</div>
            <h3 class="font-bold text-white mb-1">Economize</h3>
            <p class="text-blue-200/70 text-sm">Clique e vá direto para o checkout da loja.</p>
          </div>
        </div>
        <!-- CTA criar alerta -->
        <div class="mt-10 inline-flex flex-col sm:flex-row items-center gap-3">
          <a href="/auth/google"
             class="inline-flex items-center gap-2 bg-white text-blue-700 font-bold px-6 py-3 rounded-2xl hover:bg-yellow-300 hover:text-blue-900 transition-colors shadow-lg">
            🔔 Criar alerta de preço grátis
          </a>
          <span class="text-blue-200/60 text-sm">Te avisamos quando o preço cair</span>
        </div>
      </div>
    </section>
  `

  const content = heroHTML + storesHTML + bannerHTML + searchResultsHTML + dealsHTML + catBlocksHTML + featuredHTML + howHTML

  return c.html(renderLayout('ShoppingCompare — Compare preços e economize', content))
})

// ── 404 ───────────────────────────────────────────────────
app.notFound((c) => {
  return c.html(renderLayout('Página não encontrada', `
    <div class="max-w-4xl mx-auto px-4 py-24 text-center">
      <div class="text-7xl mb-6">404</div>
      <h1 class="text-2xl font-bold text-gray-800 mb-3">Página não encontrada</h1>
      <p class="text-gray-500 mb-8">A página que você procura não existe ou foi movida.</p>
      <a href="/" class="btn-primary">Voltar ao início</a>
    </div>
  `), 404)
})

export default app
