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
const MATT_TOOL    = '61674414'
const ML_API       = 'https://api.mercadolibre.com'
const APP_ID       = '3098423019766450'

// ── Converte qualquer permalink ML para link afiliado direto ─────────────
// produto.mercadolivre.com.br/MLB-XXXXXXX → MLB-XXXXXXXX (direto, sempre funciona)
// /p/MLB... ou /social/...                → mantém como está
// NOTA: /p/MLB só funciona para produtos com ficha técnica unificada no ML.
//       O formato direto MLB-XXXXXXXX funciona para TODOS os produtos.
function toAffUrl(permalink: string): string {
  if (!permalink) return ''
  const clean = permalink.split('?')[0]
  // Extrai MLB ID de qualquer formato de URL do ML
  const m = clean.match(/MLB[\-_]?(\d+)/i)
  if (m) {
    return `https://www.mercadolivre.com.br/MLB-${m[1]}?matt_word=${PUBLISHER_ID}&matt_tool=${MATT_TOOL}&forceInApp=true`
  }
  return `${clean}?matt_word=${PUBLISHER_ID}&matt_tool=${MATT_TOOL}&forceInApp=true`
}

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

// ── Helper: Detecta se URL precisa de resolução de redirect ──
// Cobre encurtadores ML e links afiliados (go.mercadolivre.com.br)
function isShortUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return (
      host === 'meli.la'              ||  // encurtador ML
      host === 'mercadol.iv'          ||  // encurtador alternativo
      host === 'm.me'                 ||  // messenger
      host === 'go.mercadolivre.com.br'   // link afiliado do painel ML ← BUG FIX
    )
  } catch {
    return false
  }
}

