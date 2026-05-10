// ============================================================
// ROUTES: Auth — Google OAuth2 + Sessões + Alertas
// ============================================================

import { Hono } from 'hono'
import type { Bindings } from '../types'

type AuthBindings = Bindings & {
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  APP_URL?: string
}

const auth = new Hono<{ Bindings: AuthBindings }>()

// ── Helpers ───────────────────────────────────────────────

function generateId(): string {
  return crypto.randomUUID()
}

function generateToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0')).join('')
}

async function hashValue(val: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(val))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function getAppUrl(env: AuthBindings, req: Request): string {
  return env.APP_URL || `https://${new URL(req.url).host}`
}

// Lê usuário pela sessão (cookie ou header)
async function getUserFromRequest(c: any): Promise<any | null> {
  const cookie = c.req.header('Cookie') || ''
  const token = cookie.match(/sc_token=([^;]+)/)?.[1] || ''
  if (!token) return null

  return c.env.DB.prepare(
    `SELECT * FROM oauth_users WHERE session_token = ? AND session_expires_at > CURRENT_TIMESTAMP`
  ).bind(token).first<any>()
}

// ── POST /auth/register — Cadastro por email/senha ───────
auth.post('/register', async (c) => {
  const { DB } = c.env
  const { name, email, password, offers_email } = await c.req.json()

  if (!name || !email || !password) {
    return c.json({ error: 'Nome, email e senha são obrigatórios' }, 400)
  }
  if (password.length < 6) {
    return c.json({ error: 'A senha deve ter pelo menos 6 caracteres' }, 400)
  }

  // Verifica se email já existe
  const existing = await DB.prepare(
    `SELECT id, auth_provider FROM oauth_users WHERE email = ?`
  ).bind(email.toLowerCase().trim()).first<any>()

  if (existing) {
    const msg = existing.auth_provider === 'google'
      ? 'Este email já está cadastrado com o Google. Use "Entrar com Google".'
      : 'Este email já está cadastrado. Faça login.'
    return c.json({ error: msg }, 409)
  }

  // Hash da senha com SHA-256 + salt (Web Crypto API disponível no Workers)
  const salt         = generateToken()
  const passwordHash = await hashValue(salt + password)
  const storedHash   = `${salt}:${passwordHash}`

  const userId         = generateId()
  const sessionToken   = generateToken()
  const sessionExpires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()

  await DB.prepare(`
    INSERT INTO oauth_users
      (id, google_id, email, full_name, avatar_url, auth_provider, password_hash,
       notify_email, offers_email, session_token, session_expires_at, email_verified)
    VALUES (?, ?, ?, ?, '', 'email', ?, 1, ?, ?, ?, 0)
  `).bind(
    userId,
    null,
    email.toLowerCase().trim(),
    name.trim(),
    storedHash,
    offers_email ? 1 : 0,
    sessionToken,
    sessionExpires,
  ).run()

  return c.json({ ok: true, redirect: '/onboarding' }, 200, {
    'Set-Cookie': `sc_token=${sessionToken}; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax; HttpOnly`,
  })
})

// ── POST /auth/login — Login por email/senha ──────────────
auth.post('/login', async (c) => {
  const { DB } = c.env
  const { email, password } = await c.req.json()

  if (!email || !password) {
    return c.json({ error: 'Email e senha são obrigatórios' }, 400)
  }

  const user = await DB.prepare(
    `SELECT * FROM oauth_users WHERE email = ?`
  ).bind(email.toLowerCase().trim()).first<any>()

  if (!user) {
    return c.json({ error: 'Email ou senha incorretos' }, 401)
  }

  if (user.auth_provider === 'google' || !user.password_hash) {
    return c.json({ error: 'Esta conta usa login com Google. Clique em "Entrar com Google".' }, 401)
  }

  // Verifica senha
  const [salt, hash] = (user.password_hash as string).split(':')
  const checkHash    = await hashValue(salt + password)
  if (checkHash !== hash) {
    return c.json({ error: 'Email ou senha incorretos' }, 401)
  }

  const sessionToken   = generateToken()
  const sessionExpires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()

  await DB.prepare(`
    UPDATE oauth_users SET
      session_token = ?, session_expires_at = ?,
      last_login_at = CURRENT_TIMESTAMP,
      login_count   = login_count + 1
    WHERE id = ?
  `).bind(sessionToken, sessionExpires, user.id).run()

  return c.json({ ok: true, redirect: '/' }, 200, {
    'Set-Cookie': `sc_token=${sessionToken}; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax; HttpOnly`,
  })
})

