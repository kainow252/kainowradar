// ============================================================
// ROUTES: Pages — SSR das páginas HTML (Hono JSX)
// ============================================================

import { Hono } from 'hono'
import type { Bindings, Product, Offer, Category } from '../types'
import { CacheManager } from '../lib/cache'
import { DeeplinkEngine } from '../lib/deeplink'

const pages = new Hono<{ Bindings: Bindings }>()

// ── Redirect de clique com rastreamento ───────────────────
pages.get('/go/:slug/:offerId', async (c) => {
  const { DB } = c.env
  const offerId = parseInt(c.req.param('offerId'))
  const slug = c.req.param('slug')

  const offer = await DB
    .prepare(`
      SELECT o.*, s.slug as store_slug, s.name as store_name,
             s.affiliate_id, s.affiliate_network
      FROM offers o JOIN stores s ON s.id = o.store_id
      WHERE o.id = ? AND o.is_active = 1
    `)
    .bind(offerId)
    .first<any>()

  if (!offer) return c.redirect(`/produto/${slug}`)

  // Registra clique async (não bloqueia redirect)
  const ipHash = await hashIP(c.req.header('CF-Connecting-IP') || '0')
  DB.prepare(`INSERT INTO click_events (offer_id, store_id, ip_hash, user_agent) VALUES (?,?,?,?)`)
    .bind(offerId, offer.store_id, ipHash, c.req.header('User-Agent') || '')
    .run()

  // Gera URL de afiliado e redireciona
  const finalUrl = DeeplinkEngine.generateAffiliateUrl(
    offer.checkout_url || offer.product_url || '#',
    { slug: offer.store_slug, name: offer.store_name, affiliate_id: offer.affiliate_id, affiliate_network: offer.affiliate_network } as any
  )

  return c.redirect(finalUrl, 302)
})