// ── Helper: Resolve URL encurtada/afiliada → URL final (segue redirects) ──
// Usa fetch com redirect:'follow' — o Cloudflare Worker suporta isso
async function resolveShortUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':           'text/html,application/xhtml+xml,*/*',
        'Accept-Language':  'pt-BR,pt;q=0.9',
      },
    })
    // Após seguir todos os redirects, res.url é a URL final
    return res.url || url
  } catch {
    return url
  }
}

// ── Helper: Extrai MLB ID de uma URL do Mercado Livre ─────
// Suporta todos os formatos reais do ML:
//
//   ID direto:     MLB3597223513
//   Listing:       /produto.mercadolivre.com.br/MLB-3597223513-samsung-_JM
//   Product page:  /p/MLB28965210
//   Up page:       /up/MLBU3222497078
//   Hash wid:      #...&wid=MLB4085178895   ← item real (tracking ML via fragment)
//   Query wid:     ?wid=MLB4085178895
//   Query item_id: ?item_id=MLB3597223513
//
// ⚠️  ATENÇÃO: o ML coloca wid= no FRAGMENTO (#), não no query string.
//     Ex: /up/MLBU3222497078#...&wid=MLB4085178895&sid=search
//     URLSearchParams não lê fragmento — precisa parsear u.hash manualmente.
//
// Prioridade: wid (item real) > item_id > /p/ > /up/ > slug > qualquer MLB\d+
// IDs com hífen separando dígitos (MLB-4411-4104) são inválidos → null.
function extractMLBId(input: string): string | null {
  const s = input.trim()

  // 1. ID direto (ex: MLB3597223513 ou MLBU3222497078)
  if (/^MLB[U]?\d+$/i.test(s)) return s.toUpperCase().replace(/^MLBU/i, 'MLB')

  // 2. Tenta parsear como URL
  try {
    const u = new URL(s)

    // 2a. wid= no FRAGMENTO (#...&wid=MLB4085178895&...)
    //     O ML usa hash com query-string-like params nos links de busca/tracking
    //     Isso é o item real do anúncio — prioridade máxima
    if (u.hash) {
      const hashParams = new URLSearchParams(u.hash.replace(/^#/, ''))
      const widHash = hashParams.get('wid')
      if (widHash && /^MLB\d{8,}$/i.test(widHash)) return widHash.toUpperCase()
      // Fallback: regex no hash bruto
      const hashMatch = u.hash.match(/\bwid=(MLB\d{8,})\b/i)
      if (hashMatch) return hashMatch[1].toUpperCase()
    }

    // 2b. ?wid=MLB... no query string normal
    const wid = u.searchParams.get('wid')
    if (wid && /^MLB\d{8,}$/i.test(wid)) return wid.toUpperCase()

    // 2c. ?item_id=MLB... ou ?itemId=MLB...
    const qItemId = u.searchParams.get('item_id') || u.searchParams.get('itemId')
    if (qItemId && /^MLB\d{8,}$/i.test(qItemId)) return qItemId.toUpperCase()

    // 2d. /p/MLBXXXXXXXX — product group page
    const pMatch = u.pathname.match(/\/p\/(MLB\d+)/i)
    if (pMatch) return pMatch[1].toUpperCase()

    // 2e. /up/MLBUXXXXXXXX — catálogo via URL de produto universal
    //     ex: /tapete-borracha/up/MLBU3222497078
    //     Normaliza MLBU → MLB para bater com os endpoints da API
    const upMatch = u.pathname.match(/\/up\/(MLB[U]?\d+)/i)
    if (upMatch) return upMatch[1].toUpperCase().replace(/^MLBU/i, 'MLB')

    // 2f. /MLB-XXXXXXXXXX-slug — ID contínuo com 8+ dígitos sem hífen no meio
    //     Correto:  /MLB-3597223513-samsung → MLB3597223513
    //     Inválido: /MLB-4411-4104-titulo  → null
    const contMatch = u.pathname.match(/\/MLB-?(\d{8,})(?:[^0-9]|$)/i)
    if (contMatch) return 'MLB' + contMatch[1]

    // 2g. MLB\d{8,} em qualquer parte do path
    const pathAny = u.pathname.match(/\b(MLB\d{8,})\b/i)
    if (pathAny) return pathAny[1].toUpperCase()

    // 2h. MLB\d{8,} em qualquer parte da URL completa (query + hash)
    const urlAny = (u.search + u.hash).match(/\b(MLB\d{8,})\b/i)
    if (urlAny) return urlAny[1].toUpperCase()

  } catch { /* não é URL válida — trata como string bruta */ }

  // 3. Fallback: MLB\d{8,} em qualquer posição da string bruta
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
          const aff_url = toAffUrl(item.permalink || '')
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
//
// Formatos suportados:
//   - https://produto.mercadolivre.com.br/MLB-1234-titulo-_JM
//   - https://www.mercadolivre.com.br/tapete/up/MLBU3222497078?wid=MLB4085178895
//     └ extrai wid=MLB4085178895 (item real) OU MLBU (catálogo) como fallback
//   - https://meli.la/XXXXX  (encurtado)
//   - https://go.mercadolivre.com.br/...  (link afiliado — resolve redirect)
//   - MLB1234567890  (ID direto)
//
// ESTRATÉGIA HÍBRIDA:
//   1. Extrai o MLB ID da URL (wid > /p/ > /up/ > slug)
//   2. Se houver token ML disponível → busca /items/{id} para pegar
//      nome real, preço, imagem e categoria da API
//   3. Fallback: extrai nome do slug da URL (sem chamada à API)
//   4. Sempre salva ml_item_id — nunca fica vazio
ml.post('/import-url', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any
  const urls: string[]       = Array.isArray(body.urls)  ? body.urls  : []
  const names: string[]      = Array.isArray(body.names) ? body.names : []
  const categoryHint: string = body.category || 'outros'

  if (!urls.length) {
    return c.json({ error: 'Envie pelo menos uma URL ou ID no campo "urls".' }, 400)
  }

  const { DB } = c.env

  // Tenta obter token ML para enriquecer dados via API
  const mlToken = await getStoredToken(c.env).catch(() => null)

  // Helper: busca dados reais do item via API ML (/items/{id})
  // Retorna { name, price, image, category, permalink } ou null se falhar
  async function fetchItemData(mlId: string, nameHint = ''): Promise<{
    name: string; price: number | null; image: string | null
    category: string | null; permalink: string | null
  } | null> {
    if (!mlToken) return null

    const headers = {
      'Authorization': `Bearer ${mlToken}`,
      'Accept':        'application/json',
      'User-Agent':    'KainowRadar/1.0',
    }

    // Helper: mapeia category_id ML → slug local
    function mapCategory(categoryId: string | null): string | null {
      if (!categoryId) return null
      const entry = Object.entries(ML_CATEGORIES).find(
        ([, v]) => categoryId === v.mlId || categoryId.startsWith(v.mlId.substring(0, 6))
      )
      return entry?.[0] || null
    }

    // Helper: normaliza thumbnail
    function thumb(t: string | null | undefined): string | null {
      return t ? (t as string).replace('-I.jpg', '-O.jpg') : null
    }

    // ── Estratégia 1: /items/{id} ─────────────────────────────
    try {
      const res = await fetch(
        `${ML_API}/items/${mlId}?attributes=id,title,price,thumbnail,permalink,category_id`,
        { headers }
      )
      if (res.ok) {
        const d: any = await res.json().catch(() => null)
        if (d?.title) {
          return { name: d.title.trim(), price: d.price || null,
                   image: thumb(d.thumbnail), category: mapCategory(d.category_id),
                   permalink: d.permalink || null }
        }
      }
    } catch { /* tenta próxima */ }

    // ── Estratégia 2: search por ID exato ────────────────────
    try {
      const res = await fetch(`${ML_API}/sites/MLB/search?q=${mlId}&limit=3`, { headers })
      if (res.ok) {
        const d: any = await res.json().catch(() => null)
        const results: any[] = d?.results || []
        const match = results.find((r: any) => r.id === mlId) || null
        if (match?.title) {
          return { name: match.title.trim(), price: match.price || null,
                   image: thumb(match.thumbnail), category: mapCategory(match.category_id),
                   permalink: match.permalink || null }
        }
      }
    } catch { /* tenta próxima */ }

    // ── Estratégia 3: search por nome do slug ────────────────
    if (nameHint) {
      try {
        const q = encodeURIComponent(nameHint)
        const res = await fetch(`${ML_API}/sites/MLB/search?q=${q}&limit=5`, { headers })
        if (res.ok) {
          const d: any = await res.json().catch(() => null)
          const results: any[] = d?.results || []
          // Prefere o que tiver id == mlId; senão pega o primeiro com preço
          const match = results.find((r: any) => r.id === mlId)
                     || results.find((r: any) => r.price)
                     || results[0]
          if (match?.title) {
            return { name: match.title.trim(), price: match.price || null,
                     image: thumb(match.thumbnail), category: mapCategory(match.category_id),
                     permalink: match.permalink || null }
          }
        }
      } catch { /* sem dados */ }
    }

    return null
  }

  // Helper: extrai título legível do slug da URL
  // "/tapete-borracha-protetor.../up/MLBU..." → "Tapete Borracha Protetor ..."
  // "/MLB-3990393083-apple-iphone-15-128gb-azul-_JM" → "Apple Iphone 15 128gb Azul"
  function titleFromSlug(url: string): string {
    try {
      const path = new URL(url).pathname
      // Formato /up/: extrai segmento anterior ao /up/
      const upM = path.match(/\/(.+?)\/up\//i)
      if (upM) {
        const seg = upM[1].split('/').pop() || ''
        return seg.replace(/-/g, ' ').trim()
          .split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
      }
      // Formato /MLB-ID-slug
      const m = path.match(/\/MLB-?\d+[-_](.+?)(?:-_JM|_JM|$)/i)
      if (!m) return ''
      return m[1]
        .replace(/-/g, ' ').replace(/\s+/g, ' ').trim()
        .split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    } catch { return '' }
  }

  // Helper: monta permalink canônico
  function buildPermalink(mlId: string): string {
    return `https://www.mercadolivre.com.br/p/${mlId}`
  }

  // Helper: monta link afiliado — delega para toAffUrl global
  function buildAffUrl(permalink: string): string {
    return toAffUrl(permalink)
  }

  // Expande todas as entradas em linhas individuais
  const allLines: string[] = []
  for (const raw of urls) {
    // Divide por nova linha ou vírgula primeiro
    const byNewline = raw.split(/[\n,]+/).map((l: string) => l.trim()).filter(Boolean)
    for (const chunk of byNewline) {
      // Se a linha tem 2 URLs juntas separadas por espaço, separa
      // Ex: "https://...produto... https://...social/..."
      const parts = chunk.split(/\s+/).filter(Boolean)
      if (parts.length >= 2 && parts.every(p => p.startsWith('http'))) {
        allLines.push(...parts)
      } else {
        allLines.push(chunk)
      }
    }
  }

  // Resolve encurtadores e links afiliados (meli.la, go.mercadolivre.com.br → URL real)
  const resolvedLines = await Promise.all(
    allLines.map(async (line) => {
      if (line.startsWith('http') && isShortUrl(line)) {
        const resolved = await resolveShortUrl(line)
        return resolved
      }
      return line
    })
  )

  const parseErrors: string[] = []
  let created = 0, updated = 0, skipped = 0
  const details: any[] = []

  // ── Pré-processa linhas: detecta pares (produto + /social/ afiliado)
  // O painel ML exporta: linha 1 = URL do produto, linha 2 = /social/publisher?...
  // Quando o /social/ segue um produto, é o link afiliado desse produto.
  // Monta array de objetos { productLine, affLine }
  interface PairEntry { productLine: string; origProductLine: string; affLine: string | null }
  const pairs: PairEntry[] = []

  for (let i = 0; i < resolvedLines.length; i++) {
    const line = resolvedLines[i]
    const orig = allLines[i]

    // Detecta link afiliado: URL do painel ML Afiliados
    // Formato real: https://www.mercadolivre.com.br/social/cfegdhabc31955?...&ref=...
    // IMPORTANTE: não usar só includes(PUBLISHER_ID) pois a URL do produto também pode ter
    // matt_word=cfegdhabc31955 — precisa ser especificamente o link /social/
    const isAffiliateLink = /mercadolivre\.com\.br\/social\//.test(line)

    if (isAffiliateLink) {
      // Se há um produto pendente no par anterior → associa como link afiliado
      if (pairs.length > 0 && pairs[pairs.length - 1].affLine === null) {
        pairs[pairs.length - 1].affLine = line
      } else {
        // link afiliado sozinho sem produto antes → ignora
        parseErrors.push(`Link afiliado ignorado (sem produto par): ${line.substring(0, 80)}`)
      }
      continue
    }

    // Linha normal de produto
    pairs.push({ productLine: line, origProductLine: orig, affLine: null })
  }

  for (const { productLine: line, origProductLine: origLine, affLine } of pairs) {
    // ── Extrai MLB ID (prioridade: wid > /p/ > /up/ > slug)
    const mlId = extractMLBId(line)
    if (!mlId) {
      parseErrors.push(`ID não encontrado em: ${line.substring(0, 80)}`)
      continue
    }

    // ── Nome do slug (usado como hint de busca na API)
    const nameFromUrl = titleFromSlug(line) || titleFromSlug(origLine)

    // ── Tenta buscar dados reais na API ML (passa slug como hint)
    const apiData = await fetchItemData(mlId, nameFromUrl)

    // ── Nome final: API > slug da URL > mlId
    const productName  = (
      apiData?.name ||
      nameFromUrl   ||
      ''
    ).trim()

    // ── Permalink e link afiliado
    // Prioridade: link /social/ do par > permalink da API > canônico
    const permalink = (apiData?.permalink ? apiData.permalink.split('?')[0] : null)
                   || buildPermalink(mlId)
    const aff_url   = affLine || buildAffUrl(permalink)

    // ── Categoria: API > hint do body
    const finalCategory = apiData?.category || categoryHint

    // ── Preço e imagem (da API, se disponível)
    const apiPrice = apiData?.price  ?? null
    const apiImage = apiData?.image  ?? null

    const slug = slugify(productName || mlId)

    // ── 1. Já existe pelo ml_item_id → atualiza ──────────────
    const existing = await DB.prepare(
      'SELECT id, name FROM products WHERE ml_item_id = ?'
    ).bind(mlId).first<{ id: number; name: string }>()

    if (existing) {
      await DB.prepare(`
        UPDATE products
        SET affiliate_url          = ?,
            affiliate_updated_at   = CURRENT_TIMESTAMP,
            updated_at             = CURRENT_TIMESTAMP
            ${ apiData?.name     ? ', name = ?'      : '' }
            ${ apiPrice !== null ? ', best_price = ?' : '' }
            ${ apiImage          ? ', image_url = ?'  : '' }
            ${ apiData?.category ? ', category = ?'   : '' }
        WHERE ml_item_id = ?
      `).bind(
        aff_url,
        ...(apiData?.name     ? [apiData.name]     : []),
        ...(apiPrice !== null ? [apiPrice]          : []),
        ...(apiImage          ? [apiImage]          : []),
        ...(apiData?.category ? [apiData.category]  : []),
        mlId,
      ).run()
      updated++
      details.push({
        ml_id: mlId, name: apiData?.name || existing.name,
        action: 'updated', product_id: existing.id,
        affiliate_url: aff_url,
        api_enriched: !!apiData,
      })
      continue
    }

    // ── 2. Existe produto sem ml_item_id com slug igual → associa
    const bySlug = await DB.prepare(
      'SELECT id, name FROM products WHERE slug = ? AND (ml_item_id IS NULL OR ml_item_id = "")'
    ).bind(slug).first<{ id: number; name: string }>()

    if (bySlug) {
      await DB.prepare(`
        UPDATE products
        SET ml_item_id           = ?,
            affiliate_url        = ?,
            affiliate_updated_at = CURRENT_TIMESTAMP,
            updated_at           = CURRENT_TIMESTAMP
            ${ apiPrice !== null ? ', best_price = ?' : '' }
            ${ apiImage          ? ', image_url = ?'  : '' }
            ${ apiData?.category ? ', category = ?'   : '' }
        WHERE id = ?
      `).bind(
        mlId,
        aff_url,
        ...(apiPrice !== null ? [apiPrice]         : []),
        ...(apiImage          ? [apiImage]          : []),
        ...(apiData?.category ? [apiData.category]  : []),
        bySlug.id,
      ).run()
      updated++
      details.push({
        ml_id: mlId, name: bySlug.name,
        action: 'updated', product_id: bySlug.id,
        affiliate_url: aff_url, api_enriched: !!apiData,
      })
      continue
    }

    // ── 3. Produto novo ───────────────────────────────────────
    if (!productName) {
      skipped++
      parseErrors.push(
        `${mlId}: sem nome (URL sem slug legível, sem token ML e sem names[])` +
        (mlToken ? ' — API retornou vazio' : ' — sem token ML para buscar nome')
      )
      continue
    }

    const insertProduct = async (finalSlug: string) => {
      const res = await DB.prepare(`
        INSERT INTO products
          (name, slug, ml_item_id, affiliate_url, affiliate_updated_at,
           best_price, image_url, offer_count, is_active, source, category,
           created_at, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, 0, 1, 'mercadolivre', ?,
                CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).bind(
        productName, finalSlug, mlId, aff_url,
        apiPrice, apiImage, finalCategory,
      ).run()

      const newId = res.meta?.last_row_id as number

      // Offer placeholder (preço real se vier da API, senão 0)
      await DB.prepare(`
        INSERT INTO offers
          (product_id, store_id, external_id, title, price, affiliate_url,
           is_active, in_stock, source, last_updated)
        VALUES (?, 3, ?, ?, ?, ?, 1, 1, 'mercadolivre', CURRENT_TIMESTAMP)
      `).bind(newId, mlId, productName, apiPrice ?? 0, aff_url).run()

      // Atualiza offer_count e best_price
      if (apiPrice) {
        await DB.prepare(`
          UPDATE products SET offer_count = 1, best_store_id = 3, best_price = ? WHERE id = ?
        `).bind(apiPrice, newId).run()
      } else {
        await DB.prepare(`UPDATE products SET offer_count = 1, best_store_id = 3 WHERE id = ?`).bind(newId).run()
      }

      return newId
    }

    try {
      const newId = await insertProduct(slug)
      created++
      details.push({
        ml_id: mlId, name: productName, action: 'created', product_id: newId,
        affiliate_url: aff_url, price: apiPrice, category: finalCategory,
        api_enriched: !!apiData,
      })
    } catch {
      // Slug duplicado — tenta com sufixo do mlId
      try {
        const newId = await insertProduct(`${slug}-${mlId.toLowerCase()}`)
        created++
        details.push({
          ml_id: mlId, name: productName, action: 'created', product_id: newId,
          affiliate_url: aff_url, price: apiPrice, category: finalCategory,
          api_enriched: !!apiData,
        })
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
    api_enriched: details.filter(d => d.api_enriched).length,
    token_used:   !!mlToken,
    message:      `${created} criados, ${updated} atualizados, ${skipped} ignorados` +
                  (parseErrors.length ? ` — ${parseErrors.length} avisos` : ''),
    note: mlToken
      ? 'Dados enriquecidos via API ML (nome, preço, imagem, categoria)'
      : 'Sem token ML — use /api/ml/auth para ativar enriquecimento automático',
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
    affiliate_url: toAffUrl(item.permalink || ''),
  })
})

// ════════════════════════════════════════════════════════════
// NOVAS ROTAS — Roadmap API ML
// ════════════════════════════════════════════════════════════

// ── GET /api/ml/browse — Busca produtos por categoria com cache KV ──
// Query params:
//   category  = ID da categoria ML (ex: MLB1051) ou slug local (ex: smartphones)
//   q         = termo de busca livre
//   limit     = 1-50 (padrão 24)
//   offset    = paginação (padrão 0)
//   sort      = relevance | price_asc | price_desc | sales_high
ml.get('/browse', async (c) => {
  const { CACHE } = c.env
  const categoryParam = c.req.query('category') || ''
  const q             = (c.req.query('q') || '').trim()
  const limit         = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '24')))
  const offset        = Math.max(0, parseInt(c.req.query('offset') || '0'))
  const sortParam     = c.req.query('sort') || 'relevance'

  if (!categoryParam && !q) {
    return c.json({ error: 'Informe category ou q' }, 400)
  }

  // Resolve categoria: slug local → mlId do ML_CATEGORIES
  let mlCategoryId = categoryParam
  if (ML_CATEGORIES[categoryParam]) {
    mlCategoryId = ML_CATEGORIES[categoryParam].mlId
  }

  // Cache key: inclui todos os parâmetros
  const cacheKey = `ml_browse:${mlCategoryId}:${q}:${limit}:${offset}:${sortParam}`
  if (CACHE) {
    const cached = await CACHE.get(cacheKey, 'json').catch(() => null)
    if (cached) return c.json(cached as any)
  }

  const token = await getStoredToken(c.env)
  if (!token) {
    return c.json({ error: 'Token ML não disponível', auth_url: '/api/ml/auth' }, 503)
  }

  // Monta URL da API ML com parâmetros
  const sortMap: Record<string, string> = {
    relevance:  'relevance',
    price_asc:  'price_asc',
    price_desc: 'price_desc',
    sales_high: 'sold_quantity_desc',
  }
  const mlSort = sortMap[sortParam] || 'relevance'

  const params = new URLSearchParams({
    limit:  String(limit),
    offset: String(offset),
    sort:   mlSort,
  })
  if (mlCategoryId) params.set('category', mlCategoryId)
  if (q)            params.set('q', q)

  try {
    const res = await fetch(`${ML_API}/sites/MLB/search?${params}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/json',
        'User-Agent':    'KainowRadar/1.0',
      },
    })

    if (!res.ok) {
      const err: any = await res.json().catch(() => ({}))
      // 403 no /sites/MLB/search = app em modo test/legacy — endpoint bloqueado pelo ML
      // Solução: usar /items/{id} com import-url ou aguardar aprovação do app
      const isForbidden = res.status === 403
      return c.json({
        error:   isForbidden
          ? 'API ML: acesso negado ao /sites/MLB/search (app em modo test). Use o endpoint /api/ml/item/:id com IDs diretos.'
          : (err.message || err.error || `ML API HTTP ${res.status}`),
        status:  res.status,
        hint:    isForbidden ? 'Para desbloquear, o app precisa ser aprovado na categoria no painel ML.' : undefined,
        details: isForbidden ? undefined : err,
      }, res.status as any)
    }

    const data: any = await res.json()
    const items: any[] = data.results || []

    // Injeta link afiliado em cada item
    const results = items.map((item: any) => {
      const permalink = item.permalink || ''
      const affUrl    = permalink ? toAffUrl(permalink) : ''
      return {
        id:             item.id,
        title:          item.title,
        price:          item.price,
        original_price: item.original_price || null,
        discount_pct:   item.original_price && item.price
          ? Math.round((1 - item.price / item.original_price) * 100)
          : null,
        thumbnail:      (item.thumbnail || '').replace('-I.jpg', '-O.jpg'),
        permalink,
        affiliate_url:  affUrl,
        free_shipping:  item.shipping?.free_shipping || false,
        condition:      item.condition,
        sold_quantity:  item.sold_quantity || 0,
        category_id:    item.category_id || '',
      }
    })

    const payload = {
      query:       q || null,
      category_id: mlCategoryId || null,
      total:       data.paging?.total || results.length,
      offset:      data.paging?.offset || offset,
      limit:       data.paging?.limit  || limit,
      sort:        sortParam,
      results,
    }

    // Cache 6h no KV
    if (CACHE && results.length > 0) {
      await CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 21600 }).catch(() => {})
    }

    return c.json(payload)
  } catch (e: any) {
    return c.json({ error: e.message || 'Erro interno' }, 500)
  }
})

