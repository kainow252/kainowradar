// ============================================================
// ROUTES: Mercado Livre — OAuth2, Webhook, Bot de Importação
// APP ID: 3098423019766450
// Publisher ID (Afiliados): cfegdhabc31955
// ============================================================
//
// ESTRATÉGIA DE IMPORTAÇÃO:
//  - /sites/MLB/search está bloqueado (403) para apps em modo legacy/test
//  - /items/{id} ✅ funciona com token válido
//  - Dois modos de importação:
//    1. Via URL de produto: o usuário cola URLs do ML (painel de afiliados, browser, etc.)
//       → extrai o ID do item da URL → busca /items/{id} → salva no D1
//    2. Via seedIds por categoria: IDs reais manutenidos no código
//       → busca /items/{ids} multi-get (até 20 por requisição) → salva no D1
// ============================================================

import { Hono } from 'hono'
import type { Bindings } from '../types'

type MLBindings = Bindings & {
  ML_APP_ID?: string
  ML_SECRET?: string
}

const ml = new Hono<{ Bindings: MLBindings }>()

const PUBLISHER_ID = 'cfegdhabc31955'
const MATT_TOOL    = '38524122'
const ML_API       = 'https://api.mercadolibre.com'
const APP_ID       = '3098423019766450'

// ── Mapa de categorias ML ─────────────────────────────────
// seedIds: IDs reais do ML — use /admin/api/ml/import-url para adicionar mais
// Limpe os IDs inválidos e adicione reais via painel de afiliados do ML
const ML_CATEGORIES: Record<string, {
  mlId: string
  slug: string
  name: string
  seedIds: string[]  // IDs REAIS — adicionados via import-url ou manualmente
}> = {
  smartphones: {
    mlId: 'MLB1051', slug: 'smartphones', name: 'Smartphones',
    seedIds: [],  // Adicione via /admin → Importar ML → "Importar por URL"
  },
  notebooks: {
    mlId: 'MLB1648', slug: 'notebooks', name: 'Notebooks',
    seedIds: [],
  },
  tv: {
    mlId: 'MLB1000', slug: 'tv', name: 'TVs & Smart TVs',
    seedIds: [],
  },
  games: {
    mlId: 'MLB1144', slug: 'games', name: 'Games & Consoles',
    seedIds: [],
  },
  audio: {
    mlId: 'MLB1003', slug: 'audio', name: 'Áudio & Fones',
    seedIds: [],
  },
  cameras: {
    mlId: 'MLB1008', slug: 'cameras', name: 'Câmeras & Drones',
    seedIds: [],
  },
  eletrodomesticos: {
    mlId: 'MLB1574', slug: 'eletrodomesticos', name: 'Eletrodomésticos',
    seedIds: [],
  },
  tablets: {
    mlId: 'MLB1009', slug: 'tablets', name: 'Tablets & iPads',
    seedIds: [],
  },
  informatica: {
    mlId: 'MLB1649', slug: 'informatica', name: 'Informática',
    seedIds: [],
  },
  'moda-calcados': {
    mlId: 'MLB1430', slug: 'moda-calcados', name: 'Moda & Calçados',
    seedIds: [],
  },
}

// ── Helper: Gera slug ─────────────────────────────────────
function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .substring(0, 80)
}

// ── Helper: Detecta se URL é de encurtador ML ───────────
// meli.la/xxxxx, mercadol.iv/xxxxx, etc.
function isShortUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'meli.la' || host === 'mercadol.iv' || host === 'm.me'
  } catch {
    return false
  }
}

// ── Helper: Resolve URL encurtada → URL final (segue redirects) ──
// Usa fetch com redirect:'follow' — o Cloudflare Worker suporta isso
async function resolveShortUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KainowRadar/1.0)' },
    })
    // Após seguir todos os redirects, res.url é a URL final
    return res.url || url
  } catch {
    return url
  }
}

// ── Helper: Extrai MLB ID de uma URL do Mercado Livre ─────
// Suporta formatos reais do ML:
//   MLB3597223513                                        → ID direto
//   https://...mercadolivre.com.br/celular/p/MLB28965210 → product page (/p/)
//   https://produto.mercadolivre.com.br/MLB-3597223513-samsung-_JM → listing
//   https://produto.mercadolivre.com.br/MLB-3635088353-iphone?partner_id=x
//
// IDs do ML têm 8+ dígitos CONTÍNUOS no path (sem hífen separando dígitos).
// URLs com hífen no meio dos dígitos (ex: MLB-4411-4104) são inválidas → null.
function extractMLBId(input: string): string | null {
  const s = input.trim()

  // 1. ID direto (ex: MLB3597223513)
  if (/^MLB\d+$/i.test(s)) return s.toUpperCase()

  // 2. /p/MLBXXXXXXXX — product group page
  const pMatch = s.match(/\/p\/(MLB\d+)/i)
  if (pMatch) return pMatch[1].toUpperCase()

  // 3. /MLB-XXXXXXXXXX-slug — ID contínuo com 8+ dígitos sem hífen no meio
  //    Correto:  /MLB-3597223513-samsung → MLB3597223513
  //    Inválido: /MLB-4411-4104-titulo  → null (dígitos separados por hífen = ID inválido)
  const contMatch = s.match(/\/MLB-?(\d{8,})(?:[^0-9]|$)/i)
  if (contMatch) return 'MLB' + contMatch[1]

  // 4. MLB\d{8,} em qualquer posição (query string, fragmento, etc.)
  const anyMatch = s.match(/\b(MLB\d{8,})\b/i)
  if (anyMatch) return anyMatch[1].toUpperCase()

  return null
}