// ── Página de produto ─────────────────────────────────────
pages.get('/produto/:slug', async (c) => {
  const { DB, CACHE } = c.env
  const slug = c.req.param('slug')
  const cache = new CacheManager(CACHE)

  const cached = await cache.getProduct(slug)
  let product: Product | null = null
  let offers: Offer[] = []

  if (cached) {
    product = cached.product
    offers = cached.offers
  } else {
    product = await DB
      .prepare(`SELECT p.*, s.name as best_store_name FROM products p LEFT JOIN stores s ON s.id = p.best_store_id WHERE p.slug = ? AND p.is_active = 1`)
      .bind(slug)
      .first<Product>()

    if (product) {
      const { results } = await DB
        .prepare(`SELECT o.*, s.name as store_name, s.slug as store_slug, s.logo_url as store_logo FROM offers o JOIN stores s ON s.id = o.store_id WHERE o.product_id = ? AND o.is_active = 1 ORDER BY o.price ASC`)
        .bind(product.id)
        .all<Offer>()
      offers = results
      await cache.setProduct(slug, { product, offers })
    }
  }

  if (!product) {
    return c.html(renderLayout('Produto não encontrado', `
      <div class="max-w-4xl mx-auto px-4 py-16 text-center">
        <div class="text-6xl mb-4">😕</div>
        <h1 class="text-2xl font-bold text-gray-800 mb-2">Produto não encontrado</h1>
        <p class="text-gray-500 mb-6">O produto que você procura pode ter sido removido.</p>
        <a href="/" class="btn-primary">Voltar ao início</a>
      </div>
    `), 404)
  }

  const specs = product.specs ? JSON.parse(product.specs) : {}
  const specKeys = Object.keys(specs)

  const offersHTML = offers.map((o, i) => {
    const trackUrl = `/go/${slug}/${o.id}`
    const savings = o.original_price && o.original_price > o.price
      ? `<span class="text-green-600 text-sm font-medium">Economize ${formatCurrency(o.original_price - o.price)}</span>` : ''
    const badge = i === 0 ? '<span class="badge badge-green">Melhor Preço</span>' : ''
    const discountBadge = o.discount_percent > 0 ? `<span class="badge badge-red">-${Math.round(o.discount_percent)}%</span>` : ''
    const shipping = o.free_shipping ? '<span class="text-green-600 text-xs font-medium">✓ Frete Grátis</span>' : '<span class="text-gray-400 text-xs">Frete a consultar</span>'
    const storeLogoHTML = o.store_logo
      ? `<img src="${o.store_logo}" alt="${o.store_name}" class="h-6 max-w-[80px] object-contain">`
      : `<span class="font-bold text-sm text-gray-700">${o.store_name}</span>`

    return `
      <div class="offer-card ${i === 0 ? 'border-2 border-green-400 bg-green-50' : 'border border-gray-200 bg-white'}">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">${storeLogoHTML} ${badge} ${discountBadge}</div>
          <div class="text-right">${shipping}</div>
        </div>
        <div class="flex items-end justify-between">
          <div>
            ${o.original_price && o.original_price > o.price ? `<div class="text-sm text-gray-400 line-through">${formatCurrency(o.original_price)}</div>` : ''}
            <div class="text-3xl font-bold text-gray-900">${formatCurrency(o.price)}</div>
            ${savings}
            ${o.installments_count ? `<div class="text-sm text-gray-500">ou ${o.installments_count}x de ${formatCurrency(o.installments_value || o.price / o.installments_count)}</div>` : ''}
          </div>
          <a href="${trackUrl}" target="_blank" rel="noopener sponsored"
             onclick="trackClick(${o.id}, ${product!.id}, ${o.store_id})"
             class="btn-buy">
            Comprar Agora →
          </a>
        </div>
        ${o.seller_name ? `<div class="text-xs text-gray-400 mt-2">Vendido por: ${o.seller_name}</div>` : ''}
      </div>
    `
  }).join('')

  const specsHTML = specKeys.length > 0 ? `
    <div class="bg-white rounded-2xl shadow-sm border p-6 mt-6">
      <h2 class="text-lg font-bold text-gray-800 mb-4">📋 Especificações Técnicas</h2>
      <div class="grid grid-cols-2 gap-3">
        ${specKeys.map(k => `
          <div class="flex flex-col bg-gray-50 rounded-lg p-3">
            <span class="text-xs text-gray-500 uppercase tracking-wide">${k.replace(/_/g, ' ')}</span>
            <span class="font-semibold text-gray-800">${specs[k]}</span>
          </div>
        `).join('')}
      </div>
    </div>
  ` : ''

  const priceRangeHTML = offers.length > 1 ? (() => {
    const min = Math.min(...offers.map(o => o.price))
    const max = Math.max(...offers.map(o => o.price))
    const diff = max - min
    return `<div class="text-sm text-gray-500 mt-1">Variação: <span class="text-green-600 font-medium">${formatCurrency(min)}</span> até <span class="text-red-500 font-medium">${formatCurrency(max)}</span> — Economize até <strong>${formatCurrency(diff)}</strong></div>`
  })() : ''

  const content = `
    <div class="max-w-6xl mx-auto px-4 py-8">
      <!-- Breadcrumb -->
      <nav class="text-sm text-gray-500 mb-6 flex items-center gap-2">
        <a href="/" class="hover:text-blue-600">Início</a> /
        <a href="/categoria/${product.category}" class="hover:text-blue-600 capitalize">${product.category || 'Outros'}</a> /
        <span class="text-gray-800 font-medium truncate max-w-xs">${product.name}</span>
      </nav>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <!-- Imagem -->
        <div class="sticky top-4">
          <div class="bg-white rounded-2xl shadow-sm border p-8 flex items-center justify-center min-h-[350px]">
            <img src="${product.image_url || 'https://via.placeholder.com/400x400?text=Produto'}"
                 alt="${product.name}" class="max-h-80 object-contain mx-auto">
          </div>
          ${product.brand ? `<div class="text-center mt-3 text-sm text-gray-500">Marca: <strong>${product.brand}</strong></div>` : ''}
          ${product.ean ? `<div class="text-center text-xs text-gray-400">EAN: ${product.ean}</div>` : ''}
        </div>

        <!-- Info + Ofertas -->
        <div>
          <h1 class="text-2xl font-bold text-gray-900 mb-2 leading-tight">${product.name}</h1>
          
          <div class="flex items-center gap-3 mb-4">
            <div class="flex items-center gap-1 text-yellow-500">★★★★☆</div>
            <span class="text-sm text-gray-500">${offers.length} oferta${offers.length !== 1 ? 's' : ''} encontrada${offers.length !== 1 ? 's' : ''}</span>
          </div>

          ${priceRangeHTML}

          <!-- Comparador de preços -->
          <div class="mt-6">
            <h2 class="text-lg font-bold text-gray-800 mb-3">🏷️ Compare os Preços</h2>
            <div class="space-y-3">${offersHTML}</div>
          </div>

          ${product.description ? `
            <div class="bg-blue-50 rounded-xl p-4 mt-6">
              <h2 class="text-sm font-bold text-blue-800 mb-2">Sobre o produto</h2>
              <p class="text-sm text-gray-700">${product.description}</p>
            </div>
          ` : ''}
        </div>
      </div>

      ${specsHTML}
    </div>
  `

  return c.html(renderLayout(`${product.name} — Menor Preço | Shopping`, content))
})

