// ============================================================
// Cron Worker — KainowRadar Price Scraper
// Roda a cada hora via Cloudflare Cron Triggers
// Chama o endpoint /admin/api/cron/run do site principal
// ============================================================

export default {
  // Handler HTTP (permite testar manualmente via GET /trigger)
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/trigger') {
      const result = await runCron()
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('KainowRadar Price Cron Worker\nGET /trigger para executar manualmente', {
      status: 200,
    })
  },

  // Handler do cron — chamado automaticamente pela Cloudflare
  async scheduled(event: ScheduledEvent): Promise<void> {
    console.log(`[CRON] Disparado — ${new Date().toISOString()} — cron: ${event.cron}`)
    const result = await runCron()
    console.log(`[CRON] Resultado:`, JSON.stringify(result))
  },
}

async function runCron(): Promise<Record<string, unknown>> {
  const SITE_URL    = 'https://kainowradar.com.br'
  const ADMIN_TOKEN = 'admin123' // Cloudflare Secret: ADMIN_TOKEN

  try {
    const res = await fetch(`${SITE_URL}/admin/api/cron/run`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${ADMIN_TOKEN}`,
        'User-Agent':    'KainowCronWorker/1.0',
      },
      body: JSON.stringify({}),
    })

    if (!res.ok) {
      const text = await res.text()
      return { ok: false, status: res.status, error: text }
    }

    const data = await res.json() as Record<string, unknown>
    return { ok: true, ...data }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}