// ── GET /api/ml/categories — Árvore de categorias do ML Brasil com cache ──
// Busca /sites/MLB/categories e retorna lista enriquecida com slugs locais
ml.get('/categories', async (c) => {
  const { CACHE } = c.env
  const cacheKey  = 'ml_categories_tree'

  // Cache 24h — categorias mudam raramente
  if (CACHE) {
    const cached = await CACHE.get(cacheKey, 'json').catch(() => null)
    if (cached) return c.json(cached as any)
  }

  const token = await getStoredToken(c.env)
  const headers: Record<string, string> = {
    'Accept':     'application/json',
    'User-Agent': 'KainowRadar/1.0',
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  try {
    const res = await fetch(`${ML_API}/sites/MLB/categories`, { headers })
    if (!res.ok) {
      return c.json({ error: `ML API HTTP ${res.status}` }, res.status as any)
    }
    const mlCats: any[] = await res.json()

    // Ícones por ID de categoria ML
    const CAT_ICONS: Record<string, string> = {
      MLB5672:  '📱', MLB1051:  '📱', MLB1648:  '💻', MLB1000:  '📺',
      MLB1144:  '🎮', MLB1003:  '🎵', MLB1008:  '📷', MLB1574:  '🏠',
      MLB1009:  '📟', MLB1649:  '🖥️', MLB1430:  '👗', MLB1499:  '🏋️',
      MLB1500:  '🐾', MLB218519:'🧴', MLB1132:  '🚗', MLB1459:  '🧸',
      MLB1540:  '🔧', MLB86:    '🏡', MLB1276:  '📚', MLB1367:  '⚽',
      MLB407134:'🍔', MLB3937:  '🎵', MLB1953:  '✈️', MLB4357:  '💊',
      MLB3633:  '🎨', MLB1743:  '💼',
    }

    // Mapa de slug local por ID ML
    const LOCAL_SLUGS: Record<string, string> = Object.fromEntries(
      Object.entries(ML_CATEGORIES).map(([slug, cat]) => [cat.mlId, slug])
    )

    const categories = mlCats.map((cat: any) => ({
      id:          cat.id,
      name:        cat.name,
      slug:        LOCAL_SLUGS[cat.id] || cat.name.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-'),
      icon:        CAT_ICONS[cat.id] || '🛍️',
      has_local:   !!LOCAL_SLUGS[cat.id],
    }))

    const payload = { categories, total: categories.length, source: 'mercadolibre_api' }

    if (CACHE) {
      await CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 86400 }).catch(() => {})
    }

    return c.json(payload)
  } catch (e: any) {
    return c.json({ error: e.message || 'Erro ao buscar categorias' }, 500)
  }
})