// ── Página de categoria ───────────────────────────────────
pages.get('/categoria/:slug', async (c) => {
  const slug = c.req.param('slug')
  const page = parseInt(c.req.query('page') || '1')
  const sort = c.req.query('sort') || 'price_asc'
  const { DB } = c.env

  const category = await DB.prepare('SELECT * FROM categories WHERE slug = ?').bind(slug).first<Category>()
  const catName = category?.name || slug

  const offset = (page - 1) * 24
  const orderBy = sort === 'price_asc' ? 'p.best_price ASC' : sort === 'price_desc' ? 'p.best_price DESC' : 'p.offer_count DESC'

  const { results: products } = await DB
    .prepare(`
      SELECT p.*, s.name as best_store_name, s.slug as best_store_slug
      FROM products p LEFT JOIN stores s ON s.id = p.best_store_id
      WHERE p.category = ? AND p.is_active = 1 AND p.best_price IS NOT NULL
      ORDER BY ${orderBy} LIMIT 24 OFFSET ?
    `)
    .bind(slug, offset)
    .all<Product>()

  const content = `
    <div class="max-w-7xl mx-auto px-4 py-8">
      <div class="flex items-center justify-between mb-6">
        <h1 class="text-2xl font-bold text-gray-900">
          ${category?.icon || '🛍️'} ${catName}
          <span class="text-base font-normal text-gray-500 ml-2">${category?.product_count || products.length} produtos</span>
        </h1>
        <select onchange="location.href='?sort='+this.value" class="sort-select">
          <option value="relevance" ${sort === 'relevance' ? 'selected' : ''}>Relevância</option>
          <option value="price_asc" ${sort === 'price_asc' ? 'selected' : ''}>Menor Preço</option>
          <option value="price_desc" ${sort === 'price_desc' ? 'selected' : ''}>Maior Preço</option>
        </select>
      </div>
      <div class="product-grid">${products.map(renderProductCard).join('')}</div>
    </div>
  `
  return c.html(renderLayout(`${catName} — Melhores Preços | Shopping`, content))
})

// ── Helpers ───────────────────────────────────────────────
function formatCurrency(v: number | undefined): string {
  if (v === undefined || v === null) return 'N/A'
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v)
}

async function hashIP(ip: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(ip + 'salt_shopping')
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16)
}

function renderProductCard(p: Product): string {
  const price = p.best_price ? formatCurrency(p.best_price) : 'Ver preço'
  const storeName = (p as any).best_store_name || ''
  return `
    <a href="/produto/${p.slug}" class="product-card group">
      <div class="product-card-img">
        <img src="${p.image_url || 'https://via.placeholder.com/300x300?text=Produto'}" alt="${p.name}" loading="lazy" class="w-full h-full object-contain group-hover:scale-105 transition-transform duration-300">
        ${p.offer_count > 1 ? `<span class="offer-badge">${p.offer_count} lojas</span>` : ''}
      </div>
      <div class="product-card-body">
        ${p.brand ? `<span class="text-xs text-blue-600 font-semibold uppercase tracking-wide">${p.brand}</span>` : ''}
        <h3 class="product-card-title">${p.name}</h3>
        <div class="mt-auto pt-3">
          <div class="text-xs text-gray-400 mb-1">${storeName ? `em ${storeName}` : ''}</div>
          <div class="text-xl font-bold text-gray-900">${price}</div>
          <div class="mt-2 btn-compare">Comparar preços →</div>
        </div>
      </div>
    </a>
  `
}

export function renderLayout(title: string, content: string, opts: { hideHeader?: boolean } = {}): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <meta name="description" content="Compare preços em dezenas de lojas e economize. Amazon, Magalu, Mercado Livre e mais.">
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
  <link href="/static/style.css" rel="stylesheet">
  <script>
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: { sans: ['Inter', 'sans-serif'] },
          colors: {
            primary: { 50:'#eff6ff', 100:'#dbeafe', 500:'#3b82f6', 600:'#2563eb', 700:'#1d4ed8' }
          }
        }
      }
    }
  </script>