// ── GET /auth/google — Redireciona para Google ────────────
auth.get('/google', (c) => {
  const clientId = c.env.GOOGLE_CLIENT_ID || ''
  const appUrl   = getAppUrl(c.env, c.req.raw)
  const redirect = `${appUrl}/auth/callback`

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirect,
    response_type: 'code',
    scope:         'openid email profile',
    access_type:   'online',
    prompt:        'select_account',
  })

  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
})

// ── GET /auth/callback — Recebe código do Google ─────────
auth.get('/callback', async (c) => {
  const { DB } = c.env
  const code    = c.req.query('code')
  const error   = c.req.query('error')

  if (error || !code) {
    return c.redirect('/?auth_error=1')
  }

  const clientId     = c.env.GOOGLE_CLIENT_ID     || ''
  const clientSecret = c.env.GOOGLE_CLIENT_SECRET  || ''
  const appUrl       = getAppUrl(c.env, c.req.raw)
  const redirect     = `${appUrl}/auth/callback`

  try {
    // 1. Troca code por access_token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  redirect,
        grant_type:    'authorization_code',
      }),
    })
    const tokenData = await tokenRes.json() as any
    if (!tokenData.access_token) throw new Error('token_error')

    // 2. Busca perfil do usuário no Google
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    })
    const profile = await profileRes.json() as any
    if (!profile.id) throw new Error('profile_error')

    // 3. Upsert do usuário no banco
    const existing = await DB.prepare(
      `SELECT * FROM oauth_users WHERE google_id = ?`
    ).bind(profile.id).first<any>()

    const sessionToken   = generateToken()
    const sessionExpires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString() // 30 dias

    let userId: string
    let isNewUser = false

    if (existing) {
      userId = existing.id
      // Atualiza sessão e login
      await DB.prepare(`
        UPDATE oauth_users SET
          session_token = ?, session_expires_at = ?,
          last_login_at = CURRENT_TIMESTAMP,
          login_count = login_count + 1,
          avatar_url = ?, full_name = ?
        WHERE id = ?
      `).bind(sessionToken, sessionExpires, profile.picture || '', profile.name || '', userId).run()
    } else {
      userId    = generateId()
      isNewUser = true
      await DB.prepare(`
        INSERT INTO oauth_users
          (id, google_id, email, full_name, avatar_url, session_token, session_expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(userId, profile.id, profile.email, profile.name || '', profile.picture || '', sessionToken, sessionExpires).run()
    }

    // 4. Seta cookie de sessão (30 dias, HttpOnly, SameSite=Lax)
    const cookieValue = `sc_token=${sessionToken}; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax; HttpOnly`

    // Redireciona: novo usuário → onboarding, usuário existente → página anterior
    const destination = isNewUser ? '/onboarding' : '/'
    return new Response(null, {
      status: 302,
      headers: {
        'Location':   destination,
        'Set-Cookie': cookieValue,
      },
    })

  } catch (err) {
    console.error('OAuth error:', err)
    return c.redirect('/?auth_error=1')
  }
})

// ── GET /auth/logout ──────────────────────────────────────
auth.get('/logout', async (c) => {
  const cookie = c.req.header('Cookie') || ''
  const token  = cookie.match(/sc_token=([^;]+)/)?.[1] || ''

  if (token) {
    await c.env.DB.prepare(
      `UPDATE oauth_users SET session_token = NULL WHERE session_token = ?`
    ).bind(token).run()
  }

  return new Response(null, {
    status: 302,
    headers: {
      'Location':   '/',
      'Set-Cookie': 'sc_token=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly',
    },
  })
})

// ── GET /auth/me — Retorna usuário logado (JSON) ──────────
auth.get('/me', async (c) => {
  const user = await getUserFromRequest(c)
  if (!user) return c.json({ user: null })

  // Busca preferências de lojas
  const { results: prefs } = await c.env.DB.prepare(
    `SELECT store_id, has_account FROM user_store_prefs WHERE user_id = ?`
  ).bind(user.id).all<any>()

  // Busca alertas ativos
  const { results: alerts } = await c.env.DB.prepare(
    `SELECT id, product_id, product_name, product_slug, target_price, status, created_at
     FROM user_price_alerts WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC`
  ).bind(user.id).all<any>()

  return c.json({
    user: {
      id:              user.id,
      email:           user.email,
      full_name:       user.full_name,
      avatar_url:      user.avatar_url,
      onboarding_done: user.onboarding_done,
      notify_email:    user.notify_email,
      notify_whatsapp: user.notify_whatsapp,
      whatsapp_number: user.whatsapp_number,
    },
    store_prefs: prefs,
    alerts,
  })
})

// ── POST /auth/onboarding — Salva lojas que tem conta ─────
auth.post('/onboarding', async (c) => {
  const user = await getUserFromRequest(c)
  if (!user) return c.json({ error: 'Não autenticado' }, 401)

  const { DB } = c.env
  const { store_ids, notify_email, notify_whatsapp, whatsapp_number } = await c.req.json()

  // Busca todas as lojas
  const { results: allStores } = await DB.prepare(
    `SELECT id FROM stores WHERE is_active = 1`
  ).all<any>()

  // Upsert preferências: lojas selecionadas = has_account=1, resto = has_account=0
  for (const store of allStores) {
    const hasAccount = (store_ids || []).includes(store.id) ? 1 : 0
    await DB.prepare(`
      INSERT INTO user_store_prefs (user_id, store_id, has_account)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, store_id) DO UPDATE SET has_account = excluded.has_account
    `).bind(user.id, store.id, hasAccount).run()
  }

  // Atualiza preferências de notificação
  await DB.prepare(`
    UPDATE oauth_users SET
      onboarding_done  = 1,
      notify_email     = ?,
      notify_whatsapp  = ?,
      whatsapp_number  = ?
    WHERE id = ?
  `).bind(
    notify_email     ? 1 : 0,
    notify_whatsapp  ? 1 : 0,
    whatsapp_number  || null,
    user.id
  ).run()

  return c.json({ ok: true })
})

// ── POST /auth/alerts — Criar alerta de preço ─────────────
auth.post('/alerts', async (c) => {
  const user = await getUserFromRequest(c)
  if (!user) return c.json({ error: 'Faça login para criar alertas' }, 401)

  const { DB } = c.env
  const { product_id, target_price } = await c.req.json()

  if (!product_id || !target_price) {
    return c.json({ error: 'product_id e target_price são obrigatórios' }, 400)
  }

  // Busca dados do produto
  const product = await DB.prepare(
    `SELECT id, name, slug, image_url, best_price FROM products WHERE id = ? AND is_active = 1`
  ).bind(product_id).first<any>()

  if (!product) return c.json({ error: 'Produto não encontrado' }, 404)

  // Verifica se já tem alerta ativo para esse produto
  const existing = await DB.prepare(
    `SELECT id FROM user_price_alerts WHERE user_id = ? AND product_id = ? AND status = 'active'`
  ).bind(user.id, product_id).first<any>()

  if (existing) {
    // Atualiza o alerta existente
    await DB.prepare(
      `UPDATE user_price_alerts SET target_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(target_price, existing.id).run()
    return c.json({ ok: true, alert_id: existing.id, updated: true })
  }

  // Cria novo alerta
  const result = await DB.prepare(`
    INSERT INTO user_price_alerts
      (user_id, product_id, product_name, product_slug, product_image, target_price, current_price, notify_email, notify_whatsapp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    user.id,
    product.id,
    product.name,
    product.slug,
    product.image_url || '',
    target_price,
    product.best_price || null,
    user.notify_email,
    user.notify_whatsapp,
  ).run()

  return c.json({ ok: true, alert_id: result.meta.last_row_id, created: true })
})

// ── DELETE /auth/alerts/:id — Remover alerta ──────────────
auth.delete('/alerts/:id', async (c) => {
  const user = await getUserFromRequest(c)
  if (!user) return c.json({ error: 'Não autenticado' }, 401)

  const id = parseInt(c.req.param('id'))
  await c.env.DB.prepare(
    `UPDATE user_price_alerts SET status = 'deleted' WHERE id = ? AND user_id = ?`
  ).bind(id, user.id).run()

  return c.json({ ok: true })
})

// ── GET /auth/alerts — Lista alertas do usuário ───────────
auth.get('/alerts', async (c) => {
  const user = await getUserFromRequest(c)
  if (!user) return c.json({ error: 'Não autenticado' }, 401)

  const { results } = await c.env.DB.prepare(`
    SELECT a.*, p.image_url as product_image, p.best_price as current_price,
           s.name as best_store_name
    FROM user_price_alerts a
    JOIN products p ON p.id = a.product_id
    LEFT JOIN stores s ON s.id = p.best_store_id
    WHERE a.user_id = ? AND a.status != 'deleted'
    ORDER BY a.created_at DESC
  `).bind(user.id).all<any>()

  return c.json(results)
})

// ── POST /auth/cron/check-alerts — Cron de preços ─────────
// Chamado diariamente — verifica alertas e dispara emails
auth.post('/cron/check-alerts', async (c) => {
  // Proteção: só aceita chamada interna (Bearer = ADMIN_SECRET)
  const auth_header = c.req.header('Authorization') || ''
  const secret      = (c.env as any).ADMIN_SECRET || 'admin123'
  if (!auth_header.includes(secret)) {
    return c.json({ error: 'Não autorizado' }, 401)
  }

  const { DB } = c.env
  let triggered = 0

  // Busca alertas ativos onde o preço atual <= preço alvo
  const { results: alerts } = await DB.prepare(`
    SELECT a.*, u.email, u.full_name, u.notify_email, u.whatsapp_number, u.notify_whatsapp,
           p.best_price, p.name as product_name, p.slug as product_slug, p.image_url,
           s.name as store_name
    FROM user_price_alerts a
    JOIN oauth_users u  ON u.id = a.user_id
    JOIN products p     ON p.id = a.product_id
    LEFT JOIN stores s  ON s.id = p.best_store_id
    WHERE a.status = 'active'
      AND p.best_price IS NOT NULL
      AND p.best_price <= a.target_price
  `).all<any>()

  for (const alert of alerts) {
    // Marca como disparado
    await DB.prepare(`
      UPDATE user_price_alerts SET
        status = 'triggered',
        triggered_at = CURRENT_TIMESTAMP,
        triggered_price = ?,
        triggered_store = ?
      WHERE id = ?
    `).bind(alert.best_price, alert.store_name || '', alert.id).run()

    // Loga notificação (email será enviado por webhook externo ou Resend)
    if (alert.notify_email && alert.email) {
      await DB.prepare(`
        INSERT INTO notification_log (user_id, alert_id, type, channel, recipient, subject)
        VALUES (?, ?, 'price_alert', 'email', ?, ?)
      `).bind(
        alert.user_id,
        alert.id,
        alert.email,
        `🔔 ${alert.product_name} baixou para R$ ${alert.best_price?.toFixed(2)}!`
      ).run()
    }

    triggered++
  }

  return c.json({ ok: true, triggered, total_checked: alerts.length })
})

export { getUserFromRequest }
export default auth