// ── Helper: Pega token do KV (com auto-refresh) ───────────
async function getStoredToken(env: MLBindings): Promise<string | null> {
  if (!env.CACHE) return null
  try {
    // 1) Token OAuth do usuario (mais permissoes)
    const oauthToken = await env.CACHE.get('ml_access_token')
    if (oauthToken) return oauthToken

    const appId  = env.ML_APP_ID  || APP_ID
    const secret = env.ML_SECRET  || ''

    // 2) Tenta renovar OAuth via refresh_token
    const refreshToken = await env.CACHE.get('ml_refresh_token')
    if (refreshToken && secret) {
      const res = await fetch(ML_API + '/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: new URLSearchParams({
          grant_type:    'refresh_token',
          client_id:     appId,
          client_secret: secret,
          refresh_token: refreshToken,
        }),
      })
      if (res.ok) {
        const data: any = await res.json()
        if (data.access_token) {
          await env.CACHE.put('ml_access_token',  data.access_token,          { expirationTtl: data.expires_in || 21600 })
          await env.CACHE.put('ml_refresh_token', data.refresh_token || '',   { expirationTtl: 86400 * 30 })
          await env.CACHE.put('ml_user_id',       String(data.user_id || ''), { expirationTtl: 86400 * 30 })
          return data.access_token
        }
      }
    }

    // 3) Fallback: client_credentials (ML_APP_ID + ML_SECRET)
    //    Nao precisa de OAuth do usuario. Funciona para:
    //    GET /items/{id}, GET /items?ids=..., GET /sites/MLB/search
    //    Token dura 6h, cacheado em ml_app_token por 5h.
    if (secret) {
      const appToken = await env.CACHE.get('ml_app_token')
      if (appToken) return appToken

      const tokenRes = await fetch(ML_API + '/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: new URLSearchParams({
          grant_type:    'client_credentials',
          client_id:     appId,
          client_secret: secret,
        }),
      })
      if (tokenRes.ok) {
        const td: any = await tokenRes.json()
        if (td.access_token) {
          await env.CACHE.put('ml_app_token', td.access_token, { expirationTtl: 18000 })
          return td.access_token
        }
      }
    }

    return null
  } catch {
    return null
  }
}