// ── GET /api/ml/deals — Ofertas do dia (maior desconto) com cache ──
// Query params:
//   category = ID ML (ex: MLB1051) ou slug local
//   limit    = 1-50 (padrão 20)
ml.get('/deals', async (c) => {
  const { CACHE }  = c.env
  const catParam   = c.req.query('category') || ''
  const limit      = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '20')))

  let mlCategoryId = catParam
  if (ML_CATEGORIES[catParam]) {
    mlCategoryId = ML_CATEGORIES[catParam].mlId
  }

  const cacheKey = `ml_deals:${mlCategoryId}:${limit}`
  if (CACHE) {
    const cached = await CACHE.get(cacheKey, 'json').catch(() => null)
    if (cached) return c.json(cached as any)
  }

  const token = await getStoredToken(c.env)
  if (!token) {
    return c.json({ error: 'Token ML não disponível' }, 503)
  }

  try {
    // Busca com sort=price_desc primeiro (mais vendidos tendem a ter ofertas melhores)
    // Depois filtra por desconto real
    const params = new URLSearchParams({
      limit: '50', // busca 50 para filtrar os que têm desconto
      sort:  'relevance',
    })
    if (mlCategoryId) params.set('category', mlCategoryId)

    const res = await fetch(`${ML_API}/sites/MLB/search?${params}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/json',
        'User-Agent':    'KainowRadar/1.0',
      },
    })

    if (!res.ok) {
      return c.json({ error: `ML API HTTP ${res.status}` }, res.status as any)
    }

    const data: any = await res.json()
    const items: any[] = data.results || []

    // Filtra apenas itens com desconto real, ordena por desconto desc
    const withDiscount = items
      .map((item: any) => {
        const orig     = item.original_price || 0
        const price    = item.price || 0
        const discount = (orig > price && orig > 0)
          ? Math.round((1 - price / orig) * 100)
          : 0
        const permalink = item.permalink || ''
        const affUrl    = permalink ? toAffUrl(permalink) : ''
        return {
          id:             item.id,
          title:          item.title,
          price,
          original_price: orig || null,
          discount_pct:   discount,
          thumbnail:      (item.thumbnail || '').replace('-I.jpg', '-O.jpg'),
          permalink,
          affiliate_url:  affUrl,
          free_shipping:  item.shipping?.free_shipping || false,
          sold_quantity:  item.sold_quantity || 0,
        }
      })
      .filter((item) => item.discount_pct > 0)
      .sort((a, b) => b.discount_pct - a.discount_pct)
      .slice(0, limit)

    const payload = {
      category_id: mlCategoryId || null,
      total:       withDiscount.length,
      results:     withDiscount,
      note:        withDiscount.length === 0
        ? 'Nenhum item com desconto encontrado nesta categoria'
        : null,
    }

    // Cache 3h
    if (CACHE && withDiscount.length > 0) {
      await CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 10800 }).catch(() => {})
    }

    return c.json(payload)
  } catch (e: any) {
    return c.json({ error: e.message || 'Erro interno' }, 500)
  }
})

// ── GET /api/ml/search — Busca livre na API ML com cache ──
// Repassa a busca interna do site para a API do ML
// Query params:
//   q      = termo de busca (obrigatório)
//   limit  = 1-50 (padrão 20)
//   offset = paginação
//   sort   = relevance | price_asc | price_desc | sales_high
ml.get('/search', async (c) => {
  const { CACHE } = c.env
  const q         = (c.req.query('q') || '').trim()
  const limit     = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '20')))
  const offset    = Math.max(0, parseInt(c.req.query('offset') || '0'))
  const sortParam = c.req.query('sort') || 'relevance'

  if (!q || q.length < 2) {
    return c.json({ error: 'Parâmetro q é obrigatório (mínimo 2 caracteres)' }, 400)
  }

  const cacheKey = `ml_search:${q.toLowerCase()}:${limit}:${offset}:${sortParam}`
  if (CACHE) {
    const cached = await CACHE.get(cacheKey, 'json').catch(() => null)
    if (cached) return c.json(cached as any)
  }

  const token = await getStoredToken(c.env)
  if (!token) {
    return c.json({ error: 'Token ML não disponível', auth_url: '/api/ml/auth' }, 503)
  }

  const sortMap: Record<string, string> = {
    relevance:  'relevance',
    price_asc:  'price_asc',
    price_desc: 'price_desc',
    sales_high: 'sold_quantity_desc',
  }

  const params = new URLSearchParams({
    q:      q,
    limit:  String(limit),
    offset: String(offset),
    sort:   sortMap[sortParam] || 'relevance',
  })

  try {
    const res = await fetch(`${ML_API}/sites/MLB/search?${params}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/json',
        'User-Agent':    'KainowRadar/1.0',
      },
    })

    if (!res.ok) {
      const err: any = await res.json().catch(() => ({}))
      const isForbidden = res.status === 403
      return c.json({
        error:  isForbidden
          ? 'API ML: acesso negado ao /sites/MLB/search (app em modo test). Use import-url com IDs diretos.'
          : (err.message || err.error || `ML API HTTP ${res.status}`),
        status: res.status,
        hint:   isForbidden ? 'Para desbloquear, o app precisa ser aprovado no painel ML.' : undefined,
      }, res.status as any)
    }

    const data: any = await res.json()
    const items: any[] = data.results || []

    const results = items.map((item: any) => {
      const orig      = item.original_price || 0
      const price     = item.price || 0
      const permalink = item.permalink || ''
      const affUrl    = permalink ? toAffUrl(permalink) : ''
      return {
        id:             item.id,
        title:          item.title,
        price,
        original_price: orig || null,
        discount_pct:   (orig > price && orig > 0) ? Math.round((1 - price / orig) * 100) : null,
        thumbnail:      (item.thumbnail || '').replace('-I.jpg', '-O.jpg'),
        permalink,
        affiliate_url:  affUrl,
        free_shipping:  item.shipping?.free_shipping || false,
        condition:      item.condition,
        sold_quantity:  item.sold_quantity || 0,
        category_id:    item.category_id || '',
      }
    })

    const payload = {
      query:   q,
      total:   data.paging?.total || results.length,
      offset:  data.paging?.offset || offset,
      limit:   data.paging?.limit  || limit,
      sort:    sortParam,
      results,
    }

    // Cache 2h para buscas frequentes
    if (CACHE && results.length > 0) {
      await CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 7200 }).catch(() => {})
    }

    return c.json(payload)
  } catch (e: any) {
    return c.json({ error: e.message || 'Erro interno' }, 500)
  }
})

