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

// ── Página de produto — COMPLETA (Feature 1+2+4) ────────────
pages.get('/produto/:slug', async (c) => {
  const { DB, CACHE } = c.env
  const slug = c.req.param('slug')
  const cache = new CacheManager(CACHE)

  // Busca produto + ofertas + histórico em paralelo
  let product: Product | null = null
  let offers: Offer[] = []
  let priceHistory: any[] = []
  let related: Product[] = []

  const cached = await cache.getProduct(slug)
  if (cached) {
    product = cached.product
    offers  = cached.offers
  } else {
    product = await DB
      .prepare(`SELECT p.*, s.name as best_store_name, s.slug as best_store_slug
                FROM products p LEFT JOIN stores s ON s.id = p.best_store_id
                WHERE p.slug = ? AND p.is_active = 1`)
      .bind(slug).first<Product>()
    if (product) {
      const { results } = await DB
        .prepare(`SELECT o.*, s.name as store_name, s.slug as store_slug, s.logo_url as store_logo
                  FROM offers o JOIN stores s ON s.id = o.store_id
                  WHERE o.product_id = ? AND o.is_active = 1 ORDER BY o.price ASC`)
        .bind(product.id).all<Offer>()
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

  // Busca histórico + relacionados em paralelo
  const [histResult, relResult] = await Promise.all([
    DB.prepare(`
      SELECT ph.price, ph.in_stock, ph.recorded_at, s.name as store_name, s.slug as store_slug
      FROM price_history ph JOIN stores s ON s.id = ph.store_id
      WHERE ph.product_id = ? AND ph.recorded_at >= date('now','-90 days')
      ORDER BY ph.recorded_at ASC LIMIT 300
    `).bind(product.id).all(),
    DB.prepare(`
      SELECT p.*, s.name as best_store_name FROM products p
      LEFT JOIN stores s ON s.id = p.best_store_id
      WHERE p.category = ? AND p.id != ? AND p.is_active = 1 AND p.best_price IS NOT NULL
      ORDER BY p.offer_count DESC LIMIT 4
    `).bind(product.category || '', product.id).all<Product>(),
  ])
  priceHistory = histResult.results as any[]
  related      = relResult.results as Product[]

  // ── DADOS CALCULADOS ────────────────────────────────────
  const specs    = product.specs ? (() => { try { return JSON.parse(product.specs!) } catch { return {} } })() : {}
  const specKeys = Object.keys(specs)
  const minPrice = offers.length ? Math.min(...offers.map(o => o.price)) : product.best_price || 0
  const maxPrice = offers.length ? Math.max(...offers.map(o => o.price)) : minPrice
  const savings  = maxPrice - minPrice
  const histMin  = priceHistory.length ? Math.min(...priceHistory.map((h:any) => h.price)) : 0
  const histMax  = priceHistory.length ? Math.max(...priceHistory.map((h:any) => h.price)) : 0
  const isAtHistMin = histMin > 0 && minPrice <= histMin * 1.02

  // ── SEO — meta tags ricas (Feature 4) ───────────────────
  const seoTitle = `${product.name} — Menor Preço ${formatCurrency(minPrice)} | ShoppingCompare`
  const seoDesc  = `Compare ${product.name} em ${offers.length} lojas. Menor preço: ${formatCurrency(minPrice)}${ offers[0]?.store_name ? ` na ${offers[0].store_name}` : '' }. ${ product.brand ? `Marca: ${product.brand}.` : '' } Economize até ${formatCurrency(savings)}.`
  const seoImg   = product.image_url || ''
  const seoUrl   = `https://shopping-compare.pages.dev/produto/${slug}`

  // Schema.org JSON-LD
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    image: seoImg,
    description: product.description || seoDesc,
    brand: product.brand ? { '@type': 'Brand', name: product.brand } : undefined,
    sku: product.ean,
    offers: offers.map(o => ({
      '@type': 'Offer',
      url: `${seoUrl}/go/${o.id}`,
      priceCurrency: 'BRL',
      price: o.price.toFixed(2),
      availability: o.in_stock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      seller: { '@type': 'Organization', name: o.store_name },
    })),
    aggregateRating: product.rating > 0 ? {
      '@type': 'AggregateRating',
      ratingValue: product.rating,
      reviewCount: product.review_count || 1,
    } : undefined,
  })

  // ── OFERTAS HTML ─────────────────────────────────────────
  const offersHTML = offers.map((o, i) => {
    const trackUrl   = `/go/${slug}/${o.id}`
    const isBest     = i === 0
    const discount   = o.discount_percent > 0 ? Math.round(o.discount_percent) : 0
    const storeAv    = o.store_logo
      ? `<img src="${o.store_logo}" alt="${o.store_name}" class="h-7 max-w-[90px] object-contain">`
      : `<span class="font-black text-sm text-gray-800">${o.store_name}</span>`
    return `
    <div class="rounded-2xl border-2 p-4 transition-all ${
      isBest ? 'border-green-400 bg-gradient-to-r from-green-50 to-emerald-50 shadow-md shadow-green-100' : 'border-gray-100 bg-white hover:border-blue-200'
    }">
      ${ isBest ? '<div class="text-xs font-black text-green-700 bg-green-100 inline-flex items-center gap-1 px-2 py-0.5 rounded-full mb-2">🏆 MELHOR PREÇO</div>' : '' }
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 bg-white rounded-xl border border-gray-100 flex items-center justify-center p-1 shadow-sm">
            ${storeAv}
          </div>
          <div>
            ${ o.original_price && o.original_price > o.price
              ? `<div class="text-xs text-gray-400 line-through">${formatCurrency(o.original_price)}</div>` : '' }
            <div class="text-2xl font-black text-gray-900">${formatCurrency(o.price)}</div>
            <div class="flex items-center gap-2 mt-0.5">
              ${ o.free_shipping ? '<span class="text-xs font-semibold text-green-600">✓ Frete grátis</span>' : '<span class="text-xs text-gray-400">Frete a consultar</span>' }
              ${ discount > 0 ? `<span class="text-xs font-bold text-red-600 bg-red-50 px-1.5 py-0.5 rounded-lg">-${discount}%</span>` : '' }
              ${ o.installments_count ? `<span class="text-xs text-gray-500">${o.installments_count}x ${formatCurrency((o.installments_value || o.price/o.installments_count))}</span>` : '' }
            </div>
          </div>
        </div>
        <a href="${trackUrl}" target="_blank" rel="noopener sponsored"
           onclick="trackClick(${o.id},${product!.id},${o.store_id})"
           class="btn-buy flex-shrink-0 ${ isBest ? 'bg-green-600 hover:bg-green-700' : '' }">
          Comprar →
        </a>
      </div>
      ${ o.seller_name ? `<div class="text-xs text-gray-400 mt-2 pl-1">Vendido por: ${o.seller_name}</div>` : '' }
    </div>`
  }).join('')

  // ── HISTÓRICO DE PREÇOS — dados para Chart.js (Feature 2) ─
  // Agrupa por dia, pega menor preço
  const histByDay: Record<string, number> = {}
  priceHistory.forEach((h: any) => {
    const day = h.recorded_at.substring(0, 10)
    if (!histByDay[day] || h.price < histByDay[day]) histByDay[day] = h.price
  })
  const histLabels = Object.keys(histByDay).sort()
  const histPrices = histLabels.map(d => histByDay[d])

  const priceChartHTML = histLabels.length > 1 ? `
    <div class="bg-white rounded-2xl shadow-sm border p-6">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-bold text-gray-800">📈 Histórico de Preços (90 dias)</h2>
        <div class="flex gap-4 text-xs">
          <span class="text-green-600 font-bold">Mín: ${formatCurrency(histMin)}</span>
          <span class="text-red-500 font-bold">Máx: ${formatCurrency(histMax)}</span>
        </div>
      </div>
      ${ isAtHistMin ? `
        <div class="bg-green-50 border border-green-200 rounded-xl px-3 py-2 mb-4 text-sm text-green-800 font-medium flex items-center gap-2">
          🎉 <strong>Preço mínimo histórico!</strong> Este é o menor preço registrado nos últimos 90 dias.
        </div>` : '' }
      <div style="position:relative;height:200px">
        <canvas id="price-chart"></canvas>
      </div>
      <script>
        (function(){
          const ctx = document.getElementById('price-chart')
          if (!ctx || !window.Chart) return
          new Chart(ctx, {
            type: 'line',
            data: {
              labels: ${JSON.stringify(histLabels.map(d => {
                const dt = new Date(d+'T12:00:00')
                return dt.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})
              }))},
              datasets: [{
                label: 'Preço',
                data: ${JSON.stringify(histPrices)},
                borderColor: '#2563eb',
                backgroundColor: 'rgba(37,99,235,0.08)',
                borderWidth: 2.5,
                pointRadius: 3,
                pointBackgroundColor: '#2563eb',
                tension: 0.35,
                fill: true,
              }]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { display: false }, tooltip: {
                callbacks: { label: ctx => 'R$ ' + ctx.parsed.y.toLocaleString('pt-BR',{minimumFractionDigits:2}) }
              }},
              scales: {
                x: { grid: { display: false }, ticks: { maxTicksLimit: 8, font: { size: 11 } } },
                y: { grid: { color: '#f1f5f9' }, ticks: {
                  font: { size: 11 },
                  callback: v => 'R$' + (v/1000).toFixed(1) + 'k'
                }}
              }
            }
          })
        })()
      </script>
    </div>
  ` : ''

  // ── ESPECIFICAÇÕES HTML ───────────────────────────────────
  const specsHTML = specKeys.length > 0 ? `
    <div class="bg-white rounded-2xl shadow-sm border p-6">
      <h2 class="text-lg font-bold text-gray-800 mb-4">📋 Especificações Técnicas</h2>
      <div class="grid grid-cols-2 gap-2">
        ${specKeys.map(k => `
          <div class="flex flex-col bg-gray-50 rounded-xl p-3">
            <span class="text-xs text-gray-500 uppercase tracking-wide mb-0.5">${k.replace(/_/g,' ')}</span>
            <span class="font-semibold text-gray-800 text-sm">${specs[k]}</span>
          </div>
        `).join('')}
      </div>
    </div>
  ` : ''

  // ── RELACIONADOS HTML ─────────────────────────────────────
  const relatedHTML = related.length > 0 ? `
    <div class="bg-white rounded-2xl shadow-sm border p-6">
      <h2 class="text-lg font-bold text-gray-800 mb-4">🔗 Produtos Relacionados</h2>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        ${related.map(r => `
          <a href="/produto/${r.slug}" class="group flex flex-col rounded-xl border border-gray-100 hover:border-blue-300 hover:shadow-md transition-all overflow-hidden bg-gray-50">
            <div class="h-28 flex items-center justify-center p-3 bg-white">
              <img src="${r.image_url || ''}" alt="${r.name}" class="max-h-full object-contain group-hover:scale-105 transition-transform">
            </div>
            <div class="p-2.5">
              <div class="text-xs text-gray-700 font-medium leading-tight line-clamp-2">${r.name}</div>
              <div class="text-sm font-black text-blue-700 mt-1">${r.best_price ? formatCurrency(r.best_price) : '—'}</div>
            </div>
          </a>
        `).join('')}
      </div>
    </div>
  ` : ''

  // ── ALERTA DE PREÇO CTA ───────────────────────────────────
  const alertCtaHTML = `
    <div class="bg-gradient-to-r from-blue-600 to-indigo-600 rounded-2xl p-5 text-white">
      <div class="flex items-center gap-4">
        <div class="text-4xl flex-shrink-0">🔔</div>
        <div class="flex-1">
          <div class="font-black text-lg leading-tight">Quer pagar menos?</div>
          <div class="text-blue-100 text-sm mt-0.5">Te avisamos por email quando o preço cair abaixo do seu alvo.</div>
        </div>
        <button onclick="openAlertModal('${product!.id}','${product!.name.replace(/'/g,'').substring(0,50)}','${product!.image_url||''}','${formatCurrency(minPrice)}')"
          class="flex-shrink-0 bg-white text-blue-700 font-black text-sm px-4 py-2.5 rounded-xl hover:bg-yellow-300 hover:text-blue-900 transition-colors shadow-lg whitespace-nowrap">
          Criar Alerta Grátis
        </button>
      </div>
    </div>
  `

  // ── CONTEÚDO FINAL ────────────────────────────────────────
  const content = `
    <div class="max-w-6xl mx-auto px-4 py-6">

      <!-- Breadcrumb -->
      <nav class="text-xs text-gray-400 mb-5 flex items-center gap-1.5 flex-wrap">
        <a href="/" class="hover:text-blue-600">Início</a>
        <span>/</span>
        <a href="/categoria/${product.category}" class="hover:text-blue-600 capitalize">${product.category || 'Produtos'}</a>
        <span>/</span>
        <span class="text-gray-600 font-medium truncate max-w-[200px]">${product.name}</span>
      </nav>

      <div class="grid grid-cols-1 lg:grid-cols-[400px_1fr] gap-6">

        <!-- COL ESQUERDA: Imagem sticky -->
        <div class="space-y-4">
          <div class="sticky top-4 space-y-4">
            <!-- Imagem -->
            <div class="bg-white rounded-2xl shadow-sm border p-6 flex items-center justify-center min-h-[320px]">
              <img src="${product.image_url || ''}" alt="${product.name}"
                   class="max-h-72 max-w-full object-contain mx-auto"
>
            </div>
            <!-- Info rápida -->
            <div class="bg-white rounded-2xl shadow-sm border p-4 space-y-2 text-sm">
              ${ product.brand ? `<div class="flex justify-between"><span class="text-gray-500">Marca</span><span class="font-semibold">${product.brand}</span></div>` : '' }
              ${ product.ean ? `<div class="flex justify-between"><span class="text-gray-500">EAN / GTIN</span><code class="text-xs bg-gray-100 px-2 py-0.5 rounded">${product.ean}</code></div>` : '' }
              <div class="flex justify-between"><span class="text-gray-500">Lojas</span><span class="font-semibold text-blue-600">${offers.length} comparando</span></div>
              ${ offers.length > 1 ? `<div class="flex justify-between"><span class="text-gray-500">Economia</span><span class="font-bold text-green-600">${formatCurrency(savings)}</span></div>` : '' }
              ${ histMin > 0 ? `<div class="flex justify-between"><span class="text-gray-500">Mín. histórico</span><span class="font-bold ${ isAtHistMin ? 'text-green-600' : 'text-gray-700'}">${formatCurrency(histMin)}</span></div>` : '' }
            </div>
            <!-- Alerta CTA -->
            ${alertCtaHTML}
          </div>
        </div>

        <!-- COL DIREITA: Detalhes -->
        <div class="space-y-5">

          <!-- Título + Badge histórico -->
          <div>
            ${ product.brand ? `<span class="text-xs font-black text-blue-600 uppercase tracking-widest">${product.brand}</span>` : '' }
            <h1 class="text-xl md:text-2xl font-black text-gray-900 mt-1 leading-tight">${product.name}</h1>
            ${ isAtHistMin ? `<div class="inline-flex items-center gap-1.5 mt-2 bg-green-50 border border-green-200 text-green-800 text-xs font-bold px-3 py-1 rounded-full">🎉 Menor preço dos últimos 90 dias!</div>` : '' }
          </div>

          <!-- Preço resumo -->
          ${ offers.length > 1 ? `
          <div class="bg-gray-50 rounded-2xl p-4 border border-gray-100">
            <div class="text-xs text-gray-500 mb-1">Faixa de preços encontrada</div>
            <div class="flex items-center gap-3">
              <div class="text-2xl font-black text-green-700">${formatCurrency(minPrice)}</div>
              <div class="text-gray-400 text-sm">até</div>
              <div class="text-xl font-bold text-gray-500">${formatCurrency(maxPrice)}</div>
            </div>
            <div class="w-full bg-gray-200 rounded-full h-1.5 mt-2">
              <div class="bg-green-500 h-1.5 rounded-full" style="width:30%"></div>
            </div>
          </div>` : '' }

          <!-- Ofertas por loja -->
          <div>
            <h2 class="text-base font-black text-gray-800 mb-3">🏪 Compare nas lojas</h2>
            <div class="space-y-3">${offersHTML || '<div class="text-center py-8 text-gray-400">Sem ofertas disponíveis no momento.</div>'}</div>
          </div>

          <!-- Descrição -->
          ${ product.description ? `
          <div class="bg-blue-50 rounded-2xl p-5 border border-blue-100">
            <h2 class="text-sm font-bold text-blue-800 mb-2">ℹ️ Sobre o produto</h2>
            <p class="text-sm text-gray-700 leading-relaxed">${product.description}</p>
          </div>` : '' }

        </div>
      </div>

      <!-- Seção abaixo (largura total) -->
      <div class="space-y-6 mt-6">
        ${priceChartHTML}
        ${specsHTML}
        ${relatedHTML}
      </div>

    </div>

    <!-- Chart.js para o histórico -->
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  `

  // SEO extra: injeta meta tags OG + JSON-LD via opts
  return c.html(renderLayout(seoTitle, content, {
    description: seoDesc,
    ogImage: seoImg,
    canonical: seoUrl,
    jsonLd,
  }))
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

export function renderLayout(title: string, content: string, opts: { hideHeader?: boolean; description?: string; ogImage?: string; canonical?: string; jsonLd?: string } = {}): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <meta name="description" content="${opts.description || 'Compare preços em dezenas de lojas e economize. Amazon, Magalu, Mercado Livre e mais.'}">
  ${opts.canonical ? `<link rel="canonical" href="${opts.canonical}">` : ''}
  <!-- Open Graph -->
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${opts.description || 'Compare preços e economize no ShoppingCompare.'}">
  <meta property="og:type" content="product">
  <meta property="og:site_name" content="ShoppingCompare">
  ${opts.ogImage ? `<meta property="og:image" content="${opts.ogImage}">` : ''}
  ${opts.canonical ? `<meta property="og:url" content="${opts.canonical}">` : ''}
  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${opts.description || ''}">
  ${opts.ogImage ? `<meta name="twitter:image" content="${opts.ogImage}">` : ''}
  <!-- PWA -->
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#2563eb">
  <link rel="apple-touch-icon" href="/static/icon-192.svg">
  ${opts.jsonLd ? `<script type="application/ld+json">${opts.jsonLd}</script>` : ''}
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
  <!-- ═══════════════════════════════════════════════════════
       DRAWER MENU MOBILE (Hambúrguer)
  ═══════════════════════════════════════════════════════ -->

  <!-- Overlay escuro -->
  <div id="mob-overlay" onclick="closeHamburger()"
    class="fixed inset-0 bg-black/60 backdrop-blur-sm z-[90] hidden"
    aria-hidden="true"></div>

  <!-- Drawer lateral esquerdo -->
  <aside id="mob-drawer"
    class="fixed top-0 left-0 h-full w-[300px] max-w-[85vw] bg-white z-[100]
           flex flex-col shadow-2xl
           mob-drawer-closed"
    aria-label="Menu principal" role="dialog" aria-modal="true">

    <!-- Cabeçalho do drawer -->
    <div class="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-gradient-to-r from-blue-600 to-blue-700 shrink-0">
      <a href="/" onclick="closeHamburger()" class="flex items-center gap-2">
        <div class="w-8 h-8 bg-white/20 rounded-xl flex items-center justify-center">
          <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
          </svg>
        </div>
        <div class="leading-none">
          <span class="font-black text-white text-base tracking-tight">Shopping</span><span class="font-black text-yellow-300 text-base tracking-tight">Compare</span>
        </div>
      </a>
      <button onclick="closeHamburger()" aria-label="Fechar menu"
        class="w-8 h-8 flex items-center justify-center rounded-full text-white/70 hover:text-white hover:bg-white/15 transition-colors">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    </div>

    <!-- Busca rápida dentro do drawer -->
    <div class="px-4 py-3 border-b border-gray-100 shrink-0">
      <div class="relative">
        <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
        </svg>
        <input type="text" id="mob-search-input"
          placeholder="Buscar produto..."
          class="w-full pl-9 pr-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
          autocomplete="off"
          onkeydown="if(event.key==='Enter'){ document.getElementById('search-input').value=this.value; closeHamburger(); searchProducts(); }"
          oninput="document.getElementById('search-input').value=this.value; debounceSearch(this.value)">
      </div>
    </div>

    <!-- Conteúdo rolável -->
    <div class="flex-1 overflow-y-auto overscroll-contain py-2">

      <!-- Categorias -->
      <div class="px-3 pt-2 pb-1">
        <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest px-3 mb-2">Categorias</p>
        <nav class="space-y-0.5">
          <a href="/categoria/smartphones" onclick="closeHamburger()" class="mob-menu-link">
            <span class="mob-menu-icon">📱</span> Celulares
          </a>
          <a href="/categoria/notebooks" onclick="closeHamburger()" class="mob-menu-link">
            <span class="mob-menu-icon">💻</span> Notebooks
          </a>
          <a href="/categoria/tv" onclick="closeHamburger()" class="mob-menu-link">
            <span class="mob-menu-icon">📺</span> TVs
          </a>
          <a href="/categoria/games" onclick="closeHamburger()" class="mob-menu-link">
            <span class="mob-menu-icon">🎮</span> Games
          </a>
          <a href="/categoria/eletrodomesticos" onclick="closeHamburger()" class="mob-menu-link">
            <span class="mob-menu-icon">🏠</span> Eletrodomésticos
          </a>
          <a href="/categoria/audio" onclick="closeHamburger()" class="mob-menu-link">
            <span class="mob-menu-icon">🎧</span> Áudio
          </a>
          <a href="/categoria/cameras" onclick="closeHamburger()" class="mob-menu-link">
            <span class="mob-menu-icon">📷</span> Câmeras
          </a>
          <a href="/categoria/moda" onclick="closeHamburger()" class="mob-menu-link">
            <span class="mob-menu-icon">👗</span> Moda
          </a>
        </nav>
      </div>

      <!-- Divisor -->
      <div class="h-px bg-gray-100 mx-4 my-3"></div>

      <!-- Links rápidos -->
      <div class="px-3 pb-1">
        <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest px-3 mb-2">Links Rápidos</p>
        <nav class="space-y-0.5">
          <a href="/ofertas" onclick="closeHamburger()" class="mob-menu-link mob-menu-link-hot">
            <span class="mob-menu-icon">🔥</span> Ofertas do Dia
            <span class="ml-auto text-[10px] bg-red-100 text-red-600 font-bold px-2 py-0.5 rounded-full">HOT</span>
          </a>
          <a href="/meus-alertas" onclick="closeHamburger()" class="mob-menu-link">
            <span class="mob-menu-icon">🔔</span> Meus Alertas
          </a>
        </nav>
      </div>

      <!-- Divisor -->
      <div class="h-px bg-gray-100 mx-4 my-3"></div>

      <!-- Lojas parceiras -->
      <div class="px-3 pb-2">
        <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest px-3 mb-3">Lojas Parceiras</p>
        <div class="grid grid-cols-4 gap-2 px-1">
          ${[
            { name:'Amazon',    color:'#FF9900', initial:'A' },
            { name:'Magalu',    color:'#0086FF', initial:'M' },
            { name:'Mercado',   color:'#FFE600', initial:'ML' },
            { name:'Americana', color:'#E60014', initial:'Am' },
            { name:'C.Bahia',   color:'#0057A8', initial:'CB' },
            { name:'Kabum',     color:'#F47920', initial:'K' },
            { name:'FastShop',  color:'#00843D', initial:'FS' },
            { name:'Ponto Frio',color:'#00AAFF', initial:'PF' },
          ].map(s => `
            <a href="/categoria/smartphones?loja=${s.name.toLowerCase().replace(/[^a-z]/g,'')}" onclick="closeHamburger()" class="flex flex-col items-center gap-1 p-1 rounded-xl hover:bg-gray-50 transition-colors">
              <div class="w-10 h-10 rounded-xl flex items-center justify-center" style="background:${s.color}">
                <span class="font-black text-xs text-white leading-none">${s.initial}</span>
              </div>
              <span class="text-[10px] text-gray-600 font-medium text-center leading-tight">${s.name}</span>
            </a>
          `).join('')}
        </div>
      </div>

    </div><!-- fim overflow-y-auto -->

    <!-- Rodapé do drawer: login -->
    <div class="shrink-0 border-t border-gray-100 p-4">
      <div id="mob-user-area">
        <a href="/auth/google" onclick="closeHamburger()"
           class="flex items-center justify-center gap-2 w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-2xl transition-colors text-sm">
          <svg class="w-4 h-4" viewBox="0 0 24 24">
            <path fill="white" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="white" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" opacity=".7"/>
            <path fill="white" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" opacity=".5"/>
            <path fill="white" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" opacity=".3"/>
          </svg>
          Entrar com Google
        </a>
      </div>
      <div id="mob-user-logged" class="hidden">
        <div class="flex items-center gap-3 mb-3">
          <img id="mob-avatar" src="" class="w-10 h-10 rounded-full border-2 border-blue-200" alt="">
          <div>
            <div id="mob-user-name" class="text-sm font-bold text-gray-800"></div>
            <div class="text-xs text-gray-400">Conta conectada</div>
          </div>
        </div>
        <a href="/auth/logout" onclick="closeHamburger()" class="flex items-center justify-center gap-2 w-full border border-red-200 text-red-500 hover:bg-red-50 font-semibold py-2.5 rounded-2xl transition-colors text-sm">
          🚪 Sair
        </a>
      </div>
    </div>

  </aside>

  <!-- HEADER PRINCIPAL -->
  <header class="sticky top-0 z-50 bg-white border-b border-gray-100" id="main-header">

    <!-- Barra superior: hambúrguer + logo + busca + usuário -->
    <div class="max-w-7xl mx-auto px-3 md:px-4">
      <div class="flex items-center gap-2 md:gap-3 h-[60px]">

        <!-- Botão Hambúrguer (só mobile) -->
        <button id="hamburger-btn" onclick="openHamburger()" aria-label="Abrir menu"
          class="md:hidden flex-shrink-0 w-10 h-10 flex flex-col items-center justify-center gap-[5px] rounded-xl hover:bg-gray-100 active:bg-gray-200 transition-colors">
          <span class="ham-bar"></span>
          <span class="ham-bar"></span>
          <span class="ham-bar"></span>
        </button>

        <!-- Logo -->
        <a href="/" class="flex items-center gap-2 shrink-0">
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

        <!-- Alertas (ícone) — só desktop -->
        <a href="/meus-alertas" title="Meus Alertas"
           class="hidden md:flex items-center gap-1.5 text-gray-500 hover:text-blue-600 transition-colors px-2 shrink-0">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>
          </svg>
          <span class="text-xs font-semibold">Alertas</span>
        </a>

        <!-- Área do usuário: só desktop -->
        <div id="user-area" class="hidden md:block shrink-0">
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
            <svg class="w-3.5 h-3.5 text-gray-400 hidden md:block" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
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

    <!-- Sub-nav de categorias (só desktop) -->
    <nav class="border-t border-gray-100 bg-white hidden md:block" id="cat-subnav">
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

  <!-- PWA: Service Worker -->
  <script>
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/static/sw.js')
          .then(reg => console.log('[SW] Registrado:', reg.scope))
          .catch(err => console.warn('[SW] Falha:', err))
      })
    }
  </script>

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
      <!-- Campos do modal de alerta -->
      <input type="hidden" id="alert-product-id" value="">
      <div class="mt-4">
        <label class="block text-sm font-semibold text-gray-700 mb-1">Seu email:</label>
        <input type="email" id="alert-email-input" placeholder="seu@email.com"
          class="w-full px-4 py-3 rounded-xl border-2 border-gray-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none text-sm text-gray-900">
      </div>
    </div>
  </div>

