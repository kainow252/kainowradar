// ============================================================
// SERVICE WORKER — MelhorPreço PWA
// Cache-first para assets estáticos, network-first para API
// ============================================================

const SW_VERSION = 'v1.0.0'
const STATIC_CACHE  = `mp-static-${SW_VERSION}`
const DYNAMIC_CACHE = `mp-dynamic-${SW_VERSION}`
const OFFLINE_URL   = '/offline'

// Assets que sempre ficam em cache
const PRECACHE_ASSETS = [
  '/',
  '/offline',
  '/static/style.css',
  '/manifest.json',
  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css',
]

// ── Install: pré-carrega assets estáticos ─────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch(() => {
        // Ignora falhas individuais (CDN pode falhar offline)
      })
    }).then(() => self.skipWaiting())
  )
})

// ── Activate: limpa caches antigos ───────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== STATIC_CACHE && k !== DYNAMIC_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  )
})

// ── Fetch: estratégia por tipo de recurso ─────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  // Ignora requests não-GET e cross-origin (exceto CDNs conhecidos)
  if (request.method !== 'GET') return
  if (url.origin !== location.origin &&
      !url.hostname.includes('cdn.jsdelivr.net') &&
      !url.hostname.includes('cdn.tailwindcss.com') &&
      !url.hostname.includes('logo.clearbit.com')) return

  // API: Network-first, sem cache
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkOnly(request))
    return
  }

  // Admin: Network-first (sempre atualizado)
  if (url.pathname.startsWith('/admin')) {
    event.respondWith(networkFirst(request))
    return
  }

  // Assets estáticos: Cache-first
  if (url.pathname.startsWith('/static/') ||
      url.pathname === '/manifest.json' ||
      url.pathname === '/favicon.ico' ||
      url.hostname.includes('cdn.')) {
    event.respondWith(cacheFirst(request))
    return
  }

  // Páginas HTML: Stale-while-revalidate
  event.respondWith(staleWhileRevalidate(request))
})

// ── Estratégias de cache ──────────────────────────────────

async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) return cached
  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE)
      cache.put(request, response.clone())
    }
    return response
  } catch {
    return new Response('Recurso não disponível offline', { status: 503 })
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(DYNAMIC_CACHE)
      cache.put(request, response.clone())
    }
    return response
  } catch {
    const cached = await caches.match(request)
    return cached || caches.match(OFFLINE_URL) || new Response('Offline', { status: 503 })
  }
}

async function staleWhileRevalidate(request) {
  const cache  = await caches.open(DYNAMIC_CACHE)
  const cached = await cache.match(request)

  const fetchPromise = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone())
    return response
  }).catch(() => null)

  return cached || fetchPromise || caches.match(OFFLINE_URL)
}

async function networkOnly(request) {
  try {
    return await fetch(request)
  } catch {
    return new Response(JSON.stringify({ error: 'Offline — tente novamente' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

// ── Background Sync: reenvio de alertas offline ───────────
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-alerts') {
    event.waitUntil(syncPendingAlerts())
  }
})

async function syncPendingAlerts() {
  // Lê alertas pendentes do IDB e reenvia
  // (implementação futura com IndexedDB)
  console.log('[SW] Background sync: alerts')
}

// ── Push Notifications (base) ─────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return
  const data = event.data.json()

  event.waitUntil(
    self.registration.showNotification(data.title || 'MelhorPreço', {
      body:    data.body   || 'Preço atualizado!',
      icon:    '/static/icons/icon-192.png',
      badge:   '/static/icons/icon-96.png',
      data:    data,
      actions: [
        { action: 'view', title: 'Ver produto' },
        { action: 'dismiss', title: 'Dispensar' }
      ],
      vibrate: [200, 100, 200]
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  if (event.action === 'view' && event.notification.data?.url) {
    event.waitUntil(clients.openWindow(event.notification.data.url))
  }
})