// ── Helper: Busca detalhes de um item via /items/{id} ─────
async function fetchMLItem(itemId: string, token: string): Promise<any | null> {
  try {
    const res = await fetch(`${ML_API}/items/${itemId}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/json',
        'User-Agent':    'KainowRadar/1.0',
      },
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// ── Helper: Multi-get de items (até 20 IDs por chamada) ──
// Endpoint: GET /items?ids=MLB1,MLB2,...  ← ✅ funciona com token
async function fetchMLItemsMulti(ids: string[], token: string): Promise<any[]> {
  if (!ids.length) return []
  // ML suporta no máximo 20 IDs por chamada
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += 20) {
    chunks.push(ids.slice(i, i + 20))
  }

  const results: any[] = []
  for (const chunk of chunks) {
    try {
      const url = `${ML_API}/items?ids=${chunk.join(',')}`
      const res = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept':        'application/json',
          'User-Agent':    'KainowRadar/1.0',
        },
      })
      if (!res.ok) continue
      const data: any[] = await res.json()
      // Formato: [{ code: 200, body: { id, title, price, ... } }, ...]
      for (const entry of data) {
        if (entry.code === 200 && entry.body) {
          results.push(entry.body)
        }
      }
    } catch { /* ignora chunk com erro */ }
    // Pausa entre chunks para não throttle
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 100))
  }
  return results
}

// ── Helper: Salva produto no D1 ───────────────────────────
async function saveProductToDB(
  DB: D1Database,
  item: any,
  categorySlug: string,
): Promise<{ id: number | null; action: 'created' | 'updated' | 'skipped' }> {
  try {
    const mlId = item.id
    const name = (item.title || '').trim()
    if (!name || !mlId) return { id: null, action: 'skipped' }

    const brand     = item.attributes?.find((a: any) => a.id === 'BRAND')?.value_name || ''
    const ean       = item.attributes?.find((a: any) => a.id === 'GTIN')?.value_name  || ''
    const slug      = slugify(name)
    const price     = item.price || 0
    // Thumbnail em resolução maior: substitui -I.jpg por -O.jpg
    const image     = (item.thumbnail || '').replace('-I.jpg', '-O.jpg')
    const permalink = item.permalink || ''
    const aff_url   = permalink
      ? `${permalink}?matt_word=${PUBLISHER_ID}&matt_tool=${MATT_TOOL}&forceInApp=true`
      : ''

    // Atualiza se já existe pelo ml_item_id
    const existing = await DB.prepare(
      'SELECT id FROM products WHERE ml_item_id = ?'
    ).bind(mlId).first<{ id: number }>()

    if (existing) {
      await DB.prepare(`
        UPDATE products
        SET best_price = ?, affiliate_url = ?,
            affiliate_updated_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE ml_item_id = ?
      `).bind(price, aff_url, mlId).run()
      return { id: existing.id, action: 'updated' }
    }

    // Garante slug único
    const slugExists = await DB.prepare(
      'SELECT id FROM products WHERE slug = ?'
    ).bind(slug).first<{ id: number }>()
    const finalSlug = slugExists ? `${slug}-${mlId.toLowerCase()}` : slug

    const result = await DB.prepare(`
      INSERT INTO products
        (ean, name, slug, brand, category, subcategory, description,
         image_url, best_price, offer_count, ml_item_id,
         affiliate_url, affiliate_updated_at, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP, 1)
    `).bind(
      ean        || null,
      name,
      finalSlug,
      brand      || null,
      categorySlug,
      categorySlug,
      `${name}${brand ? ' — ' + brand : ''}. Encontrado no Mercado Livre.`,
      image      || null,
      price,
      mlId,
      aff_url,
    ).run()

    return { id: result.meta.last_row_id as number, action: 'created' }
  } catch (e: any) {
    console.error('saveProductToDB error:', e.message)
    return { id: null, action: 'skipped' }
  }
}

// ════════════════════════════════════════════════════════════
// PKCE HELPERS (OAuth2 Authorization Code + PKCE)
// ════════════════════════════════════════════════════════════

function base64urlEncode(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  // code_verifier: 64 bytes aleatórios → base64url (~86 chars, limite ML: 43-128)
  const raw      = crypto.getRandomValues(new Uint8Array(64))
  const verifier = base64urlEncode(raw.buffer as ArrayBuffer)
  // code_challenge: SHA-256 do verifier → base64url
  const encoded  = new TextEncoder().encode(verifier)
  const digest   = await crypto.subtle.digest('SHA-256', encoded)
  const challenge = base64urlEncode(digest)
  return { verifier, challenge }
}

// ════════════════════════════════════════════════════════════
// ROTAS PÚBLICAS
// ════════════════════════════════════════════════════════════

// ── GET /api/ml/auth — Inicia OAuth2 + PKCE ──────────────
ml.get('/auth', async (c) => {
  const appId       = c.env.ML_APP_ID || APP_ID
  const redirectUri = 'https://kainowradar.com.br/api/ml-callback'

  const { verifier, challenge } = await generatePKCE()

  if (c.env.CACHE) {
    await c.env.CACHE.put('ml_pkce_verifier', verifier, { expirationTtl: 600 })
  }

  const url = `https://auth.mercadolivre.com.br/authorization?response_type=code` +
    `&client_id=${appId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&code_challenge=${challenge}` +
    `&code_challenge_method=S256`

  return c.redirect(url)
})

// ── GET /api/ml/callback — fallback (handler real em index.tsx) ──
ml.get('/callback', async (c) => {
  return c.html(`<h2>ℹ️ Use /api/ml-callback (sem /api/ml/)</h2>`)
})

// ── POST /api/ml-webhook — Notificações de preço/estoque ─
ml.post('/webhook', async (c) => {
  const body     = await c.req.json().catch(() => ({}))
  const { DB }   = c.env
  const topic    = (body as any).topic    || ''
  const resource = (body as any).resource || ''

  if (topic === 'items' && resource) {
    const itemId = resource.replace('/items/', '').split('?')[0]
    try {
      const token = await getStoredToken(c.env)
      if (token && itemId) {
        const item = await fetchMLItem(itemId, token)
        if (item) {
          const aff_url = `${item.permalink}?matt_word=${PUBLISHER_ID}&matt_tool=${MATT_TOOL}&forceInApp=true`
          await DB.prepare(`
            UPDATE products
            SET best_price = ?, affiliate_url = ?, affiliate_updated_at = CURRENT_TIMESTAMP
            WHERE ml_item_id = ?
          `).bind(item.price, aff_url, itemId).run()
        }
      }
    } catch {}
  }

  return c.json({ ok: true })
})

// ════════════════════════════════════════════════════════════
// ROTAS ADMIN (auth via middleware do admin.ts)
// ════════════════════════════════════════════════════════════

// ── GET /admin/api/ml/status ──────────────────────────────
ml.get('/status', async (c) => {
  const token  = await c.env.CACHE?.get('ml_access_token').catch(() => null)
  const userId = await c.env.CACHE?.get('ml_user_id').catch(() => null)
  const appId  = c.env.ML_APP_ID || APP_ID

  return c.json({
    connected:    !!token,
    user_id:      userId,
    app_id:       appId,
    publisher_id: PUBLISHER_ID,
    auth_url:     `https://kainowradar.com.br/api/ml/auth`,
    categories:   Object.keys(ML_CATEGORIES),
  })
})

// ── GET /admin/api/ml/token-debug — Diagnóstico completo de token ─
ml.get('/token-debug', async (c) => {
  const appId     = (c.env as any).ML_APP_ID || APP_ID
  const secret    = (c.env as any).ML_SECRET || ''
  const oauthKV   = await c.env.CACHE?.get('ml_access_token').catch(() => null)
  const appToken  = await c.env.CACHE?.get('ml_app_token').catch(() => null)
  const refreshKV = await c.env.CACHE?.get('ml_refresh_token').catch(() => null)

  // Limpa ml_app_token cacheado para forçar uso do OAuth neste teste
  if (appToken) await c.env.CACHE?.delete('ml_app_token').catch(() => {})

  // Produto de teste: Perfume Riiffs (já existe no banco)
  const TEST_ITEM_ID = 'MLB24045332'

  // Testa token OAuth: /items/{id} (estratégia do scraper v3)
  let oauthTest: any = null
  if (oauthKV) {
    const headers = { 'Authorization': 'Bearer ' + oauthKV }
    const r1 = await fetch(`${ML_API}/items/${TEST_ITEM_ID}?attributes=id,title,price,status`, { headers })
    const b1: any = await r1.json().catch(() => null)
    oauthTest = {
      item_id:     TEST_ITEM_ID,
      item_status: r1.status,
      item_title:  b1?.title?.substring(0, 60) || null,
      item_price:  b1?.price || null,
      item_error:  r1.ok ? null : (b1?.message || b1?.error || `HTTP ${r1.status}`),
      note:        r1.ok
        ? '✅ OAuth funciona para /items/{id} — scraper deve atualizar preços'
        : (r1.status === 403
          ? '❌ 403: token expirado ou sem permissão. Acesse /api/ml/auth para renovar'
          : `❌ HTTP ${r1.status}: ${b1?.message || 'erro desconhecido'}`),
    }
  }

  // Testa client_credentials: /items/{id} (sem OAuth do usuário)
  let ccTest: any = null
  if (secret) {
    const tr = await fetch(ML_API + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: appId, client_secret: secret }),
    })
    const td: any = await tr.json().catch(() => null)
    if (td?.access_token) {
      const headers = { 'Authorization': 'Bearer ' + td.access_token }
      const r1 = await fetch(`${ML_API}/items/${TEST_ITEM_ID}?attributes=id,title,price,status`, { headers })
      const b1: any = await r1.json().catch(() => null)
      ccTest = {
        token_status: tr.status,
        item_id:      TEST_ITEM_ID,
        item_status:  r1.status,
        item_title:   b1?.title?.substring(0, 60) || null,
        item_price:   b1?.price || null,
        item_error:   r1.ok ? null : (b1?.message || b1?.error || `HTTP ${r1.status}`),
        note:         r1.ok
          ? '✅ client_credentials funciona para /items/{id}'
          : `❌ HTTP ${r1.status}: ${b1?.message || b1?.error || 'erro desconhecido'}`,
      }
    } else {
      ccTest = { token_status: tr.status, error: td?.message || td?.error || 'falha ao obter token CC' }
    }
  }

  // Testa refresh_token (renova silenciosamente sem redirect)
  let refreshTest: any = null
  if (refreshKV && secret) {
    const tr = await fetch(ML_API + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', client_id: appId,
        client_secret: secret, refresh_token: refreshKV,
      }),
    })
    const td: any = await tr.json().catch(() => null)
    if (td?.access_token) {
      // Salva novo token
      await c.env.CACHE?.put('ml_access_token', td.access_token, { expirationTtl: td.expires_in || 21600 }).catch(() => {})
      if (td.refresh_token) {
        await c.env.CACHE?.put('ml_refresh_token', td.refresh_token, { expirationTtl: 86400 * 30 }).catch(() => {})
      }
      refreshTest = {
        status:      tr.status,
        renewed:     true,
        expires_in:  td.expires_in,
        note:        '✅ Token renovado via refresh_token e salvo no KV',
      }
    } else {
      refreshTest = {
        status:  tr.status,
        renewed: false,
        error:   td?.message || td?.error || 'falha ao renovar',
        note:    tr.status === 400
          ? '❌ refresh_token expirado ou inválido — precisa de novo OAuth em /api/ml/auth'
          : `❌ HTTP ${tr.status}: ${td?.message || 'erro desconhecido'}`,
      }
    }
  }

  return c.json({
    // Estado do KV
    has_oauth_kv:        !!oauthKV,
    has_refresh_kv:      !!refreshKV,
    has_secret:          !!secret,
    app_token_cleared:   !!appToken,
    // Resultados dos testes
    oauth_test:          oauthTest,
    cc_test:             ccTest,
    refresh_test:        refreshTest,
    // Diagnóstico geral
    diagnosis: !oauthKV && !refreshKV
      ? '⚠️ Sem token OAuth — acesse /api/ml/auth no browser para autorizar'
      : refreshTest?.renewed
        ? '✅ Token renovado — rode /admin/api/cron/run para atualizar preços'
        : oauthTest?.item_status === 200
          ? '✅ Token OK — rode /admin/api/cron/run para atualizar preços'
          : '⚠️ Token pode estar expirado — acesse /api/ml/auth para renovar',
    auth_url: 'https://kainowradar.com.br/api/ml/auth',
  })
})