</body>
</html>`
}

// ── Página: Meus Alertas ──────────────────────────────────
pages.get('/meus-alertas', async (c) => {
  const email = c.req.query('email') || ''

  const content = `
  <div class="max-w-3xl mx-auto px-4 py-10">
    <div class="flex items-center gap-3 mb-8">
      <div class="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center">
        <i class="fas fa-bell text-white"></i>
      </div>
      <div>
        <h1 class="text-2xl font-bold text-gray-900">Meus Alertas de Preço</h1>
        <p class="text-sm text-gray-500">Receba emails quando o preço cair no seu alvo</p>
      </div>
    </div>

    <!-- Busca por email -->
    <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-6">
      <label class="block text-sm font-semibold text-gray-700 mb-2">Buscar alertas pelo seu email:</label>
      <div class="flex gap-3">
        <input type="email" id="search-email" value="${email}"
          placeholder="seu@email.com"
          class="flex-1 px-4 py-3 rounded-xl border-2 border-gray-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none text-sm">
        <button onclick="loadAlerts()"
          class="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-6 py-3 rounded-xl transition-colors">
          <i class="fas fa-search mr-2"></i>Buscar
        </button>
      </div>
    </div>

    <!-- Lista de alertas -->
    <div id="alerts-list">
      ${email ? '<div class="text-center py-8"><div class="animate-spin text-blue-600 text-3xl mb-3">⏳</div><p class="text-gray-500">Carregando alertas...</p></div>' : '<div class="text-center py-12 text-gray-400"><div class="text-5xl mb-4">🔔</div><p class="text-lg font-medium">Digite seu email para ver seus alertas</p></div>'}
    </div>
  </div>

  <script>
    const initEmail = ${JSON.stringify(email)};
    if (initEmail) { setTimeout(loadAlerts, 100); }

    async function loadAlerts() {
      const email = document.getElementById('search-email').value.trim();
      if (!email) return;
      const list = document.getElementById('alerts-list');
      list.innerHTML = '<div class="text-center py-8 text-gray-400"><div class="text-3xl mb-3">⏳</div><p>Carregando...</p></div>';

      try {
        const res = await fetch('/api/price-alerts?email=' + encodeURIComponent(email));
        const alerts = await res.json();

        if (!Array.isArray(alerts) || alerts.length === 0) {
          list.innerHTML = '<div class="text-center py-12"><div class="text-5xl mb-4">📭</div><p class="text-lg font-medium text-gray-500">Nenhum alerta encontrado para este email</p><p class="text-sm text-gray-400 mt-2">Crie alertas nas páginas de produtos!</p></div>';
          return;
        }

        list.innerHTML = alerts.map(a => {
          const saving = a.target_price - (a.current_price || a.target_price);
          const triggered = a.current_price && a.current_price <= a.target_price;
          return \`<div class="bg-white rounded-2xl shadow-sm border \${triggered ? 'border-green-300 ring-2 ring-green-100' : 'border-gray-100'} p-5 mb-4 flex items-center gap-4">
            <div class="relative flex-shrink-0">
              <img src="\${a.product_image || '/static/placeholder.svg'}" class="w-16 h-16 object-contain rounded-xl bg-gray-50">
              \${triggered ? '<div class="absolute -top-1 -right-1 w-5 h-5 bg-green-500 rounded-full flex items-center justify-center"><i class=\'fas fa-check text-white text-xs\'></i></div>' : ''}
            </div>
            <div class="flex-1 min-w-0">
              <a href="/produto/\${a.product_slug}" class="font-semibold text-gray-900 hover:text-blue-600 line-clamp-1 block">\${a.product_name}</a>
              <div class="flex items-center gap-3 mt-1">
                <span class="text-sm text-gray-500">Alvo: <strong class="text-gray-900">R$ \${Number(a.target_price).toFixed(2)}</strong></span>
                \${a.current_price ? \`<span class="text-sm \${triggered ? 'text-green-600 font-bold' : 'text-gray-500'}">Atual: R$ \${Number(a.current_price).toFixed(2)}</span>\` : ''}
              </div>
              \${triggered ? '<div class="mt-1 text-xs font-semibold text-green-600 bg-green-50 px-2 py-0.5 rounded-full inline-block">✅ Alvo atingido!</div>' : ''}
            </div>
            <button onclick="deleteAlert(\${a.id}, this)" class="flex-shrink-0 w-8 h-8 flex items-center justify-center text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors" title="Remover alerta">
              <i class="fas fa-trash text-sm"></i>
            </button>
          </div>\`
        }).join('');
      } catch(e) {
        list.innerHTML = '<div class="text-center py-8 text-red-400"><p>Erro ao carregar alertas. Tente novamente.</p></div>';
      }
    }

    async function deleteAlert(id, btn) {
      if (!confirm('Remover este alerta?')) return;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin text-sm"></i>';
      await fetch('/api/price-alerts/' + id, { method: 'DELETE' });
      btn.closest('div.bg-white').remove();
    }
  </script>`

  return c.html(renderLayout('Meus Alertas de Preço', content, {
    description: 'Gerencie seus alertas de preço. Receba emails quando o produto baixar de preço.',
  }))
})

export { renderProductCard, formatCurrency }
export default pages
