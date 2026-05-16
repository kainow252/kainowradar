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
import ml from './routes/ml'
import v1 from './routes/v1'
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

// ── Favicon & Manifest ────────────────────────────────────
// Servidos pelo Cloudflare Pages como arquivos estáticos (via _routes.json exclude)
// Rotas aqui como fallback para o wrangler pages dev local
app.get('/favicon.ico', serveStatic({ root: './' }))
app.get('/favicon.svg', serveStatic({ root: './' }))
app.get('/manifest.json', serveStatic({ root: './' }))

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

// ── Mercado Livre — OAuth2, Webhook (público) ───────────────
app.route('/api/ml', ml)

// ── API Pública v1 — autenticada por X-API-Key ────────────
app.route('/api/v1', v1)

// ── Página de Documentação da API ─────────────────────────
app.get('/api-docs', (c) => c.html(renderApiDocs()))
// /api/ml-callback → ml.get('/') para receber o code do OAuth2
app.get('/api/ml-callback', async (c) => {
  const code  = c.req.query('code')
  const error = c.req.query('error')
  if (error || !code) return c.html(`<h2>❌ Erro OAuth ML: ${error || 'código ausente'}</h2>`)

  const ML_API      = 'https://api.mercadolibre.com'
  const appId       = (c.env as any).ML_APP_ID  || '3098423019766450'
  const secret      = (c.env as any).ML_SECRET  || ''
  const redirectUri = 'https://kainowradar.com.br/api/ml-callback'
  const env         = c.env as any

  // ── Recupera code_verifier do KV (PKCE obrigatório pelo ML) ──
  const codeVerifier: string | null = env.CACHE
    ? await env.CACHE.get('ml_pkce_verifier').catch(() => null)
    : null

  if (!codeVerifier) {
    return c.html(`
      <!DOCTYPE html><html><head><meta charset="UTF-8">
      <script src="https://cdn.tailwindcss.com"></script></head>
      <body class="bg-red-50 flex items-center justify-center min-h-screen">
        <div class="bg-white rounded-2xl p-8 shadow-xl text-center max-w-md">
          <div class="text-5xl mb-4">⚠️</div>
          <h2 class="text-xl font-bold text-red-700 mb-3">Sessão expirada</h2>
          <p class="text-gray-600 mb-4">O tempo limite do fluxo de autorização foi excedido (máx. 10 min).<br>Por favor, inicie o processo novamente.</p>
          <a href="/api/ml/auth" class="bg-yellow-500 text-white px-6 py-3 rounded-xl font-bold hover:bg-yellow-600 inline-block">
            🔄 Tentar novamente
          </a>
        </div>
      </body></html>
    `)
  }

  try {
    const params: Record<string, string> = {
      grant_type:    'authorization_code',
      client_id:     appId,
      client_secret: secret,
      code,
      redirect_uri:  redirectUri,
      code_verifier: codeVerifier,
    }

    const res = await fetch(`${ML_API}/oauth/token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body:    new URLSearchParams(params),
    })
    const data: any = await res.json()
    if (!res.ok) return c.html(`<h2>❌ Erro ao obter token: ${JSON.stringify(data)}</h2>`)

    if (env.CACHE) {
      await env.CACHE.put('ml_access_token',  data.access_token,          { expirationTtl: data.expires_in || 21600 })
      await env.CACHE.put('ml_refresh_token', data.refresh_token || '',   { expirationTtl: 86400 * 30 })
      await env.CACHE.put('ml_user_id',       String(data.user_id || ''), { expirationTtl: 86400 * 30 })
      // Limpa o verifier após uso
      await env.CACHE.delete('ml_pkce_verifier').catch(() => null)
    }

    return c.html(`
      <!DOCTYPE html><html><head><meta charset="UTF-8">
      <script src="https://cdn.tailwindcss.com"></script></head>
      <body class="bg-green-50 flex items-center justify-center min-h-screen">
        <div class="bg-white rounded-2xl p-8 shadow-xl text-center max-w-md">
          <div class="text-6xl mb-4">✅</div>
          <h2 class="text-2xl font-bold text-green-700 mb-2">Conectado ao Mercado Livre!</h2>
          <p class="text-gray-600 mb-1">User ID: <strong>${data.user_id}</strong></p>
          <p class="text-gray-600 mb-4">Token salvo — importação liberada!</p>
          <a href="/admin" class="bg-blue-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-blue-700 inline-block">
            → Ir para o Admin e Importar
          </a>
        </div>
      </body></html>
    `)
  } catch (e: any) {
    return c.html(`<h2>❌ Erro: ${e.message}</h2>`)
  }
})
app.route('/api/ml-webhook', ml)
// NOTA: /admin/api/ml/* está registrado DENTRO do admin.ts para passar pelo middleware de auth

// ── Redirect Afiliado — /go/:offer_id ─────────────────────
// Aceita dois formatos:
//   /go/123                  — offer_id numérico direto
//   /go/nome-do-produto/123  — slug + offer_id (SEO friendly)
// Registra click_event e redireciona 302 para affiliate_url

async function handleGoRedirect(c: any, offerId: number) {
  const { DB } = c.env
  if (!offerId || isNaN(offerId)) return c.redirect('/', 302)

  const offer = await DB.prepare(`
    SELECT
      o.id, o.affiliate_url, o.product_url, o.product_id, o.store_id,
      o.buscape_oid, o.source,
      s.affiliate_network, s.affiliate_id, s.deeplink_base, s.slug AS store_slug,
      p.name AS product_name
    FROM offers o
    JOIN stores s ON s.id = o.store_id
    JOIN products p ON p.id = o.product_id
    WHERE o.id = ? AND o.is_active = 1
  `).bind(offerId).first<any>()

  if (!offer) return c.redirect('/', 302)

  // ── Registra clique para analytics (fire-and-forget) ────
  const ip = c.req.header('CF-Connecting-IP') || ''
  const ipHash = ip
    ? await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip))
        .then((b: ArrayBuffer) => Array.from(new Uint8Array(b)).map((x: number) => x.toString(16).padStart(2,'0')).join(''))
        .catch(() => '')
    : ''
  DB.prepare(`
    INSERT INTO click_events (product_id, offer_id, store_id, ip_hash, user_agent, referrer, clicked_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).bind(
    offer.product_id, offer.id, offer.store_id,
    ipHash || null,
    c.req.header('User-Agent')?.slice(0,200) || null,
    c.req.header('Referer')?.slice(0,500) || null
  ).run().catch(() => {})

  // ── Determina URL de destino ─────────────────────────────
  // Prioridade:
  //  1. affiliate_url salva na oferta — inclui /social/cfegdhabc31955 e /p/MLB...
  //  2. Fallback dinâmico via affiliate_rules
  //  3. product_url (sem tracking)
  //  4. Homepage
  let dest = offer.affiliate_url || ''

  if (!dest && offer.product_url) {
    try {
      const rule = await DB.prepare(`
        SELECT publisher_id, extra_param, link_template
        FROM affiliate_rules
        WHERE network = ? AND is_active = 1 LIMIT 1
      `).bind(offer.affiliate_network || '').first<any>()

      const pubId = offer.affiliate_id || rule?.publisher_id || ''
      const baseUrl = offer.product_url

      if (rule?.link_template && pubId) {
        const trackingBase = (offer.source === 'buscape' && offer.buscape_oid)
          ? `https://www.buscape.com.br/lead?oid=${offer.buscape_oid}&channel=11`
          : baseUrl
        dest = rule.link_template
          .replace('{url}',   encodeURIComponent(trackingBase))
          .replace('{pub}',   pubId)
          .replace('{extra}', rule.extra_param ?? '')
      } else if (offer.source === 'buscape' && offer.buscape_oid) {
        dest = `https://www.buscape.com.br/lead?oid=${offer.buscape_oid}&channel=11`
      } else {
        dest = baseUrl
      }
    } catch {
      dest = offer.product_url || '/'
    }
  }

  if (!dest) dest = offer.product_url || '/'
  if (dest && !dest.startsWith('http')) dest = '/' + dest

  return c.redirect(dest, 302)
}

// /go/slug/123  — slug + id numérico
app.get('/go/:slug/:id', async (c) => {
  const offerId = parseInt(c.req.param('id') || '0')
  return handleGoRedirect(c, offerId)
})

// /go/123  — id numérico direto (legacy e links internos)
app.get('/go/:id', async (c) => {
  const offerId = parseInt(c.req.param('id') || '0')
  return handleGoRedirect(c, offerId)
})

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
      WHERE p.is_active = 1
        AND p.image_url IS NOT NULL AND p.image_url != ''
        AND p.image_url NOT LIKE '%unsplash%'
        AND p.name NOT LIKE 'cfegdhabc%'
        AND p.name NOT LIKE 'Produto Importado%'
      ORDER BY RANDOM() LIMIT 8
    `).all(),
    DB.prepare(`
      SELECT p.*, s.name as best_store_name,
             COALESCE(o.discount_percent, 0) as top_discount
      FROM products p
      LEFT JOIN stores s ON s.id = p.best_store_id
      LEFT JOIN offers o ON o.product_id = p.id AND o.store_id = p.best_store_id AND o.is_active = 1
      WHERE p.is_active = 1 AND p.offer_count > 0
        AND p.image_url IS NOT NULL AND p.image_url != ''
        AND p.name NOT LIKE 'cfegdhabc%'
        AND p.name NOT LIKE 'Produto Importado%'
      ORDER BY RANDOM() LIMIT 8
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

  const host  = c.req.header('host') || 'localhost:3000'
  const proto = host.includes('localhost') ? 'http' : 'https'

  if (editorialExpired) {
    // Dispara regeneração do editorial em background
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

  // Logos SVG inline por slug — alta fidelidade visual, sem depender de URL externa
  // Cada SVG replica os elementos visuais característicos do logo real da marca
  const STORE_LOGO_SVG: Record<string, string> = {

    // ── Mercado Livre — amarelo + escudo azul com estrela ──
    'mercadolivre': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="12" fill="#FFE600"/>
      <!-- escudo azul -->
      <path d="M28 10 C28 10 14 16 14 26 L14 34 C14 42 28 48 28 48 C28 48 42 42 42 34 L42 26 C42 16 28 10 28 10Z" fill="#3483FA"/>
      <!-- estrela branca -->
      <polygon points="28,20 30.4,26.6 37.4,26.6 31.9,30.7 33.8,37.6 28,33.8 22.2,37.6 24.1,30.7 18.6,26.6 25.6,26.6" fill="#FFE600"/>
    </svg>`,

    // ── Amazon — texto preto + seta-sorriso laranja ──
    'amazon': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="12" fill="#fff"/>
      <text x="28" y="26" font-family="Arial,sans-serif" font-size="11" font-weight="900" fill="#221F1F" text-anchor="middle" letter-spacing="-0.3">amazon</text>
      <!-- seta sorriso laranja -->
      <path d="M14 34 Q28 42 42 34" stroke="#FF9900" stroke-width="3" fill="none" stroke-linecap="round"/>
      <path d="M39 31 L42 34 L38 35.5" fill="#FF9900"/>
    </svg>`,

    // ── Magazine Luiza — fundo azul royal + "magalu" branco + ícone Lu ──
    'magalu': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="12" fill="#0086FF"/>
      <!-- círculo Lu -->
      <circle cx="28" cy="20" r="9" fill="#fff"/>
      <text x="28" y="24" font-family="Arial Black,sans-serif" font-size="11" font-weight="900" fill="#0086FF" text-anchor="middle">Lu</text>
      <!-- nome -->
      <text x="28" y="45" font-family="Arial,sans-serif" font-size="10" font-weight="900" fill="#fff" text-anchor="middle" letter-spacing="0.3">magalu</text>
    </svg>`,

    // ── Shopee — laranja-vermelho + sacola de compras ──
    'shopee': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="12" fill="#EE4D2D"/>
      <!-- alça sacola -->
      <path d="M20 22 Q20 14 28 14 Q36 14 36 22" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/>
      <!-- corpo sacola -->
      <rect x="14" y="22" width="28" height="22" rx="4" fill="#fff"/>
      <!-- texto -->
      <text x="28" y="38" font-family="Arial,sans-serif" font-size="9" font-weight="900" fill="#EE4D2D" text-anchor="middle">shopee</text>
    </svg>`,

    // ── Americanas — vermelho + "a" minúsculo estilizado ──
    'americanas': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="12" fill="#E60014"/>
      <!-- "a" bold centralizado -->
      <text x="28" y="36" font-family="Arial Black,sans-serif" font-size="30" font-weight="900" fill="#fff" text-anchor="middle">a</text>
    </svg>`,

    // ── Casas Bahia — azul + casa branca + texto amarelo ──
    'casasbahia': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="12" fill="#0057A8"/>
      <!-- telhado casa -->
      <polygon points="28,10 44,24 12,24" fill="#fff"/>
      <!-- corpo casa -->
      <rect x="16" y="24" width="24" height="16" fill="#fff"/>
      <!-- porta -->
      <rect x="23" y="30" width="10" height="10" fill="#0057A8"/>
      <!-- texto CB -->
      <text x="28" y="52" font-family="Arial,sans-serif" font-size="8" font-weight="900" fill="#FFD700" text-anchor="middle">CASAS BAHIA</text>
    </svg>`,

    // ── KaBuM! — laranja + raio ──
    'kabum': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="12" fill="#F47920"/>
      <!-- raio -->
      <polygon points="32,8 20,30 27,30 24,48 36,26 29,26" fill="#fff"/>
      <text x="28" y="54" font-family="Arial Black,sans-serif" font-size="8" font-weight="900" fill="#fff" text-anchor="middle">KaBuM!</text>
    </svg>`,

    // ── AliExpress — laranja + texto "Ali" ──
    'aliexpress': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="12" fill="#FF6600"/>
      <text x="28" y="24" font-family="Arial Black,sans-serif" font-size="12" font-weight="900" fill="#fff" text-anchor="middle">Ali</text>
      <text x="28" y="40" font-family="Arial,sans-serif" font-size="9" font-weight="700" fill="#fff" text-anchor="middle">Express</text>
    </svg>`,

    // ── Submarino — azul escuro + submarino ──
    'submarino': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="12" fill="#0057A8"/>
      <!-- corpo submarino -->
      <ellipse cx="28" cy="30" rx="18" ry="8" fill="#fff"/>
      <!-- torre -->
      <rect x="22" y="18" width="12" height="12" rx="3" fill="#fff"/>
      <!-- periscópio -->
      <line x1="28" y1="10" x2="28" y2="18" stroke="#fff" stroke-width="3"/>
      <line x1="28" y1="10" x2="34" y2="10" stroke="#fff" stroke-width="3"/>
    </svg>`,

    // ── Netshoes — azul escuro + tênis ──
    'netshoes': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="12" fill="#003DA5"/>
      <!-- tênis estilizado -->
      <path d="M10 36 Q18 28 26 30 Q30 26 40 28 L42 34 Q36 38 28 38 L10 38Z" fill="#fff"/>
      <path d="M26 30 L28 22 L32 24 L30 30" fill="#ccc"/>
      <text x="28" y="50" font-family="Arial,sans-serif" font-size="7" font-weight="900" fill="#fff" text-anchor="middle">netshoes</text>
    </svg>`,

    // ── Pichau — dark + gradiente ciano ──
    'pichau': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="pgr" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#0D1B2A"/>
          <stop offset="100%" stop-color="#1a1a3e"/>
        </linearGradient>
      </defs>
      <rect width="56" height="56" rx="12" fill="url(#pgr)"/>
      <!-- "P" estilizado com detalhe ciano -->
      <text x="22" y="38" font-family="Arial Black,sans-serif" font-size="28" font-weight="900" fill="#00CFFF" text-anchor="middle">P</text>
      <text x="38" y="38" font-family="Arial,sans-serif" font-size="9" font-weight="700" fill="#fff" text-anchor="middle">ichau</text>
      <!-- linha ciano embaixo -->
      <rect x="8" y="44" width="40" height="2" rx="1" fill="#00CFFF"/>
    </svg>`,

    // ── Terabyte — vermelho + chip ──
    'terabyte': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="12" fill="#e60000"/>
      <!-- chip CPU -->
      <rect x="16" y="16" width="24" height="24" rx="3" fill="#fff"/>
      <rect x="20" y="20" width="16" height="16" rx="2" fill="#e60000"/>
      <!-- pinos -->
      <line x1="20" y1="12" x2="20" y2="16" stroke="#fff" stroke-width="2"/>
      <line x1="28" y1="12" x2="28" y2="16" stroke="#fff" stroke-width="2"/>
      <line x1="36" y1="12" x2="36" y2="16" stroke="#fff" stroke-width="2"/>
      <line x1="20" y1="40" x2="20" y2="44" stroke="#fff" stroke-width="2"/>
      <line x1="28" y1="40" x2="28" y2="44" stroke="#fff" stroke-width="2"/>
      <line x1="36" y1="40" x2="36" y2="44" stroke="#fff" stroke-width="2"/>
      <text x="28" y="52" font-family="Arial,sans-serif" font-size="7" font-weight="700" fill="#fff" text-anchor="middle">Terabyte</text>
    </svg>`,

    // ── Fast Shop — verde escuro + raio de velocidade ──
    'fastshop': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="12" fill="#00843D"/>
      <!-- raio/velocidade -->
      <polygon points="34,8 22,28 30,28 22,48 42,24 32,24" fill="#fff"/>
      <!-- "fast" pequeno -->
      <text x="10" y="52" font-family="Arial,sans-serif" font-size="7" font-weight="900" fill="#fff">fast shop</text>
    </svg>`,

    // ── Carrefour — azul + "C" vermelho característico ──
    'carrefour': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="12" fill="#fff"/>
      <!-- fundo azul e vermelho dividido ──  -->
      <path d="M28 4 L52 4 L52 52 L28 52Z" fill="#0066CC"/>
      <path d="M4 4 L28 4 L28 52 L4 52Z" fill="#E60014"/>
      <!-- "C" branco no meio -->
      <path d="M36 18 Q22 18 22 28 Q22 38 36 38" stroke="#fff" stroke-width="7" fill="none" stroke-linecap="round"/>
    </svg>`,

    // ── Extra — vermelho + "extra" bold ──
    'extra': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="12" fill="#E30613"/>
      <!-- "e" estilizado grande -->
      <text x="28" y="38" font-family="Arial Black,sans-serif" font-size="22" font-weight="900" fill="#fff" text-anchor="middle">extra</text>
    </svg>`,

    // ── Ponto Frio — azul claro + floco de neve ──
    'pontofrio': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="12" fill="#00AAFF"/>
      <!-- floco de neve -->
      <line x1="28" y1="10" x2="28" y2="46" stroke="#fff" stroke-width="3"/>
      <line x1="10" y1="28" x2="46" y2="28" stroke="#fff" stroke-width="3"/>
      <line x1="16" y1="16" x2="40" y2="40" stroke="#fff" stroke-width="3"/>
      <line x1="40" y1="16" x2="16" y2="40" stroke="#fff" stroke-width="3"/>
      <circle cx="28" cy="28" r="4" fill="#00AAFF" stroke="#fff" stroke-width="2"/>
    </svg>`,

    // ── Centauro — laranja + símbolo esportivo ──
    'centauro': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="12" fill="#FF6B00"/>
      <!-- "C" bold -->
      <path d="M38 16 Q18 16 18 28 Q18 40 38 40" stroke="#fff" stroke-width="7" fill="none" stroke-linecap="round"/>
      <text x="28" y="52" font-family="Arial,sans-serif" font-size="7" font-weight="700" fill="#fff" text-anchor="middle">centauro</text>
    </svg>`,

    // ── Dafiti — roxo + cabide ──
    'dafiti': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="12" fill="#5C068C"/>
      <!-- cabide -->
      <path d="M28 14 A6 6 0 0 1 34 20 L44 32 L12 32 Z" fill="none" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/>
      <line x1="28" y1="14" x2="28" y2="10" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>
      <text x="28" y="46" font-family="Arial,sans-serif" font-size="10" font-weight="700" fill="#fff" text-anchor="middle">dafiti</text>
    </svg>`,

    // ── Shein — preto + tipografia característica ──
    'shein': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="12" fill="#000"/>
      <!-- "S" estilizado -->
      <path d="M34 18 Q20 18 20 24 Q20 29 28 29 Q36 29 36 35 Q36 41 22 41" stroke="#fff" stroke-width="3.5" fill="none" stroke-linecap="round"/>
      <text x="28" y="53" font-family="Arial Black,sans-serif" font-size="8" font-weight="900" fill="#fff" text-anchor="middle">SHEIN</text>
    </svg>`,

    // ── Renner — vermelho + "R" estilizado ──
    'renner': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="12" fill="#E30613"/>
      <text x="28" y="40" font-family="Arial Black,sans-serif" font-size="30" font-weight="900" fill="#fff" text-anchor="middle">R</text>
    </svg>`,

    // ── Riachuelo — vermelho + âncora/onda ──
    'riachuelo': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="12" fill="#E30613"/>
      <!-- onda -->
      <path d="M8 32 Q14 26 20 32 Q26 38 32 32 Q38 26 48 32" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/>
      <text x="28" y="48" font-family="Arial,sans-serif" font-size="7" font-weight="700" fill="#fff" text-anchor="middle">riachuelo</text>
    </svg>`,

    // ── Leroy Merlin — verde + casa + folha ──
    'leroy': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="12" fill="#00843D"/>
      <!-- casa -->
      <polygon points="28,10 44,24 12,24" fill="#fff"/>
      <rect x="16" y="24" width="24" height="16" fill="#fff"/>
      <rect x="23" y="28" width="10" height="12" fill="#00843D"/>
      <!-- folha verde -->
      <ellipse cx="40" cy="14" rx="6" ry="10" fill="#7DC900" transform="rotate(-30,40,14)"/>
    </svg>`,

    // ── Madeira Madeira — verde + prateleira ──
    'madeiramadeira': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="12" fill="#00833E"/>
      <!-- prateleiras -->
      <rect x="10" y="16" width="36" height="4" rx="2" fill="#fff"/>
      <rect x="10" y="26" width="36" height="4" rx="2" fill="#fff"/>
      <rect x="10" y="36" width="36" height="4" rx="2" fill="#fff"/>
      <!-- livros/objetos em cima -->
      <rect x="14" y="10" width="6" height="6" rx="1" fill="#7DC900"/>
      <rect x="22" y="10" width="4" height="6" rx="1" fill="#fff"/>
      <rect x="28" y="12" width="5" height="4" rx="1" fill="#7DC900"/>
    </svg>`,

    // ── Havan — azul + bandeira BR ──
    'havan': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="12" fill="#0057A8"/>
      <!-- losango verde -->
      <polygon points="28,12 48,28 28,44 8,28" fill="#009B3A"/>
      <!-- círculo azul -->
      <circle cx="28" cy="28" r="9" fill="#002776"/>
      <!-- faixa branca -->
      <path d="M18 28 Q28 25 38 28" stroke="#fff" stroke-width="2" fill="none"/>
      <text x="28" y="52" font-family="Arial Black,sans-serif" font-size="8" font-weight="900" fill="#FFD700" text-anchor="middle">havan</text>
    </svg>`,

    // ── Tok&Stok — vermelho + ponto geométrico ──
    'tok_stok': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="12" fill="#E63329"/>
      <text x="28" y="26" font-family="Arial Black,sans-serif" font-size="11" font-weight="900" fill="#fff" text-anchor="middle">tok</text>
      <text x="28" y="41" font-family="Arial Black,sans-serif" font-size="11" font-weight="900" fill="#fff" text-anchor="middle">&amp;stok</text>
    </svg>`,

    // ── Samsung — azul Samsung + elipse característica ──
    'samsung': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="12" fill="#1428A0"/>
      <text x="28" y="32" font-family="Arial,sans-serif" font-size="9" font-weight="700" fill="#fff" text-anchor="middle" letter-spacing="0.5">SAMSUNG</text>
    </svg>`,

    // ── Apple — prata + maçã mordida ──
    'apple': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="12" fill="#f5f5f7"/>
      <!-- maçã -->
      <path d="M34 14 Q30 8 26 14 Q18 14 16 22 Q12 34 20 42 Q24 46 28 42 Q32 46 36 42 Q44 34 40 22 Q38 14 34 14Z" fill="#555"/>
      <!-- folha -->
      <path d="M30 10 Q32 6 36 8 Q34 12 30 10Z" fill="#555"/>
    </svg>`,

    // ── Zattini — dark + "Z" ──
    'zattini': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="12" fill="#1a1a1a"/>
      <text x="28" y="40" font-family="Arial Black,sans-serif" font-size="28" font-weight="900" fill="#fff" text-anchor="middle">Z</text>
    </svg>`,

    // ── Hotmart — laranja-vermelho + chama ──
    'hotmart': `<svg viewBox="0 0 56 56" class="w-12 h-12 object-contain" xmlns="http://www.w3.org/2000/svg">
      <rect width="56" height="56" rx="12" fill="#FF4D0D"/>
      <!-- chama -->
      <path d="M28 10 Q36 20 32 28 Q38 22 36 34 Q40 26 38 36 Q38 46 28 48 Q18 46 18 36 Q16 26 20 34 Q18 22 24 28 Q20 20 28 10Z" fill="#fff"/>
    </svg>`,
  }

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
    const logoSvg    = STORE_LOGO_SVG[s.slug] || null
    const logoUrl     = s.logo_url || null   // URL/base64 cadastrado no admin — prioridade máxima
    return { ...s, color, bg, text, initial, logoSvg, logoUrl }
  })

  // ── HERO ─────────────────────────────────────────────────
  const heroHTML = `
    <section class="hero-section">
      <div class="hero-orb hero-orb-1"></div>
      <div class="hero-orb hero-orb-2"></div>
      <div class="hero-orb hero-orb-3"></div>

      <!-- HERO INNER -->
      <div class="hero-inner">

        <!-- H1 — mesma largura do search wrap -->
        <h1 class="hero-h1">
          O menor preço está <span class="hero-gradient-text">aqui Sempre</span>
        </h1>

        <!-- Subtítulo -->
        <p class="hero-sub">
          Compare preços em tempo real nas maiores lojas do Brasil e compre sempre na melhor oferta.
        </p>

        <!-- Search bar -->
        <div class="hero-search-wrap">
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
            class="hero-search-btn">Buscar</button>
        </div>

        <!-- Populares — marquee animado -->
        <div class="hero-tags-marquee-wrapper">
          <div class="hero-tags-marquee">
            <div class="hero-tags-marquee-track">
              ${['iPhone 15', 'Galaxy S24', 'PS5', 'Notebook', 'AirPods', 'Smart TV', 'iPad', 'Geladeira', 'MacBook', 'Xbox Series', 'Monitor', 'Headphone', 'Kindle', 'iPhone 15', 'Galaxy S24', 'PS5', 'Notebook', 'AirPods', 'Smart TV', 'iPad', 'Geladeira', 'MacBook', 'Xbox Series', 'Monitor', 'Headphone', 'Kindle'].map(t =>
                `<button onclick="quickSearch('${t}')" class="quick-tag">${t}</button>`
              ).join('')}
            </div>
          </div>
        </div>

      </div>
    </section>

    <script>
    /* ── FitHero: ajusta H1 e sub para ficarem com EXATAMENTE a largura da search bar ──
       Técnica: clona o elemento em position:fixed fora da tela (sem overflow:hidden)
       para medir o scrollWidth real do texto a cada font-size testado (busca binária) */
    (function fitHero() {

      function measureText(el, fs) {
        /* cria um clone invisível e sem overflow para medir o texto real */
        var clone = el.cloneNode(true);
        clone.style.cssText = [
          'position:fixed', 'top:-9999px', 'left:-9999px',
          'white-space:nowrap', 'overflow:visible', 'visibility:hidden',
          'font-size:' + fs + 'px', 'width:auto', 'max-width:none',
          'display:inline-block', 'pointer-events:none'
        ].join(';');
        document.body.appendChild(clone);
        var w = clone.getBoundingClientRect().width;
        document.body.removeChild(clone);
        return w;
      }

      function fitEl(el, targetW, loFs, hiFs) {
        var fs = hiFs, lo = loFs, hi = hiFs;
        for (var i = 0; i < 30; i++) {
          fs = (lo + hi) / 2;
          var w = measureText(el, fs);
          if (Math.abs(w - targetW) < 0.3) break;
          if (w < targetW) lo = fs; else hi = fs;
        }
        /* aplica fs final com 0.5px de margem de segurança */
        el.style.fontSize = (fs - 0.5) + 'px';
      }

      function adjust() {
        var wrap = document.querySelector('.hero-search-wrap');
        var h1   = document.querySelector('.hero-h1');
        var sub  = document.querySelector('.hero-sub');
        if (!wrap || !h1 || !sub) return;

        var targetW = wrap.getBoundingClientRect().width;
        if (targetW < 80) return;

        /* remove qualquer font-size inline anterior para partir do CSS */
        h1.style.fontSize  = '';
        sub.style.fontSize = '';

        fitEl(h1,  targetW, 8,  120);
        fitEl(sub, targetW, 6,  60);
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
          adjust();
          /* segunda passagem após fontes carregarem */
          setTimeout(adjust, 300);
        });
      } else {
        adjust();
        setTimeout(adjust, 300);
      }
      window.addEventListener('resize', adjust);
    })();
    </script>
  `

  // ── FAIXA DE LOJAS PARCEIRAS ──────────────────────────────
  // Duplica o array para criar loop contínuo no marquee
  const storeCards = (arr: typeof stores) => arr.map(s => `
    <a href="/loja/${s.slug}"
       class="store-pill-card flex-shrink-0 flex flex-col items-center gap-2 w-[76px] cursor-pointer group"
       title="Comparar preços na ${s.name}">
      <div class="store-logo-circle w-16 h-16 rounded-2xl flex items-center justify-center shadow-md transition-all duration-200 group-hover:scale-110 group-hover:shadow-xl overflow-hidden ring-2 ring-transparent group-hover:ring-blue-200"
           style="${s.logoUrl ? '' : s.logoSvg ? 'background:#fff;' : `background:${s.bg};border:2px solid ${s.color};`}">
        ${s.logoUrl
          ? `<img src="${s.logoUrl}" alt="${s.name}" loading="lazy" class="w-full h-full object-cover" style="display:block" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
             <span class="hidden w-full h-full items-center justify-center font-black text-xl leading-none rounded-2xl" style="background:${s.bg};color:${s.color}">${s.initial}</span>`
          : s.logoSvg
            ? s.logoSvg
            : `<span class="font-black text-xl leading-none" style="color:${s.color}">${s.initial}</span>`
        }
      </div>
      <span class="text-xs text-gray-700 font-bold text-center leading-tight w-full truncate group-hover:text-blue-700 transition-colors">${s.name}</span>
      <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full border" style="color:${s.color}; background:${s.bg}; border-color:${s.color}33">${s.text}</span>
    </a>
  `).join('')

  const storesHTML = `
    <section class="bg-white border-b border-gray-100 overflow-hidden">
      <div class="w-full px-4 pt-5 pb-3">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <div class="flex items-center gap-2.5">
            <div class="w-1 h-5 bg-gradient-to-b from-blue-500 to-blue-700 rounded-full"></div>
            <h2 class="text-base font-black text-gray-800">Lojas Parceiras</h2>
            <span class="inline-flex items-center gap-1 bg-blue-50 text-blue-600 text-xs font-bold px-2.5 py-1 rounded-full border border-blue-100">
              <span class="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse"></span>
              <span id="stores-count">${stores.length}</span> lojas
            </span>
          </div>
          <!-- Campo de busca de loja -->
          <div class="relative w-full sm:w-64">
            <span class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z"/></svg>
            </span>
            <input
              id="store-search-input"
              type="text"
              placeholder="Buscar loja..."
              autocomplete="off"
              class="w-full pl-9 pr-8 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400 bg-gray-50 transition-all"
            />
            <button id="store-search-clear" onclick="document.getElementById('store-search-input').value='';document.getElementById('store-search-input').dispatchEvent(new Event('input'))" class="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500 hidden text-lg leading-none">&times;</button>
          </div>
        </div>
      </div>

      <!-- Lojas: marquee se tiver 10+, grid estático se tiver poucas -->
      <!-- Threshold 10: abaixo disso a duplicação do loop deixa lojas aparecendo 2× no viewport -->
      <div id="stores-marquee-section" class="relative mb-4">
        ${stores.length >= 10 ? `
        <div class="stores-marquee-wrapper">
          <div class="stores-marquee-fade-left"></div>
          <div class="stores-marquee-fade-right"></div>
          <div class="stores-marquee" style="animation-duration:${Math.max(30, stores.length * 1.8)}s">
            <div class="stores-marquee-track flex gap-4 px-4 py-2">
              ${storeCards(stores)}
              ${storeCards(stores)}
            </div>
          </div>
        </div>
        ` : `
        <div class="flex flex-wrap gap-3 px-4 py-2">
          ${storeCards(stores)}
        </div>
        `}
      </div>

      <!-- Grid de resultados de busca (oculto por padrão) -->
      <div id="stores-search-results" class="hidden max-w-7xl mx-auto px-4 pb-5">
        <div id="stores-search-grid" class="flex flex-wrap gap-3"></div>
        <p id="stores-search-empty" class="hidden text-center text-gray-400 text-sm py-6">Nenhuma loja encontrada para "<span id="stores-empty-term"></span>"</p>
      </div>

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
        .stores-marquee-track { display: flex; gap: 1rem; }
        @keyframes marquee-ltr {
          from { transform: translateX(0); }
          to   { transform: translateX(-50%); }
        }
        .store-pill-card:hover .store-logo-circle { transform: scale(1.12); }
        .store-result-card {
          display:flex; flex-direction:column; align-items:center; gap:6px;
          width:80px; cursor:pointer; text-decoration:none;
          padding:8px 4px; border-radius:12px;
          transition: background 0.15s, transform 0.15s;
        }
        .store-result-card:hover { background:#f0f7ff; transform:scale(1.06); }
      </style>

      <script>
      (function(){
        const storesData = ${JSON.stringify(stores.map(s => ({ name: s.name, slug: s.slug, color: s.color, bg: s.bg, initial: s.initial, text: s.text, logoSvg: s.logoSvg || '' })))};
        const input   = document.getElementById('store-search-input');
        const clearBtn= document.getElementById('store-search-clear');
        const marquee = document.getElementById('stores-marquee-section');
        const results = document.getElementById('stores-search-results');
        const grid    = document.getElementById('stores-search-grid');
        const empty   = document.getElementById('stores-search-empty');
        const emptyTerm = document.getElementById('stores-empty-term');
        const countEl = document.getElementById('stores-count');

        input.addEventListener('input', function(){
          const q = this.value.trim().toLowerCase();
          clearBtn.classList.toggle('hidden', q === '');

          if(!q){
            marquee.classList.remove('hidden');
            results.classList.add('hidden');
            countEl.textContent = storesData.length;
            return;
          }

          const filtered = storesData.filter(s => s.name.toLowerCase().includes(q));
          countEl.textContent = filtered.length;
          marquee.classList.add('hidden');
          results.classList.remove('hidden');

          if(filtered.length === 0){
            grid.innerHTML = '';
            emptyTerm.textContent = this.value.trim();
            empty.classList.remove('hidden');
          } else {
            empty.classList.add('hidden');
            grid.innerHTML = filtered.map(s => \`
              <a href="/busca?store=\${s.slug}" class="store-result-card group" title="Ver produtos na \${s.name}">
                <div style="width:56px;height:56px;border-radius:14px;display:flex;align-items:center;justify-content:center;background:\${s.bg};border:2px solid \${s.color};overflow:hidden;">
                  \${s.logoSvg || '<span style="font-weight:900;font-size:1rem;color:'+s.color+'">'+s.initial+'</span>'}
                </div>
                <span style="font-size:11px;font-weight:700;color:#374151;text-align:center;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">\${s.name}</span>
                <span style="font-size:10px;font-weight:700;padding:2px 6px;border-radius:99px;color:\${s.color};background:\${s.bg}">\${s.text}</span>
              </a>
            \`).join('');
          }
        });
      })();
      </script>
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
    <section class="w-full" id="editorial-banners">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-0 md:gap-4">

        <!-- Banner principal — gerado pela IA editorial -->
        <div class="md:col-span-2 promo-banner group cursor-pointer relative overflow-hidden rounded-none md:rounded-2xl p-6 md:p-8"
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
          <div class="promo-banner group cursor-pointer flex-1 relative overflow-hidden rounded-none md:rounded-2xl p-5"
               style="background: linear-gradient(135deg, ${bSec1.color_from} 0%, ${bSec1.color_to} 100%); min-height:90px;"
               onclick="${sec1Action}">
            <div class="relative z-10">
              <span class="text-xs font-bold text-white/60 uppercase tracking-wide">${bSec1.label || 'Categoria'}</span>
              <h4 class="text-lg font-black text-white mt-1 leading-tight">${sec1TitleHTML}</h4>
              ${bSec1.stat_value ? `<p class="text-white/50 text-xs mt-1">${bSec1.stat_value}</p>` : ''}
            </div>
            <div class="absolute right-3 bottom-2 text-5xl opacity-20 select-none pointer-events-none">${bSec1.emoji || '💡'}</div>
          </div>
          <div class="promo-banner group cursor-pointer flex-1 relative overflow-hidden rounded-none md:rounded-2xl p-5"
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
    <section id="search-results-section" class="hidden w-full py-8">
      <div class="max-w-7xl mx-auto px-4">
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
      </div>
    </section>
  `

  // ── MAIORES DESCONTOS ─────────────────────────────────────
  const dealsHTML = deals.length > 0 ? `
    <section class="py-8">
      <div class="w-full px-4 sm:px-6">
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

  // ── CATEGORIAS — lista colapsável (começa fechada, abre/recolhe ao clicar) ──
  const catBlocksHTML = categories.length > 0 ? `
    <section class="bg-white border-y border-gray-100">
      <div class="w-full px-4 sm:px-6">

        <!-- Cabeçalho clicável -->
        <button onclick="toggleCatSection()" id="cat-section-toggle"
          class="w-full flex items-center justify-between py-4 group select-none">
          <div class="flex items-center gap-3">
            <div class="w-1 h-6 bg-gradient-to-b from-blue-500 to-blue-700 rounded-full"></div>
            <h2 class="text-base font-black text-gray-900 group-hover:text-blue-700 transition-colors">
              Explorar por Categoria
            </h2>
            <span class="text-xs text-gray-400 font-medium">${categories.length} categorias</span>
          </div>
          <div class="flex items-center gap-2 text-gray-400 group-hover:text-blue-600 transition-colors">
            <span id="cat-section-label" class="text-xs font-semibold">Ver todas</span>
            <svg id="cat-section-chevron"
              class="w-4 h-4 transition-transform duration-300"
              fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 9l-7 7-7-7"/>
            </svg>
          </div>
        </button>

        <!-- Lista de categorias — fechada por padrão -->
        <div id="cat-section-body"
          style="display:none;overflow:hidden"
          class="pb-3">
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-0.5">
            ${categories.map((cat: any) => `
              <a href="/categoria/${cat.slug}"
                class="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-blue-50 active:bg-blue-100 transition-colors group">
                <span class="text-xl w-8 text-center flex-shrink-0">${cat.icon || '🛒'}</span>
                <span class="flex-1 text-sm font-semibold text-gray-700 group-hover:text-blue-700 transition-colors">${cat.name}</span>
                ${cat.product_count > 0
                  ? '<span class="text-xs text-gray-400 font-medium flex-shrink-0">' + cat.product_count + ' produtos</span>'
                  : ''}
                <svg class="w-3.5 h-3.5 text-gray-300 group-hover:text-blue-400 flex-shrink-0 transition-colors"
                  fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7"/>
                </svg>
              </a>
            `).join('')}
          </div>
        </div>

      </div>
    </section>

    <script>
      function toggleCatSection() {
        var body    = document.getElementById('cat-section-body')
        var chevron = document.getElementById('cat-section-chevron')
        var label   = document.getElementById('cat-section-label')
        var open    = body.style.display !== 'none'
        if (open) {
          // Fecha com animação
          body.style.maxHeight = body.scrollHeight + 'px'
          body.style.overflow  = 'hidden'
          requestAnimationFrame(function() {
            body.style.transition  = 'max-height 0.28s ease, opacity 0.2s ease'
            body.style.maxHeight   = '0px'
            body.style.opacity     = '0'
          })
          setTimeout(function() {
            body.style.display   = 'none'
            body.style.maxHeight = ''
            body.style.opacity   = ''
            body.style.transition= ''
          }, 290)
          chevron.style.transform = ''
          label.textContent       = 'Ver todas'
        } else {
          // Abre com animação
          body.style.display   = 'block'
          body.style.maxHeight = '0px'
          body.style.opacity   = '0'
          body.style.overflow  = 'hidden'
          requestAnimationFrame(function() {
            body.style.transition = 'max-height 0.32s ease, opacity 0.22s ease'
            body.style.maxHeight  = body.scrollHeight + 'px'
            body.style.opacity    = '1'
          })
          setTimeout(function() {
            body.style.overflow  = 'visible'
            body.style.maxHeight = ''
            body.style.transition= ''
          }, 330)
          chevron.style.transform = 'rotate(180deg)'
          label.textContent       = 'Recolher'
        }
      }
    </script>
  ` : ''

  // ── EM DESTAQUE ───────────────────────────────────────────
  const featuredHTML = featured.length > 0 ? `
    <section class="py-8">
      <div class="w-full px-4 sm:px-6">
        <div class="flex items-center justify-between mb-5">
          <div class="flex items-center gap-3">
            <div class="w-1 h-7 bg-gradient-to-b from-blue-500 to-indigo-600 rounded-full"></div>
            <h2 class="text-xl font-black text-gray-900">Em Destaque</h2>
          </div>
          <a href="/busca" class="inline-flex items-center gap-1.5 text-sm font-semibold text-blue-600 hover:text-blue-800 transition-colors group">
            Ver todos os produtos
            <svg class="w-4 h-4 group-hover:translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
          </a>
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
      <div class="w-full max-w-5xl mx-auto px-6 text-center">
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
    <div class="w-full pb-2">
      <div class="bg-slate-900 w-full px-5 py-3 flex items-center gap-3 overflow-hidden">
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

  // Ordem: Hero → Lojas → Deals (produtos visíveis logo no topo) → Banners → Categorias → Destaque → Como funciona
  const content = heroHTML + storesHTML + dealsHTML + featuredHTML + bannerHTML + insightsHTML + searchResultsHTML + catBlocksHTML + howHTML

  // Nunca cachear a home no CDN — lojas/produtos mudam dinamicamente
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate')
  c.header('Pragma', 'no-cache')
  // Monta navStores: lojas ativas com cores corretas para o menu mobile dinâmico
  const navStores = stores.map(s => ({
    name:      s.name,
    slug:      s.slug,
    color:     s.color,
    textColor: s.color === '#FFE600' ? '#333' : '#fff', // ML tem fundo amarelo → texto escuro
    initial:   s.initial,
  }))

  // Detecta usuário logado server-side pelo cookie
  const cookie = c.req.header('Cookie') || ''
  const scToken = cookie.match(/sc_token=([^;]+)/)?.[1] || ''
  let currentUser = null
  if (scToken) {
    try {
      currentUser = await (c.env as any).DB.prepare(
        `SELECT full_name, email, avatar_url FROM oauth_users WHERE session_token = ? AND session_expires_at > CURRENT_TIMESTAMP LIMIT 1`
      ).bind(scToken).first<any>()
    } catch {}
  }

  return c.html(renderLayout('KainowRadar — Seu radar inteligente de ofertas', content, { navCategories: categories, navStores, footerConfig: footerCfg, currentUser }))
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

// ── Página de Documentação da API ─────────────────────────
function renderApiDocs(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KainowRadar API — Documentação</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Inter', sans-serif; }
    .endpoint-card { border-left: 4px solid #3b82f6; }
    pre { white-space: pre-wrap; word-break: break-all; }
    .try-btn { cursor: pointer; }
  </style>
</head>
<body class="bg-slate-50 text-slate-800">

  <!-- Hero -->
  <div class="bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 text-white">
    <div class="max-w-5xl mx-auto px-6 py-16">
      <div class="flex items-center gap-3 mb-4">
        <div class="w-12 h-12 bg-gradient-to-br from-blue-500 to-blue-700 rounded-2xl flex items-center justify-center shadow-xl">
          <svg viewBox="0 0 24 24" class="w-7 h-7" fill="white"><path d="M5 3h3v7.5l7-7.5h4L11 11l8.5 10H15l-7-8.5V21H5V3z"/></svg>
        </div>
        <div>
          <div class="font-black text-xl tracking-tight"><span class="text-white">Kainow</span><span class="text-yellow-300">Radar</span></div>
          <div class="text-blue-300 text-xs">API Pública</div>
        </div>
      </div>
      <h1 class="text-4xl font-black mb-3">API Reference <span class="text-blue-400">v1</span></h1>
      <p class="text-slate-300 text-lg max-w-2xl">Acesse produtos, preços e ofertas em tempo real do KainowRadar. Autenticação simples por API Key.</p>
      <div class="flex flex-wrap gap-3 mt-6">
        <span class="bg-green-500/20 text-green-300 border border-green-500/30 text-xs font-bold px-3 py-1.5 rounded-full">✅ REST JSON</span>
        <span class="bg-blue-500/20 text-blue-300 border border-blue-500/30 text-xs font-bold px-3 py-1.5 rounded-full">🔑 API Key Auth</span>
        <span class="bg-purple-500/20 text-purple-300 border border-purple-500/30 text-xs font-bold px-3 py-1.5 rounded-full">⚡ Edge — Cloudflare</span>
        <span class="bg-yellow-500/20 text-yellow-300 border border-yellow-500/30 text-xs font-bold px-3 py-1.5 rounded-full">📦 CORS habilitado</span>
      </div>
    </div>
  </div>

  <div class="max-w-5xl mx-auto px-6 py-12 space-y-10">

    <!-- Autenticação -->
    <section id="auth">
      <h2 class="text-2xl font-black text-slate-900 mb-4">🔑 Autenticação</h2>
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
        <p class="text-slate-600">Todas as requisições precisam de uma API Key válida. Passe a chave de uma das formas abaixo:</p>
        <div class="grid md:grid-cols-2 gap-4">
          <div>
            <p class="text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">Via Header (recomendado)</p>
            <pre class="bg-slate-900 text-green-400 rounded-xl p-4 text-sm">X-API-Key: kr_live_sua_chave_aqui</pre>
          </div>
          <div>
            <p class="text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">Via Query Param</p>
            <pre class="bg-slate-900 text-green-400 rounded-xl p-4 text-sm">?api_key=kr_live_sua_chave_aqui</pre>
          </div>
        </div>
        <div class="bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm text-blue-800">
          <strong>Obtendo sua chave:</strong> Acesse o painel administrativo em <code class="bg-white px-1 rounded">/admin</code> → seção <strong>🔑 API Keys</strong> e clique em "Gerar API Key".
        </div>
      </div>
    </section>

    <!-- Rate Limit -->
    <section id="rate-limit">
      <h2 class="text-2xl font-black text-slate-900 mb-4">⏱️ Rate Limit</h2>
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
        <div class="grid md:grid-cols-3 gap-4 mb-4">
          <div class="bg-slate-50 rounded-xl p-4 text-center">
            <div class="text-2xl font-black text-slate-700">100</div>
            <div class="text-xs text-slate-500 mt-1">req/hora — Free</div>
          </div>
          <div class="bg-blue-50 rounded-xl p-4 text-center">
            <div class="text-2xl font-black text-blue-700">1.000</div>
            <div class="text-xs text-slate-500 mt-1">req/hora — Pro</div>
          </div>
          <div class="bg-purple-50 rounded-xl p-4 text-center">
            <div class="text-2xl font-black text-purple-700">10.000</div>
            <div class="text-xs text-slate-500 mt-1">req/hora — Enterprise</div>
          </div>
        </div>
        <p class="text-sm text-slate-600">Os headers de resposta informam sua quota atual:</p>
        <pre class="bg-slate-900 text-green-400 rounded-xl p-4 text-sm mt-3">X-RateLimit-Limit: 100
X-RateLimit-Remaining: 87
X-RateLimit-Reset: 1718300400</pre>
        <p class="text-xs text-slate-400 mt-2">Quando exceder o limite, a API retorna <code class="bg-slate-100 px-1 rounded">HTTP 429</code> com o horário de reset.</p>
      </div>
    </section>

    <!-- Base URL -->
    <section>
      <h2 class="text-2xl font-black text-slate-900 mb-4">🌐 Base URL</h2>
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
        <pre class="bg-slate-900 text-yellow-300 rounded-xl p-4 text-sm font-bold">https://kainowradar.com.br/api/v1</pre>
      </div>
    </section>

    <!-- Endpoints -->
    <section id="endpoints">
      <h2 class="text-2xl font-black text-slate-900 mb-6">📋 Endpoints</h2>
      <div class="space-y-6">

        <!-- STATUS -->
        <div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden endpoint-card">
          <div class="p-5 flex items-start justify-between gap-4">
            <div class="flex-1">
              <div class="flex items-center gap-3 mb-2">
                <span class="bg-blue-100 text-blue-700 text-xs font-black px-2.5 py-1 rounded-lg">GET</span>
                <code class="font-bold text-slate-800">/api/v1/status</code>
              </div>
              <p class="text-sm text-slate-600">Verifica se a chave é válida e retorna informações de quota e plano.</p>
            </div>
          </div>
          <div class="border-t border-slate-100 p-5">
            <p class="text-xs font-bold text-slate-400 uppercase tracking-wide mb-2">Resposta de exemplo</p>
            <pre class="bg-slate-900 text-green-400 rounded-xl p-4 text-xs">{
  "ok": true,
  "app_name": "Meu App",
  "plan": "free",
  "scopes": ["read"],
  "quota": {
    "limit_per_hour": 100,
    "remaining": 98,
    "used": 2
  },
  "docs": "https://kainowradar.com.br/api-docs"
}</pre>
          </div>
        </div>

        <!-- PRODUCTS -->
        <div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden endpoint-card">
          <div class="p-5">
            <div class="flex items-center gap-3 mb-2">
              <span class="bg-blue-100 text-blue-700 text-xs font-black px-2.5 py-1 rounded-lg">GET</span>
              <code class="font-bold text-slate-800">/api/v1/products</code>
            </div>
            <p class="text-sm text-slate-600 mb-4">Lista produtos com filtros, paginação e ordenação.</p>
            <div class="overflow-x-auto">
              <table class="w-full text-xs">
                <thead><tr class="bg-slate-50">
                  <th class="text-left px-3 py-2 font-bold text-slate-500">Param</th>
                  <th class="text-left px-3 py-2 font-bold text-slate-500">Tipo</th>
                  <th class="text-left px-3 py-2 font-bold text-slate-500">Padrão</th>
                  <th class="text-left px-3 py-2 font-bold text-slate-500">Descrição</th>
                </tr></thead>
                <tbody class="divide-y divide-slate-50">
                  ${[
                    ['q','string','—','Busca por nome, marca ou EAN'],
                    ['category','string','—','Slug da categoria (ex: smartphones)'],
                    ['brand','string','—','Filtro por marca'],
                    ['min_price','number','—','Preço mínimo (R$)'],
                    ['max_price','number','—','Preço máximo (R$)'],
                    ['sort','string','relevance','relevance | price_asc | price_desc | newest | name'],
                    ['page','integer','1','Página (paginação)'],
                    ['limit','integer','20','Itens por página (máx 50)'],
                  ].map(([p,t,d,desc]) => `
                    <tr>
                      <td class="px-3 py-2 font-mono text-blue-700 font-bold">${p}</td>
                      <td class="px-3 py-2 text-slate-500">${t}</td>
                      <td class="px-3 py-2 text-slate-400">${d}</td>
                      <td class="px-3 py-2 text-slate-600">${desc}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
          <div class="border-t border-slate-100 p-5 bg-slate-50">
            <p class="text-xs font-bold text-slate-400 uppercase tracking-wide mb-2">Exemplo de requisição</p>
            <pre class="bg-slate-900 text-green-400 rounded-xl p-4 text-xs">GET /api/v1/products?category=smartphones&sort=price_asc&limit=10
X-API-Key: kr_live_sua_chave</pre>
          </div>
        </div>

        <!-- PRODUCTS/:id -->
        <div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden endpoint-card">
          <div class="p-5">
            <div class="flex items-center gap-3 mb-2">
              <span class="bg-blue-100 text-blue-700 text-xs font-black px-2.5 py-1 rounded-lg">GET</span>
              <code class="font-bold text-slate-800">/api/v1/products/:id</code>
            </div>
            <p class="text-sm text-slate-600">Retorna um produto pelo ID numérico ou slug, com todas as ofertas ordenadas por menor preço.</p>
          </div>
          <div class="border-t border-slate-100 p-5">
            <pre class="bg-slate-900 text-green-400 rounded-xl p-4 text-xs">GET /api/v1/products/iphone-15-128gb
GET /api/v1/products/42</pre>
          </div>
        </div>

        <!-- SEARCH -->
        <div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden endpoint-card">
          <div class="p-5">
            <div class="flex items-center gap-3 mb-2">
              <span class="bg-blue-100 text-blue-700 text-xs font-black px-2.5 py-1 rounded-lg">GET</span>
              <code class="font-bold text-slate-800">/api/v1/search?q=</code>
            </div>
            <p class="text-sm text-slate-600 mb-3">Busca full-text por nome, marca ou EAN. Mínimo 2 caracteres.</p>
            <pre class="bg-slate-900 text-green-400 rounded-xl p-4 text-xs">GET /api/v1/search?q=Samsung+Galaxy&limit=20</pre>
          </div>
        </div>

        <!-- CATEGORIES -->
        <div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden endpoint-card">
          <div class="p-5">
            <div class="flex items-center gap-3 mb-2">
              <span class="bg-blue-100 text-blue-700 text-xs font-black px-2.5 py-1 rounded-lg">GET</span>
              <code class="font-bold text-slate-800">/api/v1/categories</code>
            </div>
            <p class="text-sm text-slate-600">Lista todas as categorias com contagem de produtos.</p>
          </div>
        </div>

        <!-- DEALS -->
        <div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden endpoint-card">
          <div class="p-5">
            <div class="flex items-center gap-3 mb-2">
              <span class="bg-blue-100 text-blue-700 text-xs font-black px-2.5 py-1 rounded-lg">GET</span>
              <code class="font-bold text-slate-800">/api/v1/deals</code>
            </div>
            <p class="text-sm text-slate-600 mb-3">Melhores ofertas com desconto, ordenadas por maior % de desconto.</p>
            <div class="overflow-x-auto">
              <table class="w-full text-xs">
                <thead><tr class="bg-slate-50">
                  <th class="text-left px-3 py-2 font-bold text-slate-500">Param</th>
                  <th class="text-left px-3 py-2 font-bold text-slate-500">Padrão</th>
                  <th class="text-left px-3 py-2 font-bold text-slate-500">Descrição</th>
                </tr></thead>
                <tbody>
                  <tr><td class="px-3 py-2 font-mono text-blue-700 font-bold">category</td><td class="px-3 py-2 text-slate-400">—</td><td class="px-3 py-2 text-slate-600">Filtrar por categoria</td></tr>
                  <tr><td class="px-3 py-2 font-mono text-blue-700 font-bold">min_discount</td><td class="px-3 py-2 text-slate-400">5</td><td class="px-3 py-2 text-slate-600">Desconto mínimo em %</td></tr>
                  <tr><td class="px-3 py-2 font-mono text-blue-700 font-bold">limit</td><td class="px-3 py-2 text-slate-400">20</td><td class="px-3 py-2 text-slate-600">Máximo de resultados (50)</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- PRICE -->
        <div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden endpoint-card">
          <div class="p-5">
            <div class="flex items-center gap-3 mb-2">
              <span class="bg-blue-100 text-blue-700 text-xs font-black px-2.5 py-1 rounded-lg">GET</span>
              <code class="font-bold text-slate-800">/api/v1/price/:ml_id</code>
            </div>
            <p class="text-sm text-slate-600 mb-3">Consulta o preço atual de um produto pelo ID do Mercado Livre.</p>
            <pre class="bg-slate-900 text-green-400 rounded-xl p-4 text-xs">GET /api/v1/price/MLB1234567890</pre>
          </div>
          <div class="border-t border-slate-100 p-5">
            <pre class="bg-slate-900 text-green-400 rounded-xl p-4 text-xs">{
  "ml_item_id": "MLB1234567890",
  "name": "iPhone 15 128GB",
  "price": 4499.00,
  "original_price": 5199.00,
  "discount_percent": 13,
  "free_shipping": true,
  "store": "Mercado Livre",
  "affiliate_url": "https://...",
  "updated_at": "2025-05-13T10:00:00Z"
}</pre>
          </div>
        </div>

      </div>
    </section>

    <!-- Erros -->
    <section id="erros">
      <h2 class="text-2xl font-black text-slate-900 mb-4">❌ Códigos de Erro</h2>
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <table class="w-full text-sm">
          <thead><tr class="bg-slate-50">
            <th class="text-left px-5 py-3 font-bold text-slate-500">Código</th>
            <th class="text-left px-5 py-3 font-bold text-slate-500">Significado</th>
          </tr></thead>
          <tbody class="divide-y divide-slate-100">
            <tr><td class="px-5 py-3 font-mono font-bold text-red-600">401</td><td class="px-5 py-3 text-slate-600">API Key ausente ou inválida</td></tr>
            <tr><td class="px-5 py-3 font-mono font-bold text-red-600">403</td><td class="px-5 py-3 text-slate-600">Chave desativada ou expirada</td></tr>
            <tr><td class="px-5 py-3 font-mono font-bold text-orange-600">404</td><td class="px-5 py-3 text-slate-600">Recurso não encontrado</td></tr>
            <tr><td class="px-5 py-3 font-mono font-bold text-yellow-600">429</td><td class="px-5 py-3 text-slate-600">Rate limit excedido — aguarde o reset</td></tr>
            <tr><td class="px-5 py-3 font-mono font-bold text-red-700">500</td><td class="px-5 py-3 text-slate-600">Erro interno do servidor</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Testador rápido -->
    <section id="testar">
      <h2 class="text-2xl font-black text-slate-900 mb-4">🧪 Testar ao Vivo</h2>
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
        <div class="grid md:grid-cols-3 gap-3">
          <div class="md:col-span-2">
            <label class="block text-xs font-bold text-slate-500 mb-1.5">Sua API Key</label>
            <input id="docs-apikey" type="text" placeholder="kr_live_..."
              class="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-400">
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-500 mb-1.5">Endpoint</label>
            <select id="docs-endpoint" class="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-400">
              <option value="/api/v1/status">GET /status</option>
              <option value="/api/v1/products?limit=5">GET /products?limit=5</option>
              <option value="/api/v1/search?q=samsung&limit=5">GET /search?q=samsung</option>
              <option value="/api/v1/categories">GET /categories</option>
              <option value="/api/v1/deals?limit=5">GET /deals?limit=5</option>
            </select>
          </div>
        </div>
        <button onclick="docsTry()" class="bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold px-5 py-2.5 rounded-xl transition-all">
          ▶ Executar
        </button>
        <div id="docs-result" class="hidden">
          <p class="text-xs font-bold text-slate-400 uppercase tracking-wide mb-2">Resposta</p>
          <pre id="docs-result-pre" class="bg-slate-900 text-green-400 rounded-xl p-4 text-xs max-h-80 overflow-auto"></pre>
        </div>
      </div>
    </section>

    <!-- Footer -->
    <footer class="text-center text-sm text-slate-400 py-8 border-t border-slate-200">
      <p>KainowRadar API v1 — <a href="/" class="text-blue-500 hover:underline">kainowradar.com.br</a></p>
      <p class="mt-1">Dúvidas? Acesse o painel admin ou entre em contato.</p>
    </footer>

  </div>

  <script>
    async function docsTry() {
      const key = document.getElementById('docs-apikey').value.trim()
      const ep  = document.getElementById('docs-endpoint').value
      const resEl  = document.getElementById('docs-result')
      const preEl  = document.getElementById('docs-result-pre')
      if (!key) { alert('Informe sua API Key'); return }
      preEl.textContent = 'Carregando...'
      resEl.classList.remove('hidden')
      try {
        const r = await fetch(ep, { headers: { 'X-API-Key': key } })
        const data = await r.json()
        preEl.textContent = JSON.stringify(data, null, 2)
      } catch(e) {
        preEl.textContent = 'Erro: ' + e.message
      }
    }
  </script>
</body>
</html>`
}


// ── Cron Triggers (Cloudflare Scheduled Events) ─────────────
// Executa automaticamente conforme schedule no wrangler.jsonc
export default {
  fetch: app.fetch.bind(app),

  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    const { DB, CACHE } = env
    const mlAppId  = (env as any).ML_APP_ID || ''
    const mlSecret = (env as any).ML_SECRET  || ''

    console.log(`[CRON] Disparado — ${new Date().toISOString()} — cron: ${event.cron}`)

    // ── 1. Scraper MercadoLivre ──────────────────────────────
    try {
      const { runMLPriceScraper } = await import('./lib/mlScraper')
      const stats = await runMLPriceScraper(DB, CACHE, mlAppId, mlSecret)

      console.log(
        `[CRON/ML] Concluído — total: ${stats.total} | ` +
        `atualizados: ${stats.updated} | pulados: ${stats.skipped} | ` +
        `erros: ${stats.errors} | ${stats.duration_ms}ms`
      )

      await CACHE.put('cron_last_run', JSON.stringify({
        ran_at: new Date().toISOString(),
        cron:   event.cron,
        stats,
      }), { expirationTtl: 86400 * 7 }).catch(() => {})

    } catch (e: any) {
      console.error('[CRON/ML] Erro:', e?.message || e)
      await CACHE.put('cron_last_error', JSON.stringify({
        error_at: new Date().toISOString(),
        message:  e?.message || String(e),
      }), { expirationTtl: 86400 }).catch(() => {})
    }

    // ── 2. Refresh Shopee — API GraphQL + fallback HTML ───────
    // A Shopee Afiliados tem uma API GraphQL pública:
    //   URL: https://open-api.affiliate.shopee.com.br/graphql
    //   Auth: SHA256(AppId + Timestamp + Payload + Secret)
    //   Endpoint productOfferV2(itemId: X) → priceMin, imageUrl, offerLink
    // Credenciais ficam em api_configs WHERE id = 'shopee-afiliados'
    // Se não houver credenciais, faz fallback para facebookexternalhit + JSON-LD
    try {
      await runShopeeRefreshCron(DB, CACHE)
    } catch (e: any) {
      console.error('[CRON/SHOPEE] Erro:', e?.message || e)
      await CACHE.put('cron_shopee_error', JSON.stringify({
        error_at: new Date().toISOString(),
        message:  e?.message || String(e),
      }), { expirationTtl: 86400 }).catch(() => {})
    }
  },
}

// ─────────────────────────────────────────────────────────────
// runShopeeRefreshCron — atualiza preço/imagem/link de todas as
// offers Shopee com shopee_product_url preenchida.
//
// Estratégia (em ordem de prioridade):
//   1. API GraphQL Shopee Afiliados (productOfferV2 por itemId)
//      → retorna priceMin/Max real, imageUrl CDN, offerLink curto
//   2. Fallback: facebookexternalhit UA + JSON-LD no HTML
//      → retorna price via <script ld+json>, og:image, og:title
// ─────────────────────────────────────────────────────────────
async function runShopeeRefreshCron(DB: D1Database, CACHE: KVNamespace): Promise<void> {
  const t0 = Date.now()

  // Busca até 50 offers Shopee ativas com shopee_product_url (as mais antigas primeiro)
  const { results: offers } = await DB.prepare(`
    SELECT o.id, o.external_id, o.external_sku, o.shopee_product_url, o.price, o.product_id, o.affiliate_url
    FROM   offers o
    WHERE  o.store_id = 4
      AND  o.is_active = 1
      AND  o.shopee_product_url IS NOT NULL
    ORDER  BY o.last_updated ASC
    LIMIT  50
  `).all<any>()

  if (!offers || offers.length === 0) {
    console.log('[CRON/SHOPEE] Nenhuma offer Shopee com shopee_product_url para atualizar.')
    return
  }

  // Tenta carregar credenciais da API GraphQL Shopee Afiliados
  const cfg = await DB.prepare(
    `SELECT api_key, extra_json FROM api_configs WHERE id = 'shopee-afiliados'`
  ).first<any>().catch(() => null)

  const shopeeAppId  = cfg?.api_key || ''
  const shopeeSecret = cfg ? (JSON.parse(cfg.extra_json || '{}').secret || '') : ''
  const useGraphQL   = !!(shopeeAppId && shopeeSecret)

  console.log(`[CRON/SHOPEE] ${offers.length} offers | GraphQL: ${useGraphQL ? 'SIM (API)' : 'NÃO (fallback HTML)'}`)

  let updated = 0, failed = 0, nodata = 0

  // Processa em batches de 5 para não sobrecarregar
  const BATCH = 5
  for (let i = 0; i < offers.length; i += BATCH) {
    const batch = offers.slice(i, i + BATCH)

    await Promise.all(batch.map(async (offer: any) => {
      try {
        let price: number | null = null
        let image: string | null = null
        let title: string | null = null
        let newAffiliateUrl: string | null = null

        // ── Tentativa 1: API GraphQL Shopee Afiliados ──────────
        if (useGraphQL && offer.external_id) {
          const gqlResult = await fetchShopeeProductViaGraphQL(
            shopeeAppId, shopeeSecret, offer.external_id
          )
          price          = gqlResult.price
          image          = gqlResult.image
          title          = gqlResult.title
          newAffiliateUrl = gqlResult.offerLink  // link curto afiliado gerado pela API
        }

        // ── Tentativa 2: API interna Shopee (shop_id + item_id) — sem auth ──
        if (price === null && offer.external_id && offer.external_sku) {
          const apiResult = await fetchShopeeProductViaAPI(offer.external_sku, offer.external_id)
          if (apiResult.price !== null) price = apiResult.price
          if (image === null) image = apiResult.image
          if (title === null) title = apiResult.title
        }

        // ── Tentativa 3: HTML (apenas imagem/título, sem preço) ──
        if ((image === null || title === null) && offer.shopee_product_url) {
          const htmlResult = await fetchShopeeProductViaHTML(offer.shopee_product_url)
          if (image === null) image = htmlResult.image
          if (title === null) title = htmlResult.title
        }

        if (price === null) {
          nodata++
          console.warn(`[CRON/SHOPEE] Sem dados — oid=${offer.id} url=${offer.shopee_product_url}`)
          return
        }

        // Atualiza offer (preço + imagem + título + link afiliado se renovado)
        await DB.prepare(`
          UPDATE offers
          SET price        = COALESCE(?, price),
              image_url    = COALESCE(?, image_url),
              title        = COALESCE(?, title),
              affiliate_url = COALESCE(?, affiliate_url),
              last_updated = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(price, image, title, newAffiliateUrl, offer.id).run()

        // Atualiza produto (best_price e imagem se melhorou)
        if (price !== null) {
          await DB.prepare(`
            UPDATE products
            SET best_price = COALESCE(?, best_price),
                image_url  = COALESCE(?, image_url),
                name       = COALESCE(?, name)
            WHERE id = ? AND (best_price IS NULL OR ? <= best_price)
          `).bind(price, image, title, offer.product_id, price).run()
        }

        updated++
        console.log(`[CRON/SHOPEE] OK oid=${offer.id} preço=R$${price} img=${!!image}`)

      } catch (e: any) {
        failed++
        console.error(`[CRON/SHOPEE] Erro oid=${offer.id}: ${e?.message}`)
      }
    }))

    // Pausa entre batches para não sobrecarregar
    if (i + BATCH < offers.length) {
      await new Promise(res => setTimeout(res, 600))
    }
  }

  const duration = Date.now() - t0
  const logData = {
    ran_at:   new Date().toISOString(),
    total:    offers.length,
    updated,
    failed,
    nodata,
    graphql:  useGraphQL,
    duration_ms: duration,
  }

  console.log(`[CRON/SHOPEE] Finalizado — ${JSON.stringify(logData)}`)
  await CACHE.put('cron_shopee_last_run', JSON.stringify(logData), { expirationTtl: 86400 * 7 }).catch(() => {})
}

// ─────────────────────────────────────────────────────────────
// fetchShopeeProductViaGraphQL — busca dados reais de um produto
// via API GraphQL Shopee Afiliados (open-api.affiliate.shopee.com.br)
//
// Documentação (não oficial): https://www.affiliateshopee.com.br/documentacao
//   Query: productOfferV2(itemId: Int) → priceMin, priceMax, imageUrl, offerLink, productName
//   Auth: Authorization: SHA256 Credential={AppId}, Timestamp={Timestamp}, Signature={Sig}
//   Sig = SHA256(AppId + Timestamp + Payload + Secret)  — tudo concatenado sem separador
// ─────────────────────────────────────────────────────────────
async function fetchShopeeProductViaGraphQL(
  appId: string,
  secret: string,
  itemId: string
): Promise<{ price: number | null; image: string | null; title: string | null; offerLink: string | null }> {
  try {
    const timestamp = Math.floor(Date.now() / 1000)
    const query = `{ productOfferV2(itemId: ${itemId}, page: 1, limit: 1) { nodes { itemId productName imageUrl priceMin priceMax offerLink ratingStar } } }`
    const payload = JSON.stringify({ query })

    // Calcula assinatura SHA256(appId + timestamp + payload + secret)
    const sigInput = appId + String(timestamp) + payload + secret
    const sigBuf   = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sigInput))
    const signature = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, '0')).join('')

    const res = await fetch('https://open-api.affiliate.shopee.com.br/graphql', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`,
      },
      body: payload,
    })

    if (!res.ok) {
      console.warn(`[SHOPEE/GraphQL] HTTP ${res.status} para itemId=${itemId}`)
      return { price: null, image: null, title: null, offerLink: null }
    }

    const json: any = await res.json()
    const nodes = json?.data?.productOfferV2?.nodes
    if (!Array.isArray(nodes) || nodes.length === 0) {
      console.warn(`[SHOPEE/GraphQL] Sem nodes para itemId=${itemId} — errors: ${JSON.stringify(json?.errors)}`)
      return { price: null, image: null, title: null, offerLink: null }
    }

    const node = nodes[0]
    // priceMin e priceMax vêm como strings "XX.XX" ou números
    const rawPrice = node.priceMin ?? node.priceMax ?? null
    let price: number | null = null
    if (rawPrice !== null && rawPrice !== undefined) {
      const v = parseFloat(String(rawPrice).replace(',', '.'))
      if (!isNaN(v) && v > 0) price = v
    }

    return {
      price,
      image:     node.imageUrl    || null,
      title:     node.productName || null,
      offerLink: node.offerLink   || null,   // link curto afiliado ex: https://shope.ee/xxx
    }
  } catch (e: any) {
    console.error(`[SHOPEE/GraphQL] Exceção itemId=${itemId}: ${e?.message}`)
    return { price: null, image: null, title: null, offerLink: null }
  }
}

// ─────────────────────────────────────────────────────────────
// fetchShopeeProductViaAPI — busca preço real via API interna da Shopee
// Endpoint: /api/v4/pdp/get_pc?shop_id=X&item_id=Y
// Funciona do Cloudflare edge (IP brasileiro) sem autenticação.
// Preço retornado em centavos × 100000 (ex: 2990000 = R$29,90)
// ─────────────────────────────────────────────────────────────
async function fetchShopeeProductViaAPI(
  shopId: string,
  itemId: string
): Promise<{ price: number | null; image: string | null; title: string | null }> {
  try {
    const r = await fetch(
      `https://shopee.com.br/api/v4/pdp/get_pc?shop_id=${shopId}&item_id=${itemId}`,
      {
        headers: {
          'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept':       'application/json',
          'Referer':      `https://shopee.com.br/product/${shopId}/${itemId}`,
          'X-API-SOURCE': 'pc',
        },
      }
    )
    if (!r.ok) return { price: null, image: null, title: null }
    const d: any = await r.json()
    if (d.error && d.error !== 0) return { price: null, image: null, title: null }

    const item = d?.data?.item ?? d?.item ?? {}
    // Preço em centavos × 100000
    const rawPrice = item.price_min ?? item.price ?? null
    let price: number | null = null
    if (rawPrice !== null) {
      const v = Number(rawPrice) / 100000
      if (v > 0 && v < 1_000_000) price = Math.round(v * 100) / 100
    }

    let image: string | null = null
    const imgField = item.image ?? (item.images ?? [])[0] ?? null
    if (imgField) {
      image = String(imgField).startsWith('http')
        ? String(imgField)
        : `https://down-br.img.susercontent.com/file/${imgField}`
    }

    return { price, image, title: item.name ?? null }
  } catch {
    return { price: null, image: null, title: null }
  }
}

// ─────────────────────────────────────────────────────────────
// fetchShopeeProductViaHTML — fallback apenas para imagem e título.
// A Shopee NÃO inclui preço real no HTML server-side (SSR).
// O que aparece como "R$X" no HTML é o valor do FRETE, não do produto.
// ─────────────────────────────────────────────────────────────
async function fetchShopeeProductViaHTML(
  productUrl: string
): Promise<{ price: number | null; image: string | null; title: string | null }> {
  try {
    const r = await fetch(productUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent':      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'Accept':          'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
    })
    if (!r.ok) return { price: null, image: null, title: null }
    const html = await r.text()

    let image: string | null = null
    let title: string | null = null

    // og:title
    const tm = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
            ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)
    if (tm) title = tm[1].replace(/\s*\|\s*Shopee.*$/i, '').trim()

    // og:image
    const im = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
            ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
    if (im) image = im[1].trim()

    // NUNCA tentar pegar preço do HTML — é sempre o frete (R$7-10)
    return { price: null, image, title }
  } catch {
    return { price: null, image: null, title: null }
  }
}
