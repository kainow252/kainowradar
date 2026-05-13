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
// Quando o usuário clica em "Ir à loja", passa por aqui:
// 1. Registra click_event para analytics
// 2. Lê affiliate_url da oferta (gerado na importação)
// 3. Redireciona com 302 para o destino final
// URL pública: /go/123  (onde 123 = offer.id no banco)
app.get('/go/:id', async (c) => {
  const { DB } = c.env
  const offerId = parseInt(c.req.param('id') || '0')
  if (!offerId || isNaN(offerId)) return c.redirect('/', 302)

  // Busca oferta com dados da loja e produto
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
        .then(b => Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2,'0')).join(''))
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
  ).run().catch(() => {}) // ignora erro — não bloqueia o redirect

  // ── Determina URL de destino ─────────────────────────────
  // Prioridade:
  //  1. affiliate_url salva na oferta (gerado no import)
  //  2. Fallback dinâmico: reconstrói link afiliado via affiliate_rules
  //  3. product_url (URL direta sem tracking)
  //  4. Homepage
  let dest = offer.affiliate_url || ''

  // Fallback dinâmico: se affiliate_url está vazio, tenta reconstruir
  // usando a rede de afiliado da loja + regra cadastrada no banco
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
        // Para Buscapé: usa o redirect /lead?oid= como URL base
        const trackingBase = (offer.source === 'buscape' && offer.buscape_oid)
          ? `https://www.buscape.com.br/lead?oid=${offer.buscape_oid}&channel=11`
          : baseUrl

        dest = rule.link_template
          .replace('{url}',   encodeURIComponent(trackingBase))
          .replace('{pub}',   pubId)
          .replace('{extra}', rule.extra_param ?? '')
      } else if (offer.source === 'buscape' && offer.buscape_oid) {
        // Sem regra de afiliado configurada: usa redirect Buscapé direto
        dest = `https://www.buscape.com.br/lead?oid=${offer.buscape_oid}&channel=11`
      } else {
        dest = baseUrl
      }
    } catch {
      dest = offer.product_url || '/'
    }
  }

  if (!dest) dest = offer.product_url || '/'

  // Garante que a URL é absoluta
  if (dest && !dest.startsWith('http')) dest = '/' + dest

  return c.redirect(dest, 302)
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
      WHERE p.is_active = 1 AND p.best_price IS NOT NULL
        AND p.image_url NOT LIKE '%unsplash%'
      ORDER BY p.created_at DESC, p.offer_count DESC LIMIT 8
    `).all(),
    DB.prepare(`
      SELECT p.*, s.name as best_store_name,
             COALESCE(o.discount_percent, 0) as top_discount
      FROM products p
      LEFT JOIN stores s ON s.id = p.best_store_id
      LEFT JOIN offers o ON o.product_id = p.id AND o.store_id = p.best_store_id AND o.is_active = 1
      WHERE p.is_active = 1 AND p.best_price IS NOT NULL AND p.offer_count > 0
      ORDER BY COALESCE(o.discount_percent, 0) DESC, p.created_at DESC LIMIT 8
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

  // ── Auto Price Sync ────────────────────────────────────────────────────
  // Dispara sync de preços ML em background a cada ~6h (sem cron externo).
  // Usa KV para throttle: só roda se último sync foi há mais de 6h.
  // Não bloqueia a resposta ao usuário (waitUntil).
  const priceSyncKV   = c.env.CACHE as KVNamespace | undefined
  const lastPriceSync = await priceSyncKV?.get('price_sync_last_run').catch(() => null)
  const priceSyncAge  = lastPriceSync ? Date.now() - parseInt(lastPriceSync) : Infinity
  const SIX_HOURS_MS  = 6 * 60 * 60 * 1000

  if (priceSyncAge > SIX_HOURS_MS) {
    c.executionCtx.waitUntil(
      fetch(`${proto}://${host}/admin/api/price-sync/run`, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${(c.env as any).ADMIN_SECRET || ''}`,
        },
        body: JSON.stringify({ limit: 60 }),
      }).catch(() => {/* silencioso */})
    )
  }
  // ──────────────────────────────────────────────────────────────────────

  // Extrai slots editoriais por nome
  const eBannerMain = editorials.find((e: any) => e.slot === 'banner_main')
  const eBannerSec1 = editorials.find((e: any) => e.slot === 'banner_sec1')
  const eBannerSec2 = editorials.find((e: any) => e.slot === 'banner_sec2')
  const eInsights   = editorials.filter((e: any) => e.type === 'insight')

  // Logos SVG inline por slug — 100% confiáveis, sem depender de URL externa
  const STORE_LOGO_SVG: Record<string, string> = {
    'mercadolivre': `<svg viewBox="0 0 120 40" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><rect width="120" height="40" rx="6" fill="#FFE600"/><text x="60" y="27" font-family="Arial,sans-serif" font-size="11" font-weight="900" fill="#333" text-anchor="middle">Mercado</text><text x="60" y="38" font-family="Arial,sans-serif" font-size="9" font-weight="700" fill="#333" text-anchor="middle">Livre</text></svg>`,
    'amazon':       `<svg viewBox="0 0 100 36" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><text x="50" y="22" font-family="Arial,sans-serif" font-size="18" font-weight="900" fill="#FF9900" text-anchor="middle">amazon</text><path d="M20 28 Q50 36 80 28" stroke="#FF9900" stroke-width="2.5" fill="none" stroke-linecap="round"/></svg>`,
    'magalu':       `<svg viewBox="0 0 80 36" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><rect width="80" height="36" rx="6" fill="#0086FF"/><text x="40" y="24" font-family="Arial,sans-serif" font-size="13" font-weight="900" fill="#fff" text-anchor="middle">magalu</text></svg>`,
    'shopee':       `<svg viewBox="0 0 80 36" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><rect width="80" height="36" rx="6" fill="#EE4D2D"/><text x="40" y="24" font-family="Arial,sans-serif" font-size="12" font-weight="900" fill="#fff" text-anchor="middle">shopee</text></svg>`,
    'americanas':   `<svg viewBox="0 0 100 36" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="36" rx="6" fill="#E60014"/><text x="50" y="24" font-family="Arial,sans-serif" font-size="10" font-weight="900" fill="#fff" text-anchor="middle">americanas</text></svg>`,
    'casasbahia':   `<svg viewBox="0 0 100 36" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="36" rx="6" fill="#0057A8"/><text x="50" y="15" font-family="Arial,sans-serif" font-size="9" font-weight="900" fill="#fff" text-anchor="middle">Casas</text><text x="50" y="28" font-family="Arial,sans-serif" font-size="9" font-weight="900" fill="#FFD700" text-anchor="middle">Bahia</text></svg>`,
    'kabum':        `<svg viewBox="0 0 80 36" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><rect width="80" height="36" rx="6" fill="#F47920"/><text x="40" y="24" font-family="Arial,sans-serif" font-size="13" font-weight="900" fill="#fff" text-anchor="middle">KaBuM!</text></svg>`,
    'aliexpress':   `<svg viewBox="0 0 100 36" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="36" rx="6" fill="#FF6600"/><text x="50" y="24" font-family="Arial,sans-serif" font-size="10" font-weight="900" fill="#fff" text-anchor="middle">AliExpress</text></svg>`,
    'submarino':    `<svg viewBox="0 0 100 36" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="36" rx="6" fill="#0057A8"/><text x="50" y="24" font-family="Arial,sans-serif" font-size="10" font-weight="900" fill="#fff" text-anchor="middle">submarino</text></svg>`,
    'netshoes':     `<svg viewBox="0 0 100 36" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="36" rx="6" fill="#003DA5"/><text x="50" y="24" font-family="Arial,sans-serif" font-size="10" font-weight="900" fill="#fff" text-anchor="middle">netshoes</text></svg>`,
    'pichau':       `<svg viewBox="0 0 80 36" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><rect width="80" height="36" rx="6" fill="#1a1a2e"/><text x="40" y="24" font-family="Arial,sans-serif" font-size="12" font-weight="900" fill="#00CFFF" text-anchor="middle">pichau</text></svg>`,
    'terabyte':     `<svg viewBox="0 0 100 36" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="36" rx="6" fill="#e60000"/><text x="50" y="24" font-family="Arial,sans-serif" font-size="10" font-weight="900" fill="#fff" text-anchor="middle">Terabyte</text></svg>`,
    'fastshop':     `<svg viewBox="0 0 100 36" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="36" rx="6" fill="#00843D"/><text x="50" y="24" font-family="Arial,sans-serif" font-size="10" font-weight="900" fill="#fff" text-anchor="middle">Fast Shop</text></svg>`,
    'carrefour':    `<svg viewBox="0 0 100 36" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="36" rx="6" fill="#0066CC"/><text x="50" y="24" font-family="Arial,sans-serif" font-size="10" font-weight="900" fill="#fff" text-anchor="middle">Carrefour</text></svg>`,
    'extra':        `<svg viewBox="0 0 80 36" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><rect width="80" height="36" rx="6" fill="#E30613"/><text x="40" y="24" font-family="Arial,sans-serif" font-size="14" font-weight="900" fill="#fff" text-anchor="middle">extra</text></svg>`,
    'pontofrio':    `<svg viewBox="0 0 100 36" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="36" rx="6" fill="#00AAFF"/><text x="50" y="15" font-family="Arial,sans-serif" font-size="9" font-weight="900" fill="#fff" text-anchor="middle">Ponto</text><text x="50" y="28" font-family="Arial,sans-serif" font-size="9" font-weight="900" fill="#fff" text-anchor="middle">Frio</text></svg>`,
    'centauro':     `<svg viewBox="0 0 100 36" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="36" rx="6" fill="#FF6B00"/><text x="50" y="24" font-family="Arial,sans-serif" font-size="11" font-weight="900" fill="#fff" text-anchor="middle">centauro</text></svg>`,
    'dafiti':       `<svg viewBox="0 0 80 36" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><rect width="80" height="36" rx="6" fill="#5C068C"/><text x="40" y="24" font-family="Arial,sans-serif" font-size="12" font-weight="900" fill="#fff" text-anchor="middle">dafiti</text></svg>`,
    'shein':        `<svg viewBox="0 0 80 36" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><rect width="80" height="36" rx="6" fill="#000"/><text x="40" y="24" font-family="Arial,sans-serif" font-size="13" font-weight="900" fill="#fff" text-anchor="middle">SHEIN</text></svg>`,
    'renner':       `<svg viewBox="0 0 80 36" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><rect width="80" height="36" rx="6" fill="#E30613"/><text x="40" y="24" font-family="Arial,sans-serif" font-size="12" font-weight="900" fill="#fff" text-anchor="middle">renner</text></svg>`,
    'riachuelo':    `<svg viewBox="0 0 100 36" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="36" rx="6" fill="#E30613"/><text x="50" y="24" font-family="Arial,sans-serif" font-size="10" font-weight="900" fill="#fff" text-anchor="middle">riachuelo</text></svg>`,
    'leroy':        `<svg viewBox="0 0 100 36" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="36" rx="6" fill="#00843D"/><text x="50" y="15" font-family="Arial,sans-serif" font-size="8" font-weight="900" fill="#fff" text-anchor="middle">Leroy</text><text x="50" y="28" font-family="Arial,sans-serif" font-size="8" font-weight="900" fill="#fff" text-anchor="middle">Merlin</text></svg>`,
    'madeiramadeira': `<svg viewBox="0 0 100 36" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="36" rx="6" fill="#00833E"/><text x="50" y="15" font-family="Arial,sans-serif" font-size="8" font-weight="900" fill="#fff" text-anchor="middle">Madeira</text><text x="50" y="28" font-family="Arial,sans-serif" font-size="8" font-weight="900" fill="#fff" text-anchor="middle">Madeira</text></svg>`,
    'havan':        `<svg viewBox="0 0 80 36" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><rect width="80" height="36" rx="6" fill="#0057A8"/><text x="40" y="24" font-family="Arial,sans-serif" font-size="13" font-weight="900" fill="#FFD700" text-anchor="middle">havan</text></svg>`,
    'tok_stok':     `<svg viewBox="0 0 100 36" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="36" rx="6" fill="#E63329"/><text x="50" y="24" font-family="Arial,sans-serif" font-size="10" font-weight="900" fill="#fff" text-anchor="middle">Tok&amp;Stok</text></svg>`,
    'samsung':      `<svg viewBox="0 0 100 36" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="36" rx="6" fill="#1428A0"/><text x="50" y="24" font-family="Arial,sans-serif" font-size="11" font-weight="900" fill="#fff" text-anchor="middle">SAMSUNG</text></svg>`,
    'apple':        `<svg viewBox="0 0 80 36" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><rect width="80" height="36" rx="6" fill="#555"/><text x="40" y="24" font-family="Arial,sans-serif" font-size="12" font-weight="900" fill="#fff" text-anchor="middle"> Apple</text></svg>`,
    'zattini':      `<svg viewBox="0 0 80 36" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><rect width="80" height="36" rx="6" fill="#1a1a1a"/><text x="40" y="24" font-family="Arial,sans-serif" font-size="12" font-weight="900" fill="#fff" text-anchor="middle">zattini</text></svg>`,
    'hotmart':      `<svg viewBox="0 0 80 36" class="w-10 h-7 object-contain" xmlns="http://www.w3.org/2000/svg"><rect width="80" height="36" rx="6" fill="#FF4D0D"/><text x="40" y="24" font-family="Arial,sans-serif" font-size="11" font-weight="900" fill="#fff" text-anchor="middle">hotmart</text></svg>`,
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
    const logoSvg = STORE_LOGO_SVG[s.slug] || null
    return { ...s, color, bg, text, initial, logoSvg }
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
    <a href="/categoria/${s.slug}"
       class="store-pill-card flex-shrink-0 flex flex-col items-center gap-1.5 w-20 cursor-pointer group"
       title="Comparar preços na ${s.name}">
      <div class="store-logo-circle w-14 h-14 rounded-2xl flex items-center justify-center border-2 shadow-sm transition-all duration-200 group-hover:scale-110 group-hover:shadow-md overflow-hidden"
           style="background:${s.bg}; border-color:${s.color};">
        ${s.logoSvg
          ? s.logoSvg
          : `<span class="font-black text-base leading-none" style="color:${s.color}">${s.initial}</span>`
        }
      </div>
      <span class="text-xs text-gray-600 font-semibold text-center leading-tight w-full truncate group-hover:text-gray-900 transition-colors">${s.name}</span>
      <span class="text-[10px] font-bold px-1.5 py-0.5 rounded-full" style="color:${s.color}; background:${s.bg}">${s.text}</span>
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

      <!-- Marquee — única linha, esquerda para direita -->
      <div id="stores-marquee-section" class="stores-marquee-wrapper relative mb-4">
        <div class="stores-marquee-fade-left"></div>
        <div class="stores-marquee-fade-right"></div>
        <div class="stores-marquee" style="animation-duration:${Math.max(30, stores.length * 1.8)}s">
          <div class="stores-marquee-track flex gap-4 px-4 py-2">
            ${storeCards(stores)}
            ${storeCards(stores)}
          </div>
        </div>
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
    const appId  = (env as any).ML_APP_ID || ''
    const secret = (env as any).ML_SECRET  || ''

    console.log(`[CRON] Iniciando scraper ML — ${new Date().toISOString()} — cron: ${event.cron}`)

    try {
      const { runMLPriceScraper } = await import('./lib/mlScraper')
      const stats = await runMLPriceScraper(DB, CACHE, appId, secret)

      console.log(
        `[CRON] Scraper concluído — total: ${stats.total} | ` +
        `atualizados: ${stats.updated} | pulados: ${stats.skipped} | ` +
        `erros: ${stats.errors} | ${stats.duration_ms}ms`
      )

      // Salva log do último cron no KV
      await CACHE.put('cron_last_run', JSON.stringify({
        ran_at: new Date().toISOString(),
        cron:   event.cron,
        stats,
      }), { expirationTtl: 86400 * 7 }).catch(() => {})

    } catch (e: any) {
      console.error('[CRON] Erro no scraper ML:', e?.message || e)
      await CACHE.put('cron_last_error', JSON.stringify({
        error_at: new Date().toISOString(),
        message:  e?.message || String(e),
      }), { expirationTtl: 86400 }).catch(() => {})
    }
  },
}
