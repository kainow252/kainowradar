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

// ── GET /admin/api/ml/token-debug — Diagnóstico de token ─
ml.get('/token-debug', async (c) => {
  const appId  = (c.env as any).ML_APP_ID  || APP_ID
  const secret = (c.env as any).ML_SECRET  || ''
  const oauthKV  = await c.env.CACHE?.get('ml_access_token').catch(() => null)
  const appToken = await c.env.CACHE?.get('ml_app_token').catch(() => null)
  const refreshKV = await c.env.CACHE?.get('ml_refresh_token').catch(() => null)

  // Tenta client_credentials ao vivo
  let ccResult: any = null
  if (secret) {
    const r = await fetch(ML_API + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: appId, client_secret: secret }),
    })
    ccResult = { status: r.status, body: await r.json().catch(() => null) }
  }

  // Tenta GET /items/{id} com o melhor token disponível
  const token = appToken || oauthKV || ccResult?.body?.access_token
  let itemTest: any = null
  if (token) {
    const r = await fetch(ML_API + '/items/MLB3990393083?attributes=id,title,price', {
      headers: { 'Authorization': 'Bearer ' + token }
    })
    itemTest = { status: r.status, body: await r.json().catch(() => null) }
  }

  return c.json({
    has_secret:      !!secret,
    has_oauth_kv:    !!oauthKV,
    has_app_token_kv: !!appToken,
    has_refresh_kv:  !!refreshKV,
    app_id:          appId,
    cc_result:       ccResult,
    item_test:       itemTest,
  })
})

// ── POST /admin/api/ml/import-url ────────────────────────
// Importa produtos a partir de URLs do ML (ou IDs diretos)
// Body: { urls: string[], category?: string }
// Aceita:
//   - https://www.mercadolivre.com.br/.../MLB1234567890-_JM
//   - https://produto.mercadolivre.com.br/MLB-1234-titulo
//   - https://www.mercadolivre.com.br/produto/p/MLB28965210
//   - MLB1234567890  (ID direto)
ml.post('/import-url', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any
  const urls: string[]     = Array.isArray(body.urls) ? body.urls : []
  const categoryHint: string = body.category || 'outros'

  if (!urls.length) {
    return c.json({ error: 'Envie pelo menos uma URL ou ID no campo "urls".' }, 400)
  }

  // getStoredToken tenta: OAuth KV → refresh_token → client_credentials
  // client_credentials usa ML_SECRET (Cloudflare secret) — sem OAuth do usuario
  const token = await getStoredToken(c.env)
  if (!token) {
    return c.json({
      error: 'Sem token ML. Configure ML_SECRET no Cloudflare ou reconecte via /api/ml/auth.',
      auth_url: '/api/ml/auth',
    }, 401)
  }

  const { DB } = c.env

  // Extrai IDs únicos das URLs (resolve encurtadores antes de parsear)
  const ids: string[] = []
  const parseErrors: string[] = []

  // Expande todas as entradas em linhas individuais
  const allLines: string[] = []
  for (const raw of urls) {
    const lines = raw.split(new RegExp('[\n,]+')).map((l: string) => l.trim()).filter(Boolean)
    allLines.push(...lines)
  }

  // Resolve encurtadores em paralelo (meli.la/xxx → URL real)
  const resolvedLines = await Promise.all(
    allLines.map(async (line) => {
      if (line.startsWith('http') && isShortUrl(line)) {
        return await resolveShortUrl(line)
      }
      return line
    })
  )

  for (const line of resolvedLines) {
    // Detecta URL de perfil de afiliado (/social/...) — erro explicativo
    if (/mercadolivre\.com\.br\/social\//.test(line)) {
      parseErrors.push(
        `URL de PERFIL detectada (não é um produto): ${line.substring(0, 60)}...\n` +
        `→ No linkbuilder, clique em "Gerar link" em cada produto e copie o link individual, não o link do seu perfil.`
      )
      continue
    }

    const id = extractMLBId(line)
    if (id && !ids.includes(id)) {
      ids.push(id)
    } else if (!id) {
      parseErrors.push(`Não foi possível extrair ID de: ${line.substring(0, 60)}`)
    }
  }

  if (!ids.length) {
    // Verifica se o erro foi por URL de perfil
    const isProfileUrl = parseErrors.some(e => e.includes('URL de PERFIL'))
    return c.json({
      error: isProfileUrl
        ? 'Você colou o link do seu PERFIL de afiliado, não o link de um produto.\nNo linkbuilder, clique em \'Gerar link\' em cada produto e copie o link gerado.'
        : 'Nenhum ID válido encontrado nas URLs fornecidas.',
      parse_errors: parseErrors,
      hint: isProfileUrl ? 'profile_url' : 'invalid_url',
    }, 400)
  }

  // Busca todos os items em lotes de 20 (multi-get)
  const items = await fetchMLItemsMulti(ids, token)

  let created = 0
  let updated = 0
  let skipped = 0
  const details: any[] = []

  for (const item of items) {
    // Detecta categoria pelo category_id do item
    const catSlug = Object.entries(ML_CATEGORIES)
      .find(([, v]) => (item.category_id || '').startsWith(v.mlId.substring(0, 6)))?.[0]
      || categoryHint

    const { id, action } = await saveProductToDB(DB, item, catSlug)

    if      (action === 'created') created++
    else if (action === 'updated') updated++
    else                           skipped++

    details.push({
      ml_id:      item.id,
      name:       item.title,
      price:      item.price,
      category:   catSlug,
      action,
      product_id: id,
    })

    await new Promise(r => setTimeout(r, 50))
  }

  // IDs que não retornaram da API (inválidos ou não encontrados)
  const returnedIds  = items.map((i: any) => i.id)
  const notFoundIds  = ids.filter(id => !returnedIds.includes(id))

  return c.json({
    ok:          true,
    created,
    updated,
    skipped,
    not_found:   notFoundIds,
    parse_errors: parseErrors,
    items:       details,
    message:     `${created} criados, ${updated} atualizados, ${skipped} ignorados${notFoundIds.length ? `, ${notFoundIds.length} IDs não encontrados` : ''}`,
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