// ── GET /api/ml/item/:id — Detalhe de item único com link afiliado ──
ml.get('/item/:id', async (c) => {
  const { CACHE } = c.env
  const itemId    = c.req.param('id').toUpperCase()

  if (!itemId.startsWith('MLB')) {
    return c.json({ error: 'ID inválido — deve começar com MLB' }, 400)
  }

  const cacheKey = `ml_item:${itemId}`
  if (CACHE) {
    const cached = await CACHE.get(cacheKey, 'json').catch(() => null)
    if (cached) return c.json(cached as any)
  }

  const token = await getStoredToken(c.env)
  if (!token) {
    return c.json({ error: 'Token ML não disponível' }, 503)
  }

  try {
    const item = await fetchMLItem(itemId, token)
    if (!item) return c.json({ error: `Item ${itemId} não encontrado` }, 404)

    const permalink = item.permalink || ''
    const affUrl    = permalink ? toAffUrl(permalink) : ''

    const payload = {
      id:             item.id,
      title:          item.title,
      price:          item.price,
      original_price: item.original_price || null,
      discount_pct:   (item.original_price && item.price)
        ? Math.round((1 - item.price / item.original_price) * 100)
        : null,
      thumbnail:      (item.thumbnail || '').replace('-I.jpg', '-O.jpg'),
      permalink,
      affiliate_url:  affUrl,
      free_shipping:  item.shipping?.free_shipping || false,
      condition:      item.condition,
      sold_quantity:  item.sold_quantity || 0,
      category_id:    item.category_id || '',
      status:         item.status || '',
      attributes:     (item.attributes || []).slice(0, 10).map((a: any) => ({
        id:   a.id,
        name: a.name,
        value: a.value_name,
      })),
    }

    // Cache 1h para itens individuais
    if (CACHE) {
      await CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 3600 }).catch(() => {})
    }

    return c.json(payload)
  } catch (e: any) {
    return c.json({ error: e.message || 'Erro interno' }, 500)
  }
})

