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
import pages, { renderLayout, renderProductCard, formatCurrency, loadFooterConfig } from './routes/pages'
import editorial from './routes/editorial'
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

// ── Editorial AI Routes ───────────────────────────────────
app.route('/api/editorial', editorial)

// ── Page Routes ───────────────────────────────────────────
app.route('/', pages)

// ── Homepage ─────────────────────────────────────────────
app.get('/', async (c) => {
  const { DB, CACHE } = c.env
  const cache = new CacheManager(CACHE)

  // Paleta de cores por slug — fallback visual para lojas sem cor cadastrada
  const STORE_VISUAL: Record<string, { color: string; bg: string; text: string }> = {
    'amazon':           { color: '#FF9900', bg: '#fff8ee', text: 'Até 40% OFF'   },
    'magalu':           { color: '#0086FF', bg: '#eef5ff', text: 'Frete Grátis'  },
    'mercadolivre':     { color: '#FFE600', bg: '#fffde6', text: 'Menor Preço'   },
    'americanas':       { color: '#E60014', bg: '#fff0f1', text: 'Cupons'        },
    'casasbahia':       { color: '#0057A8', bg: '#eef3ff', text: '12x sem juros' },
    'kabum':            { color: '#F47920', bg: '#fff5ee', text: 'Tech & Games'  },
    'fastshop':         { color: '#00843D', bg: '#eefff5', text: 'Premium'       },
    'pontofrio':        { color: '#00AAFF', bg: '#eef8ff', text: 'Parcelas'      },
    'shopee':           { color: '#EE4D2D', bg: '#fff3f0', text: 'Super Oferta'  },
    'aliexpress':       { color: '#FF6600', bg: '#fff4ee', text: 'Importado'     },
    'shein':            { color: '#000000', bg: '#f5f5f5', text: 'Moda'          },
    'netshoes':         { color: '#003DA5', bg: '#eef3ff', text: 'Esportes'      },
    'dafiti':           { color: '#5C068C', bg: '#f8f0ff', text: 'Moda'          },
    'riachuelo':        { color: '#E30613', bg: '#fff0f1', text: 'Moda'          },
    'renner':           { color: '#E30613', bg: '#fff0f1', text: 'Moda'          },
    'centauro':         { color: '#FF6B00', bg: '#fff4ee', text: 'Esportes'      },
    'submarino':        { color: '#0057A8', bg: '#eef3ff', text: 'Eletrônicos'   },
    'leroy':            { color: '#00843D', bg: '#eefff5', text: 'Casa'          },
    'madeiramadeira':   { color: '#00833E', bg: '#eefff5', text: 'Móveis'        },
    'temu':             { color: '#FF6600', bg: '#fff4ee', text: 'Importado'     },
    'carrefour':        { color: '#0066CC', bg: '#eef3ff', text: 'Supermercado'  },
    'extra':            { color: '#E30613', bg: '#fff0f1', text: 'Eletro'        },
    'walmart':          { color: '#0071CE', bg: '#eef5ff', text: 'Varejo'        },
    'havan':            { color: '#0057A8', bg: '#eef3ff', text: 'Variedades'    },
    'tok&stok':         { color: '#E63329', bg: '#fff0f1', text: 'Decoração'     },
    'tokstok':          { color: '#E63329', bg: '#fff0f1', text: 'Decoração'     },
    'whirlpool':        { color: '#003DA5', bg: '#eef3ff', text: 'Eletro'        },
    'nike':             { color: '#000000', bg: '#f5f5f5', text: 'Esportes'      },
    'adidas':           { color: '#000000', bg: '#f5f5f5', text: 'Esportes'      },
    'samsung':          { color: '#1428A0', bg: '#eef3ff', text: 'Eletrônicos'   },
    'apple':            { color: '#555555', bg: '#f5f5f5', text: 'Apple Store'   },
  }

  // Paleta de cores genérica por índice (para lojas sem mapeamento)
  const COLOR_PALETTE = [
    { color: '#6366F1', bg: '#eef0ff' },
    { color: '#EC4899', bg: '#fef0f7' },
    { color: '#14B8A6', bg: '#edfafa' },
    { color: '#F59E0B', bg: '#fffbeb' },
    { color: '#10B981', bg: '#ecfdf5' },
    { color: '#3B82F6', bg: '#eff6ff' },
    { color: '#8B5CF6', bg: '#f5f3ff' },
    { color: '#EF4444', bg: '#fef2f2' },
    { color: '#06B6D4', bg: '#ecfeff' },
    { color: '#84CC16', bg: '#f7fee7' },
  ]

  // Busca dados em paralelo (inclui editorial da IA e footer config)
  const [featuredResult, dealsResult, categoriesResult, storesResult, editorialResult, footerCfg] = await Promise.all([
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
    DB.prepare(`SELECT id, name, slug, logo_url FROM stores WHERE is_active = 1 ORDER BY name ASC LIMIT 100`).all(),
    // Destaques gerados pela IA editorial (tabela ai_editorial)
    DB.prepare(`SELECT * FROM ai_editorial ORDER BY priority DESC LIMIT 10`).all().catch(() => ({ results: [] })),
    // Footer dinâmico do D1
    loadFooterConfig(DB),
  ])

  const featured    = featuredResult.results   as any[]
  const deals       = dealsResult.results      as any[]
  const categories  = categoriesResult.results as any[]
  const dbStores    = storesResult.results     as any[]
  const editorials  = editorialResult.results  as any[]

  // Auto-refresh: se editorial expirou ou não existe, regenera em background (waitUntil)
  // Isso faz o sistema ser autônomo — sem cron externo, sem API externa
  const editorialExpired = editorials.length === 0 ||
    (editorials[0]?.valid_until && new Date(editorials[0].valid_until) < new Date())
  if (editorialExpired) {
    // Dispara regeneração em background via fetch interno (não bloqueia a resposta ao usuário)
    const host = c.req.header('host') || 'localhost:3000'
    const proto = host.includes('localhost') ? 'http' : 'https'
    c.executionCtx.waitUntil(
      fetch(`${proto}://${host}/api/editorial/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }).catch(() => {/* silencioso */})
    )
  }

  // Extrai slots editoriais por nome
  const eBannerMain = editorials.find((e: any) => e.slot === 'banner_main')
  const eBannerSec1 = editorials.find((e: any) => e.slot === 'banner_sec1')
  const eBannerSec2 = editorials.find((e: any) => e.slot === 'banner_sec2')
  const eInsights   = editorials.filter((e: any) => e.type === 'insight')

  // Monta lista de lojas com dados visuais reais do banco + fallbacks
  const stores = dbStores.map((s: any, idx: number) => {
    const visual = STORE_VISUAL[s.slug] || COLOR_PALETTE[idx % COLOR_PALETTE.length]
    const color  = visual.color
    const bg     = visual.bg
    const text   = (STORE_VISUAL[s.slug] as any)?.text || 'Confira'
    // Abreviação: até 2 letras do nome
    const words  = (s.name as string).split(/\s+/)
    const initial = words.length >= 2
      ? (words[0][0] + words[1][0]).toUpperCase()
      : (s.name as string).substring(0, 2).toUpperCase()
    return { ...s, color, bg, text, initial }
  })

  // ── HERO ─────────────────────────────────────────────────
  const heroHTML = `
    <section class="hero-section">
      <div class="hero-orb hero-orb-1"></div>
      <div class="hero-orb hero-orb-2"></div>
      <div class="hero-orb hero-orb-3"></div>

      <div class="w-full px-6 md:px-12 lg:px-20 py-8 relative z-10 text-center">

        <!-- Eyebrow label -->
        <div class="flex justify-center mb-4">
          <span class="hero-eyebrow">
            <span class="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse inline-block mr-1.5"></span>
            33 lojas &nbsp;·&nbsp; Atualizado 24/7 &nbsp;·&nbsp; 100% gratuito
          </span>
        </div>

        <!-- Título principal -->
        <h1 class="text-3xl md:text-4xl lg:text-5xl font-black text-white leading-tight tracking-tight mb-3 whitespace-nowrap">
          O menor preço está <span class="hero-gradient-text">aqui. Sempre.</span>
        </h1>

        <!-- Subtítulo limpo -->
        <p class="text-blue-200/70 text-sm md:text-base leading-relaxed mb-6 whitespace-nowrap">
          Compare preços em tempo real nas maiores lojas do Brasil e compre sempre na melhor oferta.
        </p>

        <!-- Barra de busca centralizada — o CTA principal -->
        <div class="hero-search-wrap hero-search-full">
          <svg class="hero-search-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
          </svg>
          <input type="text" id="hero-search"
            placeholder="iPhone 15, Galaxy S24, PlayStation 5…"
            class="hero-search-input"
            autocomplete="off"
            onkeydown="if(event.key==='Enter'){ document.getElementById('search-input').value=this.value; searchProducts(); }"
            oninput="document.getElementById('search-input').value=this.value; debounceSearch(this.value)">
          <button
            onclick="document.getElementById('search-input').value=document.getElementById('hero-search').value; searchProducts();"
            class="hero-search-btn">
            Buscar
          </button>
        </div>

        <!-- Sugestões populares -->
        <div class="flex flex-nowrap justify-center items-center gap-2 mt-4 overflow-x-auto scrollbar-hide">
          <span class="text-blue-300/50 text-xs font-medium whitespace-nowrap flex-shrink-0">Populares:</span>
          ${['iPhone 15', 'Galaxy S24', 'PS5', 'Notebook', 'AirPods', 'Smart TV'].map(t =>
            `<button onclick="quickSearch('${t}')" class="quick-tag">${t}</button>`
          ).join('')}
        </div>

      </div>
    </section>
  `

  // ── FAIXA DE LOJAS PARCEIRAS ──────────────────────────────
  // Duplica o array para criar loop contínuo no marquee
  const storeCards = (arr: typeof stores) => arr.map(s => `
    <a href="/busca?q=${encodeURIComponent(s.name)}"
       class="store-pill-card flex-shrink-0 flex flex-col items-center gap-1.5 w-20 cursor-pointer group"
       title="Comparar preços na ${s.name}">
      <div class="store-logo-circle w-12 h-12 rounded-2xl flex items-center justify-center border-2 shadow-sm transition-all duration-200 group-hover:scale-110 group-hover:shadow-md"
           style="background:${s.bg}; border-color:${s.color};">
        ${s.logo_url
          ? `<img src="${s.logo_url}" alt="${s.name}" class="w-8 h-8 object-contain rounded-lg">`
          : `<span class="font-black text-sm leading-none" style="color:${s.color}">${s.initial}</span>`
        }
      </div>
      <span class="text-xs text-gray-600 font-semibold text-center leading-tight w-full truncate group-hover:text-gray-900 transition-colors">${s.name}</span>
      <span class="text-[10px] font-bold px-1.5 py-0.5 rounded-full" style="color:${s.color}; background:${s.bg}">${s.text}</span>
    </a>
  `).join('')

  const storesHTML = `
    <section class="bg-white border-b border-gray-100 overflow-hidden">
      <div class="max-w-7xl mx-auto px-4 pt-5 pb-1">
        <div class="flex items-center justify-between mb-4">
          <div class="flex items-center gap-2.5">
            <div class="w-1 h-5 bg-gradient-to-b from-blue-500 to-blue-700 rounded-full"></div>
            <h2 class="text-base font-black text-gray-800">Lojas Parceiras</h2>
            <span class="inline-flex items-center gap-1 bg-blue-50 text-blue-600 text-xs font-bold px-2.5 py-1 rounded-full border border-blue-100">
              <span class="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse"></span>
              ${stores.length} lojas
            </span>
          </div>
          <span class="text-xs text-gray-400 hidden sm:block">Compare preços em todas as lojas de uma vez</span>
        </div>
      </div>

      <!-- Marquee linha 1 — esquerda para direita -->
      <div class="stores-marquee-wrapper relative mb-2">
        <div class="stores-marquee-fade-left"></div>
        <div class="stores-marquee-fade-right"></div>
        <div class="stores-marquee" style="animation-duration:${Math.max(30, stores.length * 1.8)}s">
          <div class="stores-marquee-track flex gap-4 px-4 py-2">
            ${storeCards(stores)}
            ${storeCards(stores)}
          </div>
        </div>
      </div>

      <!-- Marquee linha 2 — direita para esquerda (só aparece se >10 lojas) -->
      ${stores.length > 10 ? `
      <div class="stores-marquee-wrapper relative mb-4">
        <div class="stores-marquee-fade-left"></div>
        <div class="stores-marquee-fade-right"></div>
        <div class="stores-marquee stores-marquee-reverse" style="animation-duration:${Math.max(35, stores.length * 2)}s">
          <div class="stores-marquee-track flex gap-4 px-4 py-2">
            ${storeCards([...stores].reverse())}
            ${storeCards([...stores].reverse())}
          </div>
        </div>
      </div>
      ` : '<div class="mb-4"></div>'}

      <style>
        .stores-marquee-wrapper { overflow: hidden; position: relative; }
        .stores-marquee-fade-left,
        .stores-marquee-fade-right {
          position: absolute; top: 0; bottom: 0; width: 80px; z-index: 2; pointer-events: none;
        }
        .stores-marquee-fade-left  { left: 0;  background: linear-gradient(to right, white, transparent); }
        .stores-marquee-fade-right { right: 0; background: linear-gradient(to left,  white, transparent); }
        .stores-marquee {
          display: flex;
          animation: marquee-ltr linear infinite;
          will-change: transform;
        }
        .stores-marquee:hover { animation-play-state: paused; }
        .stores-marquee-reverse {
          animation-name: marquee-rtl;
        }
        .stores-marquee-track { display: flex; gap: 1rem; }
        @keyframes marquee-ltr {
          from { transform: translateX(0); }
          to   { transform: translateX(-50%); }
        }
        @keyframes marquee-rtl {
          from { transform: translateX(-50%); }
          to   { transform: translateX(0); }
        }
        .store-pill-card:hover .store-logo-circle { transform: scale(1.12); }
      </style>
    </section>
  `

  // ── BANNER DESTAQUE — dinâmico via IA editorial ────────────
  // Usa destaques gerados pelo motor /api/editorial/generate
  // Fallback para conteúdo estático se IA ainda não gerou nada

  // Fallbacks padrão (usados enquanto IA não gerou dados)
  const FB_MAIN = {
    label: '🔥 Destaque do dia', emoji: '📱',
    title: 'Smartphones\ncom o menor\npreço garantido',
    subtitle: 'Compare em todas as lojas e economize',
    search_term: 'Smartphone', category_slug: 'smartphones',
    color_from: '#1D4ED8', color_to: '#7C3AED',
  }
  const FB_SEC1 = {
    label: 'Notebooks', emoji: '💻',
    title: 'Melhores\npreços em\nnotebooks',
    search_term: 'Notebook', category_slug: 'notebooks',
    color_from: '#0F172A', color_to: '#334155',
  }
  const FB_SEC2 = {
    label: 'Smart TVs', emoji: '📺',
    title: 'Compare 4K\ne OLED\nnas melhores lojas',
    search_term: 'Smart TV', category_slug: 'tv',
    color_from: '#0F766E', color_to: '#0D9488',
  }

  const bMain = eBannerMain || FB_MAIN
  const bSec1 = eBannerSec1 || FB_SEC1
  const bSec2 = eBannerSec2 || FB_SEC2

  // Gera ação de clique: se tiver category_slug usa link, senão quickSearch
  const mainAction  = bMain.category_slug
    ? `window.location.href='/categoria/${bMain.category_slug}'`
    : `quickSearch('${(bMain.search_term || 'Ofertas').replace(/'/g, '')}')`
  const sec1Action  = bSec1.category_slug
    ? `window.location.href='/categoria/${bSec1.category_slug}'`
    : `quickSearch('${(bSec1.search_term || 'Produtos').replace(/'/g, '')}')`
  const sec2Action  = bSec2.category_slug
    ? `window.location.href='/categoria/${bSec2.category_slug}'`
    : `quickSearch('${(bSec2.search_term || 'Produtos').replace(/'/g, '')}')`

  // Título com quebras de linha → <br>
  const mainTitleHTML = (bMain.title as string).replace(/\n/g, '<br>')
  const sec1TitleHTML = (bSec1.title as string).replace(/\n/g, '<br>')
  const sec2TitleHTML = (bSec2.title as string).replace(/\n/g, '<br>')

  // Badge "IA" aparece apenas quando o editorial foi gerado automaticamente
  const iaBadge = eBannerMain
    ? `<span class="inline-flex items-center gap-1 bg-white/15 border border-white/20 text-white/70 text-[10px] font-semibold px-2 py-0.5 rounded-full ml-2">
        <span class="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse"></span>ao vivo
       </span>`
    : ''

  const bannerHTML = `
    <section class="max-w-7xl mx-auto px-4 py-6" id="editorial-banners">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">

        <!-- Banner principal — gerado pela IA editorial -->
        <div class="md:col-span-2 promo-banner group cursor-pointer relative overflow-hidden rounded-2xl p-6 md:p-8"
             style="background: linear-gradient(135deg, ${bMain.color_from} 0%, ${bMain.color_to} 100%); min-height:200px;"
             onclick="${mainAction}">
          <div class="promo-banner-orb"></div>
          <div class="relative z-10">
            <div class="flex items-center gap-1 mb-3">
              <span class="inline-block bg-yellow-400 text-yellow-900 text-xs font-black px-3 py-1 rounded-full uppercase tracking-wide">
                ${bMain.label || '🔥 Destaque do dia'}
              </span>
              ${iaBadge}
            </div>
            <h3 class="text-2xl md:text-3xl font-black text-white mb-2 leading-tight">
              ${mainTitleHTML}
            </h3>
            <p class="text-white/70 text-sm mb-4">${bMain.subtitle || 'Compare nas melhores lojas'}</p>
            <span class="inline-flex items-center gap-2 bg-white/90 text-blue-700 font-bold text-sm px-4 py-2 rounded-xl group-hover:bg-yellow-400 group-hover:text-yellow-900 transition-colors">
              Ver ${bMain.stat_value ? bMain.stat_value + ' →' : 'comparativos →'}
            </span>
          </div>
          <div class="absolute right-4 bottom-0 text-8xl opacity-20 select-none pointer-events-none">${bMain.emoji || '🛍️'}</div>
        </div>

        <!-- Banners secundários — também gerados pela IA -->
        <div class="flex flex-col gap-4">
          <div class="promo-banner group cursor-pointer flex-1 relative overflow-hidden rounded-2xl p-5"
               style="background: linear-gradient(135deg, ${bSec1.color_from} 0%, ${bSec1.color_to} 100%); min-height:90px;"
               onclick="${sec1Action}">
            <div class="relative z-10">
              <span class="text-xs font-bold text-white/60 uppercase tracking-wide">${bSec1.label || 'Categoria'}</span>
              <h4 class="text-lg font-black text-white mt-1 leading-tight">${sec1TitleHTML}</h4>
              ${bSec1.stat_value ? `<p class="text-white/50 text-xs mt-1">${bSec1.stat_value}</p>` : ''}
            </div>
            <div class="absolute right-3 bottom-2 text-5xl opacity-20 select-none pointer-events-none">${bSec1.emoji || '💡'}</div>
          </div>
          <div class="promo-banner group cursor-pointer flex-1 relative overflow-hidden rounded-2xl p-5"
               style="background: linear-gradient(135deg, ${bSec2.color_from} 0%, ${bSec2.color_to} 100%); min-height:90px;"
               onclick="${sec2Action}">
            <div class="relative z-10">
              <span class="text-xs font-bold text-white/60 uppercase tracking-wide">${bSec2.label || 'Categoria'}</span>
              <h4 class="text-lg font-black text-white mt-1 leading-tight">${sec2TitleHTML}</h4>
              ${bSec2.stat_value ? `<p class="text-white/50 text-xs mt-1">${bSec2.stat_value}</p>` : ''}
            </div>
            <div class="absolute right-3 bottom-2 text-5xl opacity-20 select-none pointer-events-none">${bSec2.emoji || '⚡'}</div>
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
        <h2 class="text-2xl font-black text-white mb-2">Como o KainowRadar funciona</h2>
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

  // ── INSIGHTS DA IA (ticker/rodapé da seção de banners) ────
  // Busca também da tabela ai_insights
  let insightRows: any[] = []
  try {
    const ir = await DB.prepare(`SELECT * FROM ai_insights ORDER BY generated_at DESC LIMIT 4`).all()
    insightRows = ir.results as any[]
  } catch { /* tabela ainda não existe — ignora */ }

  const insightsHTML = insightRows.length > 0 ? `
    <div class="max-w-7xl mx-auto px-4 pb-2">
      <div class="bg-slate-900 rounded-2xl px-5 py-3 flex items-center gap-3 overflow-hidden">
        <span class="flex-shrink-0 inline-flex items-center gap-1.5 bg-green-500/20 text-green-400 text-xs font-bold px-2.5 py-1 rounded-full border border-green-500/30">
          <span class="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse"></span>
          Radar IA
        </span>
        <div class="overflow-hidden flex-1 min-w-0">
          <div class="flex gap-8 animate-[marquee_28s_linear_infinite] whitespace-nowrap w-max">
            ${[...insightRows, ...insightRows].map((ins: any) => `
              <span class="text-slate-300 text-sm">${ins.insight_text}</span>
            `).join('<span class="text-slate-600 px-3">·</span>')}
          </div>
        </div>
      </div>
    </div>
  ` : ''

  const content = heroHTML + storesHTML + bannerHTML + insightsHTML + searchResultsHTML + dealsHTML + catBlocksHTML + featuredHTML + howHTML

  return c.html(renderLayout('KainowRadar — Seu radar inteligente de ofertas', content, { navCategories: categories, footerConfig: footerCfg }))
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