// ── GET /admin/api/ml/search-debug — Testa busca diretamente do Worker ─
ml.get('/search-debug', async (c) => {
  const q     = (c.req.query('q') || 'Samsung Galaxy').trim()
  const token = await getStoredToken(c.env).catch(() => null)
  const headers: Record<string, string> = { 'User-Agent': 'KainowRadar/1.0', 'Accept': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const noAuthHeaders: Record<string, string> = { 'User-Agent': 'KainowRadar/1.0', 'Accept': 'application/json' }

  const results: Record<string, any> = { _token_type: token ? 'oauth' : 'none' }

  // ── Teste 1: /products/search — pega catalog_product_ids ──────────────
  let searchItems: Array<{ id: string; status: string; children_ids: string[]; name: string }> = []
  try {
    const r = await fetch(`${ML_API}/products/search?site_id=MLB&q=${encodeURIComponent(q)}&limit=5`, { headers })
    const body: any = await r.json().catch(() => ({}))
    searchItems = (body?.results || []).map((x: any) => ({
      id: x.id, status: x.status,
      children_ids: x.children_ids || [],
      name: x.name || '',
    }))
    results.T1_products_search = {
      http_status: r.status,
      count: searchItems.length,
      items: searchItems.map(x => ({ id: x.id, status: x.status, children_count: x.children_ids.length, name: x.name.slice(0, 60) })),
      error: body?.error ?? null,
    }
  } catch (e: any) { results.T1_products_search = { error: e?.message } }

  const firstActive = searchItems.find(x => x.status === 'active') || searchItems[0]
  const firstId     = firstActive?.id ?? null
  const firstChildId = firstActive?.children_ids?.[0] ?? null

  // ── Teste 2: /products/{catalog_id}/items — com token ────────────────
  if (firstId) {
    try {
      const r = await fetch(`${ML_API}/products/${firstId}/items?limit=3`, { headers })
      const body: any = await r.json().catch(() => ({}))
      const items: any[] = body?.results || body?.items || []
      results.T2_products_items = {
        id: firstId, http_status: r.status, count: items.length,
        prices: items.map((x: any) => x.price),
        statuses: items.map((x: any) => x.status),
        permalinks: items.slice(0, 2).map((x: any) => x.permalink),
        raw_error: body?.error ?? null,
        raw_message: body?.message ?? null,
      }
    } catch (e: any) { results.T2_products_items = { error: e?.message } }
  }

  // ── Teste 3: /items/{children_id} com token ───────────────────────────
  if (firstChildId) {
    try {
      const r = await fetch(`${ML_API}/items/${firstChildId}?attributes=id,title,price,status,permalink,catalog_product_id`, { headers })
      const body: any = await r.json().catch(() => ({}))
      results.T3_child_item_with_token = {
        child_id: firstChildId, http_status: r.status,
        price: body?.price ?? null, status: body?.status ?? null,
        title: body?.title?.slice(0, 60) ?? null,
        permalink: body?.permalink ?? null,
        error: body?.error ?? null,
      }
    } catch (e: any) { results.T3_child_item_with_token = { error: e?.message } }
  }

  // ── Teste 4: /items/{children_id} SEM token ───────────────────────────
  if (firstChildId) {
    try {
      const r = await fetch(`${ML_API}/items/${firstChildId}?attributes=id,title,price,status,permalink`, { headers: noAuthHeaders })
      const body: any = await r.json().catch(() => ({}))
      results.T4_child_item_no_token = {
        child_id: firstChildId, http_status: r.status,
        price: body?.price ?? null, status: body?.status ?? null,
        error: body?.error ?? null, blocked_by: body?.blocked_by ?? null,
      }
    } catch (e: any) { results.T4_child_item_no_token = { error: e?.message } }
  }

  // ── Teste 5: /sites/MLB/search?q= com token ───────────────────────────
  try {
    const r = await fetch(`${ML_API}/sites/MLB/search?q=${encodeURIComponent(q)}&limit=3&attributes=id,title,price,status,permalink`, { headers })
    const body: any = await r.json().catch(() => ({}))
    const items: any[] = body?.results || []
    results.T5_sites_search_with_token = {
      http_status: r.status, count: items.length,
      prices: items.map((x: any) => x.price),
      error: body?.error ?? null, blocked_by: body?.blocked_by ?? null,
      first: items[0] ? { id: items[0].id, title: String(items[0].title || '').slice(0, 60), price: items[0].price } : null,
    }
  } catch (e: any) { results.T5_sites_search_with_token = { error: e?.message } }

  // ── Teste 6: /sites/MLB/search?catalog_product_id= com token ─────────
  if (firstId) {
    try {
      const r = await fetch(`${ML_API}/sites/MLB/search?catalog_product_id=${firstId}&limit=3&attributes=id,title,price,status,permalink`, { headers })
      const body: any = await r.json().catch(() => ({}))
      const items: any[] = body?.results || []
      results.T6_sites_search_catalog_id = {
        catalog_id: firstId, http_status: r.status, count: items.length,
        prices: items.map((x: any) => x.price),
        error: body?.error ?? null, blocked_by: body?.blocked_by ?? null,
        first: items[0] ? { id: items[0].id, price: items[0].price, status: items[0].status } : null,
      }
    } catch (e: any) { results.T6_sites_search_catalog_id = { error: e?.message } }
  }

  // ── Teste 7: /products/MLB24045332/items (ID fixo que funciona no cron) ─
  try {
    const r = await fetch(`${ML_API}/products/MLB24045332/items?limit=3`, { headers })
    const body: any = await r.json().catch(() => ({}))
    const items: any[] = body?.results || body?.items || []
    results.T7_known_working_id = {
      http_status: r.status, count: items.length,
      first_price: items[0]?.price ?? null, first_status: items[0]?.status ?? null,
      error: body?.error ?? null,
    }
  } catch (e: any) { results.T7_known_working_id = { error: e?.message } }

  // ── Teste 8: /items/{id} multi-get com children_ids de todos os results ─
  const allChildIds = searchItems.flatMap(x => x.children_ids).slice(0, 6)
  if (allChildIds.length > 0) {
    try {
      const r = await fetch(`${ML_API}/items?ids=${allChildIds.join(',')}&attributes=id,title,price,status,permalink`, { headers })
      const body: any = await r.json().catch(() => ({}))
      const fetched: any[] = Array.isArray(body) ? body : []
      results.T8_multiget_children = {
        http_status: r.status,
        ids_requested: allChildIds,
        count: fetched.length,
        results: fetched.map((x: any) => ({
          code: x.code,
          id: x.body?.id,
          price: x.body?.price,
          status: x.body?.status,
          error: x.body?.error,
        })),
      }
    } catch (e: any) { results.T8_multiget_children = { error: e?.message } }
  }

  // ── Teste 9: /products/{id}?attributes=id,name,buy_box_winner,status ──
  // Estratégia do mlScraper — buy_box_winner tem preço do catálogo
  results.T9_buy_box_winner = {}
  for (const item of searchItems.slice(0, 3)) {
    try {
      const r = await fetch(
        `${ML_API}/products/${item.id}?attributes=id,name,status,buy_box_winner,suggested_price`,
        { headers }
      )
      const body: any = await r.json().catch(() => ({}))
      results.T9_buy_box_winner[item.id] = {
        http_status: r.status,
        name: body?.name?.slice(0, 60) ?? null,
        status: body?.status ?? null,
        buy_box_price: body?.buy_box_winner?.price ?? null,
        buy_box_item_id: body?.buy_box_winner?.item_id ?? null,
        buy_box_permalink: body?.buy_box_winner?.permalink ?? null,
        suggested_price: body?.suggested_price ?? null,
        error: body?.error ?? null,
        message: body?.message ?? null,
      }
    } catch (e: any) { results.T9_buy_box_winner[item.id] = { error: (e as any)?.message } }
  }

  // ── Teste 10: /products/{id} para o ID fixo que funciona (MLB24045332) ─
  try {
    const r = await fetch(
      `${ML_API}/products/MLB24045332?attributes=id,name,status,buy_box_winner,suggested_price`,
      { headers }
    )
    const body: any = await r.json().catch(() => ({}))
    results.T10_known_buy_box = {
      http_status: r.status,
      name: body?.name?.slice(0, 60) ?? null,
      status: body?.status ?? null,
      buy_box_price: body?.buy_box_winner?.price ?? null,
      buy_box_item_id: body?.buy_box_winner?.item_id ?? null,
      suggested_price: body?.suggested_price ?? null,
      error: body?.error ?? null,
    }
  } catch (e: any) { results.T10_known_buy_box = { error: e?.message } }

  // ── Teste 11: scraping HTML lista.mercadolivre.com.br — extrai item IDs ─
  // Estratégia: o Worker tem IPs de edge (não datacenter) — pode passar bot check
  try {
    const mlUrl = `https://lista.mercadolivre.com.br/${encodeURIComponent(q.replace(/\s+/g, '-'))}`
    const r = await fetch(mlUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    })
    const html = await r.text().catch(() => '')
    // Extrai IDs de item reais (MLB + 10+ dígitos)
    const itemIdRegex = /\b(MLB\d{10,})\b/gi
    const foundIds = [...new Set([...html.matchAll(itemIdRegex)].map(m => m[1].toUpperCase()))]
    // Extrai também preços visíveis no HTML (padrão R$\s*1.234)
    const priceRegex = /R\$[\s]*[\d]{1,4}(?:[.,]\d{3})*(?:[.,]\d{2})?/g
    const prices = [...html.matchAll(priceRegex)].map(m => m[0]).slice(0, 5)
    results.T11_html_scrape = {
      url: mlUrl,
      http_status: r.status,
      html_bytes: html.length,
      is_bot_challenge: html.includes('_bmstate') || html.includes('micro-landing') || html.length < 10000,
      item_ids_found: foundIds.slice(0, 10),
      prices_found: prices,
    }
  } catch (e: any) { results.T11_html_scrape = { error: e?.message } }

  // ── Teste 12: mercadolivre.com.br/ofertas — fonte de IDs reais sem bot ──
  // Descoberta: este endpoint retorna HTML com IDs reais MLB\d{10,} sem bot challenge
  // Os IDs extraídos podem ser usados diretamente no /items/{id} com token OAuth
  try {
    const ofertasUrl = 'https://www.mercadolivre.com.br/ofertas'
    const r = await fetch(ofertasUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'Referer': 'https://www.mercadolivre.com.br/',
      },
    })
    const html = await r.text().catch(() => '')
    // IDs reais: MLB + 10 ou mais dígitos = anúncios reais (não catalog IDs de 8 dígitos)
    const idRegex = /\b(MLB\d{10,})\b/gi
    const foundIds = [...new Set([...html.matchAll(idRegex)].map(m => m[1].toUpperCase()))]
    const isBotChallenge = html.includes('_bmstate') || html.includes('PoW') || html.length < 10000

    // Se temos IDs e token, testa o primeiro via /items/{id}
    let sampleItem: any = null
    if (foundIds.length > 0 && token) {
      try {
        const testId = foundIds[0]
        const ir = await fetch(
          `${ML_API}/items/${testId}?attributes=id,title,price,status,permalink,thumbnail`,
          { headers }
        )
        const ib: any = await ir.json().catch(() => null)
        sampleItem = {
          id: testId,
          http_status: ir.status,
          title: ib?.title?.slice(0, 60) ?? null,
          price: ib?.price ?? null,
          status: ib?.status ?? null,
          permalink: ib?.permalink ?? null,
          error: ib?.error ?? null,
        }
      } catch {}
    }

    results.T12_ofertas_scrape = {
      url: ofertasUrl,
      http_status: r.status,
      html_bytes: html.length,
      is_bot_challenge: isBotChallenge,
      item_ids_found: foundIds.slice(0, 15),
      item_ids_count: foundIds.length,
      sample_item_fetch: sampleItem,
      verdict: isBotChallenge
        ? 'BLOQUEADO — bot challenge detectado no Worker'
        : foundIds.length > 0
          ? 'OK — IDs reais encontrados, prontos para /items/{id}'
          : 'VAZIO — HTML sem IDs de produto',
    }
  } catch (e: any) { results.T12_ofertas_scrape = { error: e?.message } }

  return c.json({ q, has_token: !!token, results })
})