// ── POST /admin/api/ml/enrich-products ───────────────────
// Busca imagem, preço e categoria via scraping HTML da página do ML
// (o Worker roda no edge do Cloudflare — passa pelo bot check do ML)
// Body: { product_ids: number[] }  ← IDs do banco (products.id)
//   ou: { ml_ids: string[] }       ← IDs do ML diretamente (MLB...)
// Atualiza image_url, best_price, category e offer.price no banco
ml.post('/enrich-products', async (c) => {
  const { DB } = c.env
  const body: any = await c.req.json().catch(() => ({}))

  // Aceita product_ids (IDs do banco) ou ml_ids (IDs do ML)
  const productIds: number[] = Array.isArray(body.product_ids) ? body.product_ids : []
  const mlIdsRaw:  string[]  = Array.isArray(body.ml_ids)      ? body.ml_ids      : []

  // Resolve produtos a enriquecer
  let toProcess: Array<{ id: number; ml_item_id: string; name: string; affiliate_url: string | null }> = []

  if (productIds.length) {
    const placeholders = productIds.map(() => '?').join(',')
    const { results } = await DB.prepare(
      `SELECT id, ml_item_id, name, affiliate_url FROM products WHERE id IN (${placeholders}) AND ml_item_id IS NOT NULL AND ml_item_id != ''`
    ).bind(...productIds).all<{ id: number; ml_item_id: string; name: string; affiliate_url: string | null }>()
    toProcess = results
  } else if (mlIdsRaw.length) {
    const placeholders = mlIdsRaw.map(() => '?').join(',')
    const { results } = await DB.prepare(
      `SELECT id, ml_item_id, name, affiliate_url FROM products WHERE ml_item_id IN (${placeholders})`
    ).bind(...mlIdsRaw).all<{ id: number; ml_item_id: string; name: string; affiliate_url: string | null }>()
    toProcess = results
  } else {
    // Sem filtro: pega todos que têm ml_item_id mas não têm imagem ou preço
    const { results } = await DB.prepare(
      `SELECT id, ml_item_id, name, affiliate_url FROM products
       WHERE ml_item_id IS NOT NULL AND ml_item_id != ''
         AND (image_url IS NULL OR image_url = '' OR best_price IS NULL OR best_price = 0)
       ORDER BY id DESC LIMIT 50`
    ).all<{ id: number; ml_item_id: string; name: string; affiliate_url: string | null }>()
    toProcess = results
  }

  if (!toProcess.length) {
    return c.json({ ok: true, message: 'Nenhum produto para enriquecer', enriched: 0 })
  }

  // ── Helper: scraping HTML da página do produto no ML ─────
  // O Worker roda no edge do Cloudflare — IP não é datacenter,
  // então passa pelo bot check do ML melhor que servidores tradicionais
  async function scrapeMLPage(mlId: string): Promise<{
    image: string | null
    price: number | null
    category: string | null
    title: string | null
  }> {
    // Mapa de category_id ML → slug local (via breadcrumb no HTML)
    const CAT_KEYWORDS: Array<[RegExp, string]> = [
      [/smartphone|celular|iphone|galaxy/i,          'smartphones'],
      [/notebook|laptop/i,                           'notebooks'],
      [/tablet|ipad/i,                               'tablets'],
      [/tv|tele|smart.*tv/i,                         'tv'],
      [/game|console|playstation|xbox|nintendo/i,    'games'],
      [/fone|headphone|caixa.*som|audio|speaker/i,   'audio'],
      [/câmera|camera|drone/i,                       'cameras'],
      [/eletrodoméstic|geladeira|fogão|lavadora/i,   'eletrodomesticos'],
      [/informática|computador|desktop|monitor|teclado|mouse|impressora/i, 'informatica'],
      [/moda|roupa|sapato|tênis|calçado/i,           'moda-calcados'],
      [/acessório.*auto|pneu|rodas?|aplique.*roda|tapete.*carro|cacamba|strada/i, 'acessorios-automotivos'],
      [/beleza|perfume|cosmético|maquiagem|cabelo|shampoo/i, 'beleza'],
      [/saúde|suplemento|vitamina|medicamento/i,     'saude'],
    ]

    try {
      // Tenta pelo item_id real (MLB + 10 dígitos)
      const pageUrl = `https://www.mercadolivre.com.br/p/${mlId}`
      const res = await fetch(pageUrl, {
        headers: {
          'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control':   'no-cache',
          'Referer':         'https://www.mercadolivre.com.br/',
        },
        redirect: 'follow',
      })

      if (!res.ok) return { image: null, price: null, category: null, title: null }

      const html = await res.text()
      if (html.length < 5000) return { image: null, price: null, category: null, title: null }

      // ── Imagem: og:image meta tag ────────────────────────
      const imgMatch = html.match(/property="og:image"\s+content="([^"]+)"/)
                    || html.match(/content="([^"]+)"\s+property="og:image"/)
      const image = imgMatch?.[1]?.replace('-OO.', '-O.') || null

      // ── Preço: várias estratégias ────────────────────────
      let price: number | null = null

      // 1. meta og:price:amount
      const ogPrice = html.match(/property="og:price:amount"\s+content="([^"]+)"/)
                   || html.match(/content="([^"]+)"\s+property="og:price:amount"/)
      if (ogPrice) price = parseFloat(ogPrice[1].replace(',', '.')) || null

      // 2. itemprop="price"
      if (!price) {
        const itemPrice = html.match(/itemprop="price"\s+content="([^"]+)"/)
        if (itemPrice) price = parseFloat(itemPrice[1]) || null
      }

      // 3. JSON-LD price
      if (!price) {
        const jsonLd = html.match(/"price"\s*:\s*([\d.]+)/)
        if (jsonLd) price = parseFloat(jsonLd[1]) || null
      }

      // 4. Padrão visual "R$\s*XXX" no HTML
      if (!price) {
        const visPrice = html.match(/R\$\s*([\d]{2,4}(?:[.,]\d{3})*(?:[.,]\d{2})?)/)
        if (visPrice) {
          price = parseFloat(visPrice[1].replace(/\./g, '').replace(',', '.')) || null
        }
      }

      // ── Título ────────────────────────────────────────────
      const titleMatch = html.match(/<title>([^<]+)<\/title>/)
      const title = titleMatch?.[1]?.split('|')[0]?.trim() || null

      // ── Categoria: via título + breadcrumb + keywords ────
      let category: string | null = null

      // Breadcrumb no HTML
      const breadText = html.match(/andes-breadcrumb[^>]*>([\s\S]{0,500})<\/nav>/)?.[1]
                     || html.match(/breadcrumb[^>]*>([\s\S]{0,300})<\/[ou]l>/)?.[1]
                     || ''
      const breadClean = breadText.replace(/<[^>]+>/g, ' ').toLowerCase()

      // Testa keywords no breadcrumb + título
      const testText = (breadClean + ' ' + (title || '')).toLowerCase()
      for (const [regex, slug] of CAT_KEYWORDS) {
        if (regex.test(testText)) { category = slug; break }
      }

      return { image, price, category, title }
    } catch {
      return { image: null, price: null, category: null, title: null }
    }
  }

  // ── Processa cada produto ─────────────────────────────────
  const enriched: any[] = []
  const failed:   any[] = []

  for (const product of toProcess) {
    try {
      const data = await scrapeMLPage(product.ml_item_id)

      // Monta SET dinâmico — só atualiza campos que vieram
      const updates: string[] = []
      const values:  any[]    = []

      if (data.image) {
        updates.push('image_url = ?')
        values.push(data.image)
      }
      if (data.price && data.price > 0) {
        updates.push('best_price = ?')
        values.push(data.price)
      }
      if (data.category) {
        updates.push('category = ?')
        values.push(data.category)
      }
      if (data.title && (!product.name || product.name === product.ml_item_id)) {
        updates.push('name = ?')
        values.push(data.title)
      }

      if (updates.length) {
        updates.push('updated_at = CURRENT_TIMESTAMP')
        values.push(product.id)
        await DB.prepare(
          `UPDATE products SET ${updates.join(', ')} WHERE id = ?`
        ).bind(...values).run()

        // Atualiza offer com preço e imagem se tiver
        if (data.price && data.price > 0) {
          await DB.prepare(`
            UPDATE offers SET price = ?, image_url = COALESCE(?, image_url),
              in_stock = 1, last_updated = CURRENT_TIMESTAMP
            WHERE product_id = ? AND store_id = 3
          `).bind(data.price, data.image || null, product.id).run()

          await DB.prepare(`
            UPDATE products SET best_price = ?, best_store_id = 3,
              offer_count = 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND (best_price IS NULL OR best_price = 0)
          `).bind(data.price, product.id).run()
        }

        enriched.push({
          product_id: product.id,
          ml_id:      product.ml_item_id,
          name:       product.name,
          image:      data.image,
          price:      data.price,
          category:   data.category,
        })
      } else {
        failed.push({ product_id: product.id, ml_id: product.ml_item_id, reason: 'sem dados no HTML' })
      }

      // Delay entre requisições para não ser bloqueado
      await new Promise(r => setTimeout(r, 500))
    } catch (e: any) {
      failed.push({ product_id: product.id, ml_id: product.ml_item_id, reason: e.message })
    }
  }

  return c.json({
    ok:       true,
    enriched: enriched.length,
    failed:   failed.length,
    items:    enriched,
    failures: failed,
    message:  `${enriched.length} enriquecidos, ${failed.length} sem dados`,
  })
})