</head>
<body class="bg-gray-50 font-sans antialiased">

  ${opts.hideHeader ? '' : `
  <!-- HEADER PRINCIPAL -->
  <header class="sticky top-0 z-50 bg-white border-b border-gray-100" id="main-header">

    <!-- Barra superior: logo + busca + usuário -->
    <div class="max-w-7xl mx-auto px-4">
      <div class="flex items-center gap-3 h-[60px]">

        <!-- Logo -->
        <a href="/" class="flex items-center gap-2 shrink-0 mr-2">
          <div class="w-9 h-9 bg-gradient-to-br from-blue-500 to-blue-700 rounded-xl flex items-center justify-center shadow-md shadow-blue-200">
            <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
            </svg>
          </div>
          <div class="hidden sm:block">
            <span class="font-black text-lg text-gray-900 tracking-tight leading-none">Shopping</span><span class="font-black text-lg text-blue-600 tracking-tight leading-none">Compare</span>
          </div>
        </a>

        <!-- Search Bar central (flex-1) -->
        <div class="flex-1">
          <div class="relative">
            <svg class="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
            </svg>
            <input type="text" id="search-input"
              placeholder="Buscar produto, marca, modelo..."
              class="w-full pl-10 pr-20 py-2.5 rounded-2xl border border-gray-200 bg-gray-50 hover:bg-white focus:bg-white focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none text-sm transition-all"
              autocomplete="off"
              onkeydown="if(event.key==='Enter') searchProducts()"
              oninput="debounceSearch(this.value)">
            <button onclick="searchProducts()"
              class="absolute right-1.5 top-1/2 -translate-y-1/2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold px-3 py-1.5 rounded-xl transition-colors">
              Buscar
            </button>
            <div id="suggestions" class="hidden absolute top-full left-0 right-0 mt-1 bg-white rounded-2xl shadow-xl border border-gray-100 z-50 max-h-80 overflow-auto"></div>
          </div>
        </div>

        <!-- Alertas (ícone) -->
        <a href="/meus-alertas" title="Meus Alertas"
           class="hidden md:flex items-center gap-1.5 text-gray-500 hover:text-blue-600 transition-colors px-2 shrink-0">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>
          </svg>
          <span class="text-xs font-semibold">Alertas</span>
        </a>

        <!-- Área do usuário: botão Google ou Avatar -->
        <div id="user-area" class="shrink-0">
          <a href="/auth/google"
             class="flex items-center gap-2 bg-white border border-gray-200 hover:border-blue-400 hover:bg-blue-50 text-gray-700 text-sm font-semibold px-3 py-2 rounded-xl transition-all whitespace-nowrap">
            <svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            <span class="hidden sm:inline">Entrar</span>
          </a>
        </div>
        <div id="user-menu" class="hidden shrink-0 relative">
          <button onclick="toggleUserMenu()" class="flex items-center gap-2 hover:bg-gray-100 rounded-xl px-2 py-1.5 transition-all">
            <img id="user-avatar" src="" class="w-8 h-8 rounded-full object-cover border-2 border-blue-200" alt="">
            <span id="user-name" class="text-sm font-semibold text-gray-700 hidden md:block max-w-[100px] truncate"></span>
            <svg class="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
          </button>
          <div id="user-dropdown" class="hidden absolute right-0 top-full mt-2 w-52 bg-white rounded-2xl shadow-xl border border-gray-100 py-2 z-50">
            <a href="/meus-alertas" class="flex items-center gap-2.5 px-4 py-2.5 text-sm text-gray-700 hover:bg-blue-50 rounded-lg mx-1">🔔 Meus Alertas</a>
            <a href="/perfil" class="flex items-center gap-2.5 px-4 py-2.5 text-sm text-gray-700 hover:bg-blue-50 rounded-lg mx-1">👤 Meu Perfil</a>
            <div class="border-t border-gray-100 my-1.5 mx-3"></div>
            <a href="/auth/logout" class="flex items-center gap-2.5 px-4 py-2.5 text-sm text-red-500 hover:bg-red-50 rounded-lg mx-1">🚪 Sair</a>
          </div>
        </div>

      </div>
    </div>

    <!-- Sub-nav de categorias -->
    <nav class="border-t border-gray-100 bg-white" id="cat-subnav">
      <div class="max-w-7xl mx-auto px-4">
        <div class="flex items-center gap-0.5 overflow-x-auto scrollbar-hide h-10">
          <a href="/categoria/smartphones"   class="subnav-link">📱 Celulares</a>
          <a href="/categoria/notebooks"     class="subnav-link">💻 Notebooks</a>
          <a href="/categoria/tv"            class="subnav-link">📺 TVs</a>
          <a href="/categoria/games"         class="subnav-link">🎮 Games</a>
          <a href="/categoria/eletrodomesticos" class="subnav-link">🏠 Eletrodomésticos</a>
          <a href="/categoria/audio"         class="subnav-link">🎧 Áudio</a>
          <a href="/categoria/cameras"       class="subnav-link">📷 Câmeras</a>
          <a href="/categoria/moda"          class="subnav-link">👗 Moda</a>
          <div class="h-5 w-px bg-gray-200 mx-1 shrink-0"></div>
          <a href="/ofertas" class="subnav-link subnav-hot">🔥 Ofertas do Dia</a>
        </div>
      </div>
    </nav>

  </header>
  `}

  <!-- MAIN -->
  <main>${content}</main>

  <!-- FOOTER -->
  <footer class="bg-gray-900 text-gray-400 mt-16 py-12">
    <div class="max-w-7xl mx-auto px-4">
      <div class="grid grid-cols-2 md:grid-cols-4 gap-8 mb-8">
        <div>
          <div class="text-white font-bold mb-3">ShoppingCompare</div>
          <p class="text-sm">Compare preços em dezenas de lojas e encontre o melhor negócio.</p>
        </div>
        <div>
          <div class="text-white font-semibold mb-3">Categorias</div>
          <ul class="space-y-2 text-sm">
            <li><a href="/categoria/smartphones" class="hover:text-white">Smartphones</a></li>
            <li><a href="/categoria/notebooks" class="hover:text-white">Notebooks</a></li>
            <li><a href="/categoria/tv" class="hover:text-white">TVs</a></li>
            <li><a href="/categoria/games" class="hover:text-white">Games</a></li>
          </ul>
        </div>
        <div>
          <div class="text-white font-semibold mb-3">Lojas Parceiras</div>
          <ul class="space-y-2 text-sm">
            <li>Amazon</li><li>Magazine Luiza</li>
            <li>Mercado Livre</li><li>Americanas</li>
          </ul>
        </div>
        <div>
          <div class="text-white font-semibold mb-3">Informações</div>
          <ul class="space-y-2 text-sm">
            <li><a href="#" class="hover:text-white">Sobre</a></li>
            <li><a href="#" class="hover:text-white">Política de Privacidade</a></li>
            <li><a href="#" class="hover:text-white">Como funciona</a></li>
          </ul>
        </div>
      </div>
      <div class="border-t border-gray-800 pt-6 text-xs text-gray-600 text-center">
        <p>Este site usa links de afiliados. Podemos receber comissão nas compras realizadas através dos nossos links, sem custo adicional para você.</p>
        <p class="mt-2">© 2025 ShoppingCompare. Todos os direitos reservados.</p>
      </div>
    </div>
  </footer>

  <script src="/static/app.js"></script>

  <!-- Modal de alerta de preço -->
  <div id="alert-modal" class="hidden fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
    <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" onclick="closeAlertModal()"></div>
    <div class="relative bg-white rounded-3xl shadow-2xl w-full max-w-md p-6">
      <button onclick="closeAlertModal()" class="absolute top-4 right-4 text-gray-400 hover:text-gray-700">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
      <div class="text-center mb-5">
        <div class="text-3xl mb-2">🔔</div>
        <h3 class="text-xl font-bold text-gray-900">Alerta de Preço Grátis</h3>
        <p class="text-sm text-gray-500 mt-1">Te avisamos por email quando o preço cair!</p>
      </div>
      <div id="alert-product-info" class="bg-gray-50 rounded-2xl p-4 mb-5 flex items-center gap-3">
        <img id="alert-product-img" src="" class="w-14 h-14 object-contain rounded-xl bg-white" alt="">
        <div>
          <div id="alert-product-name" class="font-semibold text-gray-800 text-sm leading-tight"></div>
          <div class="text-blue-600 font-bold mt-1" id="alert-current-price"></div>
        </div>
      </div>
      <div class="mb-5">
        <label class="block text-sm font-semibold text-gray-700 mb-2">Me avisar quando chegar em:</label>
        <div class="relative">
          <span class="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500 font-medium">R$</span>
          <input type="number" id="alert-price-input" placeholder="0,00" step="0.01"
            class="w-full pl-10 pr-4 py-3 rounded-xl border-2 border-gray-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none text-lg font-bold text-gray-900">
        </div>
      </div>
      <button onclick="saveAlert()" id="alert-save-btn"
        class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3.5 rounded-2xl text-base transition-colors">
        Criar Alerta Gratuito
      </button>
      <p id="alert-login-msg" class="hidden text-center text-sm text-gray-500 mt-3">
        <a href="/auth/google" class="text-blue-600 font-semibold hover:underline">Faça login com Google</a> para criar alertas gratuitos
      </p>
    </div>
  </div>

</body>
</html>`
}

export { renderProductCard, formatCurrency }
export default pages
