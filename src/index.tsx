// ============================================================
// MAIN: Entry point do Hono — Shopping Comparador
// ============================================================

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import type { Bindings } from './types'
import api from './routes/api'
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

// ── Page Routes ───────────────────────────────────────────
app.route('/', pages)

// ── Homepage ─────────────────────────────────────────────
app.get('/', async (c) => {
  const { DB, CACHE } = c.env
  const cache = new CacheManager(CACHE)

  // Busca dados em paralelo
  const [featuredResult, dealsResult, categoriesResult] = await Promise.all([
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
    DB.prepare(`SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order ASC`).all()
  ])

  const featured = featuredResult.results as any[]
  const deals = dealsResult.results as any[]
  const categories = categoriesResult.results as any[]

  const heroHTML = `
    <section class="hero-section">
      <div class="hero-bg"></div>
      <div class="max-w-7xl mx-auto px-4 py-16 relative z-10">
        <div class="text-center max-w-3xl mx-auto">
          <h1 class="text-4xl md:text-5xl font-extrabold text-white mb-4 leading-tight">
            Compare preços em<br>
            <span class="text-yellow-400">dezenas de lojas</span>
          </h1>
          <p class="text-blue-100 text-lg mb-8">
            Amazon, Magalu, Mercado Livre, Americanas e muito mais.<br>
            Encontre o menor preço em segundos.
          </p>
          <div class="max-w-xl mx-auto">
            <div class="relative">
              <input type="text" id="hero-search" placeholder="Ex: iPhone 15, Samsung TV, Notebook Dell..."
                class="w-full pl-6 pr-16 py-4 rounded-2xl text-gray-900 text-lg shadow-2xl outline-none focus:ring-4 focus:ring-yellow-400/50"
                onkeydown="if(event.key==='Enter'){ document.getElementById('search-input').value=this.value; searchProducts(); }"
                oninput="document.getElementById('search-input').value=this.value; debounceSearch(this.value)">
              <button onclick="document.getElementById('search-input').value=document.getElementById('hero-search').value; searchProducts();"
                class="absolute right-3 top-1/2 -translate-y-1/2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl font-semibold transition-colors">
                Buscar
              </button>
            </div>
          </div>
          <div class="flex flex-wrap justify-center gap-2 mt-6">
            ${['iPhone 15', 'Galaxy S24', 'PS5', 'Notebook', 'AirPods'].map(t =>
              `<a href="#" onclick="quickSearch('${t}')" class="quick-tag">${t}</a>`
            ).join('')}
          </div>
        </div>
      </div>
    </section>
  `

  const statsHTML = `
    <section class="bg-white border-b">
      <div class="max-w-7xl mx-auto px-4 py-6">
        <div class="grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
          <div><div class="text-2xl font-bold text-blue-600">8+</div><div class="text-sm text-gray-500">Lojas parceiras</div></div>
          <div><div class="text-2xl font-bold text-blue-600">${featured.length}+</div><div class="text-sm text-gray-500">Produtos cadastrados</div></div>
          <div><div class="text-2xl font-bold text-blue-600">Tempo real</div><div class="text-sm text-gray-500">Atualização de preços</div></div>
          <div><div class="text-2xl font-bold text-blue-600">Grátis</div><div class="text-sm text-gray-500">Sempre e para sempre</div></div>
        </div>
      </div>
    </section>
  `

  const categoriesHTML = categories.length > 0 ? `
    <section class="max-w-7xl mx-auto px-4 py-10">
      <h2 class="section-title">Explorar Categorias</h2>
      <div class="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-8 gap-3">
        ${categories.map(cat => `
          <a href="/categoria/${cat.slug}" class="category-card">
            <span class="text-3xl mb-2">${cat.icon || '🛒'}</span>
            <span class="text-xs font-semibold text-gray-700 text-center leading-tight">${cat.name}</span>
            ${cat.product_count > 0 ? `<span class="text-xs text-gray-400">${cat.product_count}</span>` : ''}
          </a>
        `).join('')}
      </div>
    </section>
  ` : ''

  const dealsHTML = deals.length > 0 ? `
    <section class="bg-gradient-to-r from-red-50 to-orange-50 border-y border-orange-100 py-10">
      <div class="max-w-7xl mx-auto px-4">
        <div class="flex items-center justify-between mb-6">
          <h2 class="section-title mb-0">🔥 Maiores Descontos</h2>
          <a href="/ofertas" class="text-sm text-blue-600 hover:underline font-medium">Ver todas →</a>
        </div>
        <div class="product-grid">
          ${deals.map(p => {
            const discount = Math.round((p as any).top_discount || 0)
            const card = renderProductCard(p)
            return card.replace('product-card group', 'product-card group relative').replace(
              '</a>',
              `${discount > 0 ? `<div class="absolute top-3 left-3 bg-red-500 text-white text-xs font-bold px-2 py-1 rounded-full">-${discount}%</div>` : ''}</a>`
            )
          }).join('')}
        </div>
      </div>
    </section>
  ` : ''

  const featuredHTML = featured.length > 0 ? `
    <section class="max-w-7xl mx-auto px-4 py-10">
      <div class="flex items-center justify-between mb-6">
        <h2 class="section-title mb-0">⭐ Produtos em Destaque</h2>
      </div>
      <div class="product-grid">
        ${featured.map(renderProductCard).join('')}
      </div>
    </section>
  ` : ''

  const howItWorksHTML = `
    <section class="bg-blue-700 text-white py-14">
      <div class="max-w-5xl mx-auto px-4 text-center">
        <h2 class="text-2xl font-bold mb-10">Como funciona o ShoppingCompare</h2>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div class="flex flex-col items-center">
            <div class="w-14 h-14 bg-white/20 rounded-2xl flex items-center justify-center text-3xl mb-4">🔍</div>
            <h3 class="font-bold mb-2">1. Busque</h3>
            <p class="text-blue-100 text-sm">Digite o nome do produto que você quer comprar.</p>
          </div>
          <div class="flex flex-col items-center">
            <div class="w-14 h-14 bg-white/20 rounded-2xl flex items-center justify-center text-3xl mb-4">📊</div>
            <h3 class="font-bold mb-2">2. Compare</h3>
            <p class="text-blue-100 text-sm">Veja os preços de todas as lojas em uma única página.</p>
          </div>
          <div class="flex flex-col items-center">
            <div class="w-14 h-14 bg-white/20 rounded-2xl flex items-center justify-center text-3xl mb-4">💸</div>
            <h3 class="font-bold mb-2">3. Economize</h3>
            <p class="text-blue-100 text-sm">Clique em "Comprar Agora" e vá direto ao checkout.</p>
          </div>
        </div>
      </div>
    </section>
  `

  const searchResultsHTML = `
    <section id="search-results-section" class="hidden max-w-7xl mx-auto px-4 py-10">
      <div class="flex items-center justify-between mb-6">
        <h2 class="section-title mb-0" id="search-results-title">Resultados da busca</h2>
        <button onclick="closeSearch()" class="text-sm text-gray-500 hover:text-gray-800">✕ Fechar</button>
      </div>
      <div id="search-results-grid" class="product-grid"></div>
      <div id="search-loading" class="hidden text-center py-12">
        <div class="inline-block animate-spin rounded-full h-10 w-10 border-4 border-blue-600 border-t-transparent"></div>
        <p class="text-gray-500 mt-3">Buscando produtos...</p>
      </div>
      <div id="search-empty" class="hidden text-center py-12">
        <div class="text-5xl mb-3">🔍</div>
        <p class="text-gray-500 font-medium">Nenhum produto encontrado</p>
        <p class="text-sm text-gray-400 mt-1">Tente outros termos ou navegue pelas categorias</p>
      </div>
    </section>
  `

  const content = heroHTML + statsHTML + searchResultsHTML + categoriesHTML + dealsHTML + featuredHTML + howItWorksHTML

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