// ── POST /admin/api/ml/price-sync ────────────────────────
// Busca preço via scraping HTML da página pública do ML — sem API, sem token
// Body: { product_ids?: number[], ml_ids?: string[] }
// Sem filtro: processa todos sem preço (best_price NULL ou 0), limit 30
ml.post('/price-sync', async (c) => {
  const { DB } = c.env
  const body: any        = await c.req.json().catch(() => ({}))
  const productIds: number[] = Array.isArray(body.product_ids) ? body.product_ids : []
  const mlIdsRaw: string[]   = Array.isArray(body.ml_ids)      ? body.ml_ids      : []

  // ── 1. Monta lista de produtos ────────────────────────────
  let rows: Array<{ id: number; ml_item_id: string; name: string; affiliate_url: string | null }> = []

  if (productIds.length) {
    const ph = productIds.map(() => '?').join(',')
    const { results } = await DB.prepare(
      `SELECT id, ml_item_id, name, affiliate_url FROM products
       WHERE id IN (${ph}) AND ml_item_id IS NOT NULL AND ml_item_id != ''`
    ).bind(...productIds).all<any>()
    rows = results
  } else if (mlIdsRaw.length) {
    const ph = mlIdsRaw.map(() => '?').join(',')
    const { results } = await DB.prepare(
      `SELECT id, ml_item_id, name, affiliate_url FROM products
       WHERE ml_item_id IN (${ph})`
    ).bind(...mlIdsRaw).all<any>()
    rows = results
  } else {
    const { results } = await DB.prepare(`
      SELECT id, ml_item_id, name, affiliate_url FROM products
      WHERE ml_item_id IS NOT NULL AND ml_item_id != ''
        AND (best_price IS NULL OR best_price = 0)
      ORDER BY id DESC LIMIT 30
    `).all<any>()
    rows = results
  }

  if (!rows.length) {
    return c.json({ ok: true, message: 'Nenhum produto para sincronizar', updated: 0 })
  }

  // ── 2. Scraper HTML — extrai preço e imagem da página pública ──
  async function scrapePriceFromML(mlId: string, affUrl: string | null): Promise<{
    price: number | null
    image: string | null
    title: string | null
  }> {
    // item_id real = MLB + 10 dígitos → URL correta é /MLB-XXXXXXXXXX-_JM
    // catalog_id   = MLB + 5-9 dígitos → URL correta é /p/MLB...
    const numDigits = mlId.replace(/^MLB/i, '').length
    const isItemId  = numDigits >= 10

    // Monta URL base correta conforme tipo de ID
    let pageUrl: string
    if (isItemId) {
      // Item real — acessível em mercadolivre.com.br/MLB-XXXXXXXXXX-_JM
      pageUrl = `https://www.mercadolivre.com.br/${mlId}-_JM`
    } else if (affUrl && !/\/p\//.test(affUrl)) {
      // affiliate_url que não aponta pra catálogo — usa direto
      pageUrl = affUrl.split('?')[0]
    } else {
      // Catálogo
      pageUrl = `https://www.mercadolivre.com.br/p/${mlId}`
    }

    try {
      const res = await fetch(pageUrl, {
        headers: {
          'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
          'Cache-Control':   'no-cache',
          'Referer':         'https://www.mercadolivre.com.br/',
        },
        redirect: 'follow',
      })

      if (!res.ok) return { price: null, image: null, title: null }

      const html = await res.text()
      if (html.length < 5000) return { price: null, image: null, title: null }

      // ── Preço: 4 estratégias em cascata ─────────────────────
      let price: number | null = null

      // 1) og:price:amount
      const ogPrice = html.match(/property="og:price:amount"\s+content="([^"]+)"/)
                   || html.match(/content="([^"]+)"\s+property="og:price:amount"/)
      if (ogPrice) price = parseFloat(ogPrice[1].replace(',', '.')) || null

      // 2) itemprop="price" content="..."
      if (!price) {
        const itemProp = html.match(/itemprop="price"\s+content="([^"]+)"/)
                      || html.match(/content="([^"]+)"\s+itemprop="price"/)
        if (itemProp) price = parseFloat(itemProp[1].replace(',', '.')) || null
      }

      // 3) JSON-LD "price": 123.45
      if (!price) {
        const jsonLd = html.match(/"price"\s*:\s*([\d]+(?:\.\d+)?)/)
        if (jsonLd) price = parseFloat(jsonLd[1]) || null
      }

      // 4) Padrão visual "R$ 1.234,56" — fallback
      if (!price) {
        const visPrice = html.match(/R\$\s*([\d]{1,4}(?:[.,]\d{3})*(?:[.,]\d{2}))/)
        if (visPrice) {
          price = parseFloat(visPrice[1].replace(/\./g, '').replace(',', '.')) || null
        }
      }

      // ── Imagem: og:image ─────────────────────────────────────
      const imgMatch = html.match(/property="og:image"\s+content="([^"]+)"/)
                    || html.match(/content="([^"]+)"\s+property="og:image"/)
      const image = imgMatch?.[1]?.replace('-OO.', '-O.') || null

      // ── Título ───────────────────────────────────────────────
      const titleMatch = html.match(/<title>([^<]+)<\/title>/)
      const title = titleMatch?.[1]?.split('|')[0]?.trim() || null

      return { price, image, title }
    } catch {
      return { price: null, image: null, title: null }
    }
  }

  // ── 3. Processa cada produto ──────────────────────────────
  const mlStore = await DB.prepare(`SELECT id FROM stores WHERE slug = 'mercadolivre' LIMIT 1`).first<{ id: number }>()
  const storeId = mlStore?.id ?? 3

  const updated: any[] = []
  const failed:  any[] = []

  for (const row of rows) {
    try {
      const { price, image, title } = await scrapePriceFromML(row.ml_item_id, row.affiliate_url)

      if (!price) {
        failed.push({ product_id: row.id, ml_id: row.ml_item_id, name: row.name, reason: 'preço não encontrado no HTML' })
        await new Promise(r => setTimeout(r, 300))
        continue
      }

      // Upsert na tabela offers
      const existing = await DB.prepare(
        `SELECT id FROM offers WHERE product_id = ? AND store_id = ? LIMIT 1`
      ).bind(row.id, storeId).first<{ id: number }>()

      if (existing) {
        await DB.prepare(`
          UPDATE offers SET
            price        = ?,
            image_url    = COALESCE(?, image_url),
            in_stock     = 1,
            last_updated = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(price, image, existing.id).run()
      } else {
        await DB.prepare(`
          INSERT INTO offers
            (product_id, store_id, external_id, title, price, product_url, image_url, is_active, in_stock, last_updated)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, CURRENT_TIMESTAMP)
        `).bind(row.id, storeId, row.ml_item_id, title || row.name, price, row.affiliate_url, image).run()
      }

      // Atualiza produto
      await DB.prepare(`
        UPDATE products SET
          best_price    = ?,
          best_store_id = ?,
          offer_count   = COALESCE(offer_count, 0) + CASE WHEN (SELECT COUNT(*) FROM offers WHERE product_id = ? AND store_id = ?) = 0 THEN 1 ELSE 0 END,
          image_url     = COALESCE(NULLIF(image_url, ''), ?),
          updated_at    = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(price, storeId, row.id, storeId, image, row.id).run()

      updated.push({ product_id: row.id, ml_id: row.ml_item_id, name: row.name, price })
      await new Promise(r => setTimeout(r, 400))

    } catch (e: any) {
      failed.push({ product_id: row.id, ml_id: row.ml_item_id, name: row.name, reason: e?.message || 'exception' })
    }
  }

  return c.json({
    ok:      true,
    updated: updated.length,
    failed:  failed.length,
    items:   updated,
    errors:  failed,
    message: `${updated.length} preços atualizados via scraping, ${failed.length} falhas`,
  })
})