// ── POST /admin/api/ml/force-refresh — Renova token via refresh_token ─
// Útil para renovar silenciosamente sem redirecionar o usuário
ml.post('/force-refresh', async (c) => {
  const appId   = (c.env as any).ML_APP_ID || APP_ID
  const secret  = (c.env as any).ML_SECRET || ''
  const refresh = await c.env.CACHE?.get('ml_refresh_token').catch(() => null)

  if (!refresh) {
    return c.json({
      ok: false,
      error: 'Sem refresh_token no KV — faça OAuth em /api/ml/auth primeiro',
      auth_url: 'https://kainowradar.com.br/api/ml/auth',
    }, 400)
  }
  if (!secret) {
    return c.json({ ok: false, error: 'ML_SECRET não configurado nas secrets do Cloudflare' }, 500)
  }

  const tr = await fetch(ML_API + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     appId,
      client_secret: secret,
      refresh_token: refresh,
    }),
  })
  const td: any = await tr.json().catch(() => null)

  if (!td?.access_token) {
    return c.json({
      ok:    false,
      error: td?.message || td?.error || `HTTP ${tr.status}`,
      note:  tr.status === 400
        ? 'refresh_token expirado — precisa de novo OAuth em /api/ml/auth'
        : `HTTP ${tr.status}`,
      auth_url: 'https://kainowradar.com.br/api/ml/auth',
    }, tr.status === 400 ? 400 : 500)
  }

  // Salva novo access_token (e refresh_token se veio novo)
  await c.env.CACHE?.put('ml_access_token', td.access_token, { expirationTtl: td.expires_in || 21600 }).catch(() => {})
  if (td.refresh_token) {
    await c.env.CACHE?.put('ml_refresh_token', td.refresh_token, { expirationTtl: 86400 * 30 }).catch(() => {})
  }

  return c.json({
    ok:         true,
    expires_in: td.expires_in,
    note:       '✅ Token renovado e salvo no KV — rode /admin/api/cron/run para atualizar preços',
  })
})

