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

export function renderLayout(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <meta name="description" content="Compare preços em dezenas de lojas e economize. Amazon, Magalu, Mercado Livre e mais.">
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
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

  <!-- HEADER -->
  <header class="sticky top-0 z-50 bg-white shadow-sm border-b border-gray-100">
    <div class="max-w-7xl mx-auto px-4">
      <div class="flex items-center gap-4 h-16">
        <a href="/" class="flex items-center gap-2 shrink-0">
          <div class="w-8 h-8 bg-gradient-to-br from-blue-600 to-blue-800 rounded-lg flex items-center justify-center">
            <span class="text-white text-xs font-bold">S</span>
          </div>
          <span class="font-extrabold text-xl text-gray-900 tracking-tight">Shopping<span class="text-blue-600">Compare</span></span>
        </a>

        <!-- Search Bar -->
        <div class="flex-1 max-w-2xl">
          <div class="relative">
            <input type="text" id="search-input" placeholder="Buscar produtos, marcas, categorias..."
              class="w-full pl-4 pr-12 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none text-sm transition-all"
              autocomplete="off"
              onkeydown="if(event.key==='Enter') searchProducts()"
              oninput="debounceSearch(this.value)">
            <button onclick="searchProducts()" class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-blue-600 transition-colors">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
            </button>
            <!-- Suggestions dropdown -->
            <div id="suggestions" class="hidden absolute top-full left-0 right-0 mt-1 bg-white rounded-xl shadow-xl border border-gray-100 z-50 max-h-80 overflow-auto"></div>
          </div>
        </div>

        <nav class="hidden md:flex items-center gap-1">
          <a href="/categoria/smartphones" class="nav-link">📱 Celulares</a>
          <a href="/categoria/notebooks" class="nav-link">💻 Notebooks</a>
          <a href="/categoria/tv" class="nav-link">📺 TVs</a>
          <a href="/ofertas" class="nav-link font-semibold text-red-600">🔥 Ofertas</a>
        </nav>
      </div>
    </div>
  </header>

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
</body>
</html>`
}

export { renderProductCard, formatCurrency }
export default pages