// ── GET /admin/api/ml/debug-item?id=MLB... ───────────────
// Testa vários endpoints do ML com token real para diagnóstico
ml.get('/debug-item', async (c) => {
  const mlId = c.req.query('id') || 'MLB2627750560'
  const token = await getStoredToken(c.env).catch(() => null)

  const results: any = { ml_id: mlId, token_available: !!token, endpoints: [] }

  const authHeaders: Record<string, string> = token
    ? { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json', 'User-Agent': 'KainowRadar/1.0' }
    : { 'Accept': 'application/json' }

  // Testa vários endpoints
  const endpoints = [
    `https://api.mercadolibre.com/users/me`,
    `https://api.mercadolibre.com/items/${mlId}`,
    `https://api.mercadolibre.com/items?ids=${mlId}`,
    `https://api.mercadolibre.com/sites/MLB/search?q=${mlId}&limit=1`,
    `https://api.mercadolibre.com/sites/MLB/search?q=calca+social+gabardine&limit=2`,
  ]

  for (const ep of endpoints) {
    try {
      const r = await fetch(ep, { headers: authHeaders })
      const body = await r.text()
      results.endpoints.push({ url: ep, status: r.status, body: body.slice(0, 400) })
    } catch (e: any) {
      results.endpoints.push({ url: ep, error: e.message })
    }
  }

  return c.json(results)
})

// ── GET /admin/api/ml/debug-scrape?url=... ───────────────
// Retorna HTML bruto + extrações para diagnóstico
ml.get('/debug-scrape', async (c) => {
  const url = c.req.query('url') || 'https://www.mercadolivre.com.br/MLB2627750560-_JM'
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'Cache-Control':   'no-cache',
        'Referer':         'https://www.mercadolivre.com.br/',
      },
      redirect: 'follow',
    })

    const html   = await res.text()
    const size   = html.length
    const status = res.status
    const finalUrl = res.url

    const ogPrice   = html.match(/property="og:price:amount"\s+content="([^"]+)"/)
                   || html.match(/content="([^"]+)"\s+property="og:price:amount"/)
    const itemProp  = html.match(/itemprop="price"\s+content="([^"]+)"/)
                   || html.match(/content="([^"]+)"\s+itemprop="price"/)
    const jsonLd    = html.match(/"price"\s*:\s*([\d]+(?:\.\d+)?)/)
    const visPrice  = html.match(/R\$\s*([\d]{1,4}(?:[.,]\d{3})*(?:[.,]\d{2}))/)
    const ogImage   = html.match(/property="og:image"\s+content="([^"]+)"/)
                   || html.match(/content="([^"]+)"\s+property="og:image"/)
    const title     = html.match(/<title>([^<]+)<\/title>/)

    // Amostra do HTML para ver o que chegou
    const sample = html.slice(0, 2000)

    return c.json({
      status, final_url: finalUrl, size,
      extractions: {
        og_price:   ogPrice?.[1]   || null,
        item_prop:  itemProp?.[1]  || null,
        json_ld:    jsonLd?.[1]    || null,
        vis_price:  visPrice?.[1]  || null,
        og_image:   ogImage?.[1]   || null,
        title:      title?.[1]     || null,
      },
      html_sample: sample,
    })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ── POST /admin/api/ml/update-affiliate ──────────────────────────────────
// Atualiza o affiliate_url dos produtos já importados
// Body: { urls: string[] }  ← cole todos os pares (produto + /social/) de uma vez
// O sistema detecta automaticamente qual link tem cfegdhabc31955 e salva como affiliate_url
ml.post('/update-affiliate', async (c) => {
  const { DB } = c.env
  const body: any = await c.req.json().catch(() => ({}))
  const urls: string[] = Array.isArray(body.urls) ? body.urls : []

  if (!urls.length) return c.json({ error: 'Nenhuma URL enviada' }, 400)

  // Expande todas as entradas em linhas individuais (igual import-url)
  const allLines: string[] = []
  for (const raw of urls) {
    const byNewline = raw.split(/[\n,]+/).map((l: string) => l.trim()).filter(Boolean)
    for (const chunk of byNewline) {
      const parts = chunk.split(/\s+/).filter(Boolean)
      if (parts.length >= 2 && parts.every((p: string) => p.startsWith('http'))) {
        allLines.push(...parts)
      } else {
        allLines.push(chunk)
      }
    }
  }

  // Monta pares: produto + link afiliado (com cfegdhabc31955)
  interface Pair { productLine: string; affLine: string | null }
  const pairs: Pair[] = []

  for (const line of allLines) {
    const isAffiliateLink = line.includes(PUBLISHER_ID)
    if (isAffiliateLink) {
      if (pairs.length > 0 && pairs[pairs.length - 1].affLine === null) {
        pairs[pairs.length - 1].affLine = line
      }
      continue
    }
    pairs.push({ productLine: line, affLine: null })
  }

  let updated = 0, notFound = 0, noAff = 0
  const details: any[] = []

  for (const { productLine, affLine } of pairs) {
    if (!affLine) {
      noAff++
      details.push({ url: productLine.substring(0, 80), status: 'sem_link_afiliado' })
      continue
    }

    // Extrai MLB ID do link do produto
    const mlId = extractMLBId(productLine)
    if (!mlId) {
      notFound++
      details.push({ url: productLine.substring(0, 80), status: 'id_nao_encontrado' })
      continue
    }

    // Busca o offer pelo ml_item_id ou pelo slug da URL
    const row = await DB.prepare(`
      SELECT o.id FROM offers o
      JOIN products p ON o.product_id = p.id
      WHERE p.ml_item_id = ? AND o.is_active = 1
      LIMIT 1
    `).bind(mlId).first<{ id: number }>()

    if (!row) {
      // Tenta buscar pelo slug extraído da URL
      const slugHint = productLine.split('/').filter(s => s.length > 10 && !s.startsWith('http') && !s.startsWith('p') && !s.startsWith('up'))[0] || ''
      const row2 = await DB.prepare(`
        SELECT o.id FROM offers o
        JOIN products p ON o.product_id = p.id
        WHERE p.slug LIKE ? AND o.is_active = 1
        LIMIT 1
      `).bind(`%${slugHint.substring(0, 30)}%`).first<{ id: number }>()

      if (!row2) {
        notFound++
        details.push({ mlId, url: productLine.substring(0, 80), status: 'produto_nao_encontrado' })
        continue
      }

      await DB.prepare(`UPDATE offers SET affiliate_url = ?, affiliate_updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(affLine, row2.id).run()
      updated++
      details.push({ mlId, offerId: row2.id, status: 'atualizado', affiliate_url: affLine.substring(0, 80) })
      continue
    }

    await DB.prepare(`UPDATE offers SET affiliate_url = ?, affiliate_updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(affLine, row.id).run()
    updated++
    details.push({ mlId, offerId: row.id, status: 'atualizado', affiliate_url: affLine.substring(0, 80) })
  }

  return c.json({
    ok: true,
    total_pares: pairs.length,
    updated,
    not_found: notFound,
    sem_link_afiliado: noAff,
    details
  })
})

export default ml
export { ML_CATEGORIES, extractMLBId }