// ── POST /admin/api/ml/import-url ────────────────────────
// Importa produtos a partir de URLs do ML (ou IDs diretos)
// Body: { urls: string[], category?: string, names?: string[] }
// Aceita:
//   - https://produto.mercadolivre.com.br/MLB-1234-titulo-do-produto-_JM
//   - https://www.mercadolivre.com.br/produto/p/MLB28965210
//   - https://meli.la/XXXXX  (link encurtado do linkbuilder)
//   - MLB1234567890  (ID direto)
//
// ESTRATÉGIA SEM API:
//   A API ML /items/{id} exige OAuth com permissão read:catalog (403 sem ela).
//   Este endpoint extrai o ID e o título da própria URL fornecida,
//   monta o permalink canônico e gera o link afiliado sem nenhuma chamada à API ML.
//   O título é extraído do slug da URL (ex: MLB-3990393083-apple-iphone-15-128gb → "apple iphone 15 128gb").
//   Se o usuário passar { names: ["Nome do produto 1", ...] } os nomes serão usados diretamente.
ml.post('/import-url', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any
  const urls: string[]       = Array.isArray(body.urls)  ? body.urls  : []
  const names: string[]      = Array.isArray(body.names) ? body.names : []
  const categoryHint: string = body.category || 'outros'

  if (!urls.length) {
    return c.json({ error: 'Envie pelo menos uma URL ou ID no campo "urls".' }, 400)
  }

  const { DB } = c.env

  // Helper: extrai título legível do slug da URL
  // "MLB-3990393083-apple-iphone-15-128gb-azul-_JM" → "Apple Iphone 15 128gb Azul"
  function titleFromSlug(url: string): string {
    try {
      const path = new URL(url).pathname
      // Pega a parte após o ID: /MLB-3990393083-apple-iphone-15-...
      const m = path.match(/\/MLB-?\d+[-_](.+?)(?:-_JM|_JM|$)/i)
      if (!m) return ''
      return m[1]
        .replace(/-/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ')
    } catch { return '' }
  }

  // Helper: monta permalink canônico do produto
  // MLB3990393083 → https://www.mercadolivre.com.br/p/MLB3990393083
  function buildPermalink(mlId: string): string {
    return `https://www.mercadolivre.com.br/p/${mlId}`
  }

  // Helper: monta link afiliado com rastreamento
  function buildAffUrl(permalink: string): string {
    return `${permalink}?matt_word=${PUBLISHER_ID}&matt_tool=${MATT_TOOL}&forceInApp=true`
  }

  // Expande todas as entradas em linhas individuais
  const allLines: string[] = []
  for (const raw of urls) {
    const lines = raw.split(/[\n,]+/).map((l: string) => l.trim()).filter(Boolean)
    allLines.push(...lines)
  }

  // Resolve encurtadores (meli.la/xxx → URL real)
  const resolvedLines = await Promise.all(
    allLines.map(async (line) => {
      if (line.startsWith('http') && isShortUrl(line)) {
        return await resolveShortUrl(line)
      }
      return line
    })
  )

  const parseErrors: string[] = []
  let created = 0, updated = 0, skipped = 0
  const details: any[] = []

  for (let i = 0; i < resolvedLines.length; i++) {
    const line = resolvedLines[i]

    // Detecta URL de perfil de afiliado
    if (/mercadolivre\.com\.br\/social\//.test(line)) {
      parseErrors.push(`URL de perfil (não produto): ${line.substring(0, 60)}`)
      continue
    }

    const mlId = extractMLBId(line)
    if (!mlId) {
      parseErrors.push(`ID não encontrado em: ${line.substring(0, 60)}`)
      continue
    }

    // Nome: usa names[i] se fornecido, senão extrai do slug da URL
    const nameFromUrl   = titleFromSlug(line.startsWith('http') ? line : '')
    const productName   = (names[i] || nameFromUrl || mlId).trim()
    const permalink     = buildPermalink(mlId)
    const aff_url       = buildAffUrl(permalink)
    const slug          = mlId.toLowerCase()

    // Verifica se já existe pelo ml_item_id
    const existing = await DB.prepare(
      'SELECT id, name FROM products WHERE ml_item_id = ?'
    ).bind(mlId).first<{ id: number; name: string }>()

    if (existing) {
      // Atualiza affiliate_url com o formato correto (matt_word)
      await DB.prepare(`
        UPDATE products
        SET affiliate_url = ?, affiliate_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE ml_item_id = ?
      `).bind(aff_url, mlId).run()
      updated++
      details.push({ ml_id: mlId, name: existing.name, action: 'updated', product_id: existing.id, affiliate_url: aff_url })
      continue
    }

    // Verifica se existe produto sem ml_item_id mas com nome similar
    // (produtos importados antes sem ID — tenta associar)
    const bySlug = await DB.prepare(
      'SELECT id, name FROM products WHERE slug = ? AND (ml_item_id IS NULL OR ml_item_id = \"\")'
    ).bind(slug).first<{ id: number; name: string }>()

    if (bySlug) {
      await DB.prepare(`
        UPDATE products
        SET ml_item_id = ?, affiliate_url = ?, affiliate_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(mlId, aff_url, bySlug.id).run()
      updated++
      details.push({ ml_id: mlId, name: bySlug.name, action: 'updated', product_id: bySlug.id, affiliate_url: aff_url })
      continue
    }

    // Cria novo produto com dados extraídos da URL
    if (!productName || productName === mlId) {
      // Sem nome — registra como pendente (bot vai tentar buscar nome depois)
      skipped++
      parseErrors.push(`Sem nome para ${mlId} — cole a URL completa com slug ou passe names[]`)
      continue
    }

    try {
      const res = await DB.prepare(`
        INSERT INTO products
          (name, slug, ml_item_id, affiliate_url, affiliate_updated_at,
           best_price, offer_count, is_active, source, category, created_at, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, NULL, 0, 1, 'mercadolivre', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).bind(productName, slug, mlId, aff_url, categoryHint).run()

      const newId = res.meta?.last_row_id as number

      // Cria offer placeholder para o produto aparecer no site
      // (sem preço real ainda — será atualizado pelo sync de preços)
      await DB.prepare(`
        INSERT INTO offers (product_id, store_id, external_id, title, price, affiliate_url, is_active, in_stock, source, last_updated)
        VALUES (?, 3, ?, ?, 0, ?, 1, 1, 'mercadolivre', CURRENT_TIMESTAMP)
      `).bind(newId, mlId, productName, aff_url).run()

      // Atualiza offer_count do produto
      await DB.prepare(`UPDATE products SET offer_count = 1, best_store_id = 3 WHERE id = ?`).bind(newId).run()

      created++
      details.push({ ml_id: mlId, name: productName, action: 'created', product_id: newId, affiliate_url: aff_url })
    } catch (e: any) {
      // Slug duplicado — tenta com sufixo do mlId
      try {
        const slugUniq = `${slug}-${mlId.toLowerCase()}`
        const res = await DB.prepare(`
          INSERT INTO products
            (name, slug, ml_item_id, affiliate_url, affiliate_updated_at,
             best_price, offer_count, is_active, source, category, created_at, updated_at)
          VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, NULL, 0, 1, 'mercadolivre', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).bind(productName, slugUniq, mlId, aff_url, categoryHint).run()

        const newId = res.meta?.last_row_id as number

        // Cria offer placeholder
        await DB.prepare(`
          INSERT INTO offers (product_id, store_id, external_id, title, price, affiliate_url, is_active, in_stock, source, last_updated)
          VALUES (?, 3, ?, ?, 0, ?, 1, 1, 'mercadolivre', CURRENT_TIMESTAMP)
        `).bind(newId, mlId, productName, aff_url).run()

        await DB.prepare(`UPDATE products SET offer_count = 1, best_store_id = 3 WHERE id = ?`).bind(newId).run()

        created++
        details.push({ ml_id: mlId, name: productName, action: 'created', product_id: newId, affiliate_url: aff_url })
      } catch (e2: any) {
        parseErrors.push(`Erro ao salvar ${mlId}: ${e2.message}`)
      }
    }
  }

  return c.json({
    ok:           true,
    created,
    updated,
    skipped,
    not_found:    [],
    parse_errors: parseErrors,
    items:        details,
    message:      `${created} criados, ${updated} atualizados, ${skipped} ignorados` +
                  (parseErrors.length ? ` — ${parseErrors.length} avisos` : ''),
    note:         'Links gerados diretamente da URL (sem chamada à API ML)',
  })
})

// ── POST /admin/api/ml/import — Importa por seedIds de categoria ──
// Usa os seedIds hardcoded em ML_CATEGORIES — requer IDs reais válidos
ml.post('/import', async (c) => {
  const { DB } = c.env
  const body   = await c.req.json().catch(() => ({}))
  const category: string = (body as any).category || 'smartphones'
  const limit: number    = Math.min(Number((body as any).limit) || 50, 200)

  const token = await getStoredToken(c.env)
  if (!token) {
    return c.json({
      error: 'Token do Mercado Livre não encontrado. Clique em "Conectar ao ML" para autorizar.',
      auth_url: `/api/ml/auth`,
    }, 401)
  }

  const categoriesToImport = category === 'all'
    ? Object.values(ML_CATEGORIES)
    : ML_CATEGORIES[category]
      ? [ML_CATEGORIES[category]]
      : null

  if (!categoriesToImport) {
    return c.json({ error: `Categoria inválida: ${category}` }, 400)
  }

  let totalCreated = 0
  let totalUpdated = 0
  let totalSkipped = 0
  let totalNotFound = 0
  const errors: string[] = []

  for (const cat of categoriesToImport) {
    const idsToFetch = cat.seedIds.slice(0, limit)
    if (!idsToFetch.length) {
      errors.push(`${cat.slug}: nenhum seedId configurado — use "Importar por URL" para adicionar produtos`)
      continue
    }

    const items = await fetchMLItemsMulti(idsToFetch, token)

    const returnedIds  = items.map((i: any) => i.id)
    const notFoundHere = idsToFetch.filter(id => !returnedIds.includes(id))
    totalNotFound += notFoundHere.length

    for (const item of items) {
      const { action } = await saveProductToDB(DB, item, cat.slug)
      if      (action === 'created') totalCreated++
      else if (action === 'updated') totalUpdated++
      else                           totalSkipped++
      await new Promise(r => setTimeout(r, 40))
    }

    if (notFoundHere.length) {
      errors.push(`${cat.slug}: ${notFoundHere.length} IDs não encontrados no ML`)
    }
  }

  return c.json({
    ok:        true,
    created:   totalCreated,
    updated:   totalUpdated,
    skipped:   totalSkipped,
    not_found: totalNotFound,
    errors:    errors.slice(0, 10),
    message:   `${totalCreated} criados, ${totalUpdated} atualizados, ${totalSkipped} ignorados`,
  })
})

// ── POST /admin/api/ml/import-item — Item único por ID ───
ml.post('/import-item', async (c) => {
  const { ml_id } = await c.req.json().catch(() => ({})) as any
  if (!ml_id) return c.json({ error: 'ml_id obrigatório' }, 400)

  const { DB } = c.env
  const token  = await getStoredToken(c.env)
  if (!token) {
    return c.json({
      error: 'Token ML não encontrado. Autorize primeiro em "Conectar ao ML".',
      auth_url: `/api/ml/auth`,
    }, 401)
  }

  const item = await fetchMLItem(ml_id, token)
  if (!item) return c.json({ error: `Item ${ml_id} não encontrado ou inválido` }, 404)

  const catSlug = Object.entries(ML_CATEGORIES)
    .find(([, v]) => (item.category_id || '').startsWith(v.mlId.substring(0, 6)))?.[0] || 'outros'

  const { id, action } = await saveProductToDB(DB, item, catSlug)

  return c.json({
    ok:            true,
    action,
    product_id:    id,
    ml_id:         item.id,
    name:          item.title,
    price:         item.price,
    category:      catSlug,
    affiliate_url: `${item.permalink}?matt_word=${PUBLISHER_ID}&matt_tool=${MATT_TOOL}&forceInApp=true`,
  })
})

export default ml
export { ML_CATEGORIES, extractMLBId }
