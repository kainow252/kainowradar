// ╔══════════════════════════════════════════════════════════════════╗
// ║  KainowRadar — Shopee Afiliados Console Script                  ║
// ║  Cole este script no Console do Chrome na página:               ║
// ║  https://affiliate.shopee.com.br/offer/product_offer            ║
// ║                                                                  ║
// ║  Ele roda em background, sem precisar de extensão.              ║
// ╚══════════════════════════════════════════════════════════════════╝

;(async function KainowShopeeSync() {

  // ════════════════════════════════════════════════
  // ⚙️  CONFIGURAÇÃO — edite antes de rodar
  // ════════════════════════════════════════════════
  const CONFIG = {
    storeId:   __STORE_ID__,                          // ID da loja Shopee no KainowRadar
    kainowUrl: 'https://kainowradar.com.br',          // URL do KainowRadar
    maxPages:  0,                                     // 0 = todas as páginas
    pageSize:  100,                                   // itens por página (máx 100)
    delayMs:   600,                                   // pausa entre páginas (ms)
    chunkSize: 50,                                    // links por envio ao KainowRadar
  }
  // ════════════════════════════════════════════════

  if (!CONFIG.storeId || CONFIG.storeId === '__STORE_ID__') {
    alert('⚠️ Configure o storeId no script antes de rodar!\nAbra o script e troque __STORE_ID__ pelo número da sua loja.')
    return
  }

  // ─── Overlay de progresso ────────────────────────────────────────────
  document.getElementById('__kr_overlay')?.remove()
  const ov = document.createElement('div')
  ov.id = '__kr_overlay'
  ov.style.cssText = [
    'position:fixed', 'bottom:24px', 'right:24px', 'z-index:2147483647',
    'background:#0f172a', 'color:#f1f5f9',
    'padding:18px 20px', 'border-radius:16px',
    'font-family:system-ui,sans-serif', 'font-size:13px',
    'min-width:320px', 'max-width:380px',
    'box-shadow:0 8px 40px rgba(0,0,0,.6)',
    'border:1px solid #1e293b',
    'transition:opacity .3s',
  ].join(';')

  ov.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:9px">
        <div style="width:10px;height:10px;border-radius:50%;background:#EE4D2D;box-shadow:0 0 6px #EE4D2D80;animation:__kr_pulse 1s infinite"></div>
        <strong style="color:#EE4D2D;font-size:14px">KainowRadar</strong>
        <span style="color:#475569;font-size:11px">Shopee Sync</span>
      </div>
      <button onclick="this.closest('#__kr_overlay').style.opacity='.2'" style="background:none;border:none;color:#475569;cursor:pointer;font-size:16px">−</button>
    </div>
    <div id="__kr_status" style="color:#94a3b8;font-size:12px;margin-bottom:10px">Iniciando...</div>
    <div style="background:#1e293b;border-radius:6px;height:5px;overflow:hidden;margin-bottom:10px">
      <div id="__kr_bar" style="height:100%;background:linear-gradient(90deg,#EE4D2D,#FF7337);width:0%;transition:width .4s ease"></div>
    </div>
    <div style="display:flex;gap:0;margin-bottom:10px">
      <div style="flex:1;background:#1e293b;border-radius:8px 0 0 8px;padding:8px;text-align:center;border:1px solid #334155;border-right:none">
        <div id="__kr_found" style="font-size:16px;font-weight:800;color:#fb923c">0</div>
        <div style="font-size:10px;color:#475569">Encontrados</div>
      </div>
      <div style="flex:1;background:#1e293b;padding:8px;text-align:center;border:1px solid #334155;border-right:none">
        <div id="__kr_saved" style="font-size:16px;font-weight:800;color:#22c55e">0</div>
        <div style="font-size:10px;color:#475569">Importados</div>
      </div>
      <div style="flex:1;background:#1e293b;border-radius:0 8px 8px 0;padding:8px;text-align:center;border:1px solid #334155">
        <div id="__kr_page" style="font-size:16px;font-weight:800;color:#60a5fa">1</div>
        <div style="font-size:10px;color:#475569">Página</div>
      </div>
    </div>
    <div id="__kr_log" style="background:#020617;border:1px solid #1e293b;border-radius:8px;padding:8px;font-size:11px;font-family:monospace;max-height:80px;overflow-y:auto;color:#475569"></div>
    <style>@keyframes __kr_pulse{0%,100%{opacity:1}50%{opacity:.3}}</style>
  `
  document.body.appendChild(ov)

  const elStatus = () => document.getElementById('__kr_status')
  const elBar    = () => document.getElementById('__kr_bar')
  const elFound  = () => document.getElementById('__kr_found')
  const elSaved  = () => document.getElementById('__kr_saved')
  const elPage   = () => document.getElementById('__kr_page')
  const elLog    = () => document.getElementById('__kr_log')

  function setStatus(msg) {
    const e = elStatus(); if (e) e.textContent = msg
    console.log('[KainowRadar]', msg)
  }
  function setBar(pct) {
    const e = elBar(); if (e) e.style.width = Math.min(100, pct) + '%'
  }
  function setStats(found, saved, page) {
    const ef = elFound(), es = elSaved(), ep = elPage()
    if (ef) ef.textContent = found.toLocaleString('pt-BR')
    if (es) es.textContent = saved.toLocaleString('pt-BR')
    if (ep) ep.textContent = page
  }
  function addLog(msg, color = '#475569') {
    const el = elLog()
    if (!el) return
    const line = document.createElement('div')
    line.style.color = color
    line.style.marginBottom = '2px'
    line.textContent = new Date().toLocaleTimeString('pt-BR') + ' ' + msg
    el.appendChild(line)
    el.scrollTop = el.scrollHeight
    while (el.children.length > 80) el.removeChild(el.firstChild)
  }

  // ─── Variável de parada ───────────────────────────────────────────────
  window.__krStop = false
  console.log('[KainowRadar] Para parar: window.__krStop = true')

  // ─── Estatísticas globais ─────────────────────────────────────────────
  let totalFound   = 0
  let totalSaved   = 0
  let currentPage  = 1
  let hasMore      = true

  // ════════════════════════════════════════════════════════════════
  // 1. Descobre total de produtos via API
  // ════════════════════════════════════════════════════════════════
  setStatus('Conectando à API da Shopee...')

  async function apiGet(page, size) {
    const url = `https://affiliate.shopee.com.br/api/v1/offer/product_offer?page_number=${page}&page_size=${size}&need_products_info=1&sort_type=2`
    const r = await fetch(url, {
      credentials: 'include',
      headers: { 'Accept': 'application/json', 'x-requested-with': 'XMLHttpRequest' }
    })
    if (r.status === 401 || r.status === 403) throw new Error('Sessão expirada — faça login novamente')
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  }

  // ════════════════════════════════════════════════════════════════
  // 2. Gera link de afiliado para um produto
  //    Tenta 3 endpoints em ordem de preferência
  // ════════════════════════════════════════════════════════════════
  async function getAffiliateLink(offer) {
    // Opção A: já vem no objeto
    const direct = offer.short_link || offer.affiliate_link || offer.offer_link
      || offer.sub_link || offer.link
    if (direct && direct.startsWith('http')) return direct

    const itemId = offer.item_id || offer.product_id || offer.itemid
    const shopId = offer.shop_id || offer.shopid || 0
    if (!itemId) return null

    // Opção B: endpoint /link/generate (botão "Obter link" da UI)
    try {
      const r = await fetch('https://affiliate.shopee.com.br/api/v1/link/generate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
        body: JSON.stringify({ item_list: [{ item_id: itemId, shop_id: shopId }] })
      })
      if (r.ok) {
        const d = await r.json()
        const link = d?.data?.link_list?.[0]?.short_link
          || d?.data?.link_list?.[0]?.affiliate_link
          || d?.data?.[0]?.short_link
        if (link) return link
      }
    } catch(_) {}

    // Opção C: endpoint antigo /offer/generate_affiliate_link
    try {
      const r = await fetch('https://affiliate.shopee.com.br/api/v1/offer/generate_affiliate_link', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ item_id: itemId, shop_id: shopId })
      })
      if (r.ok) {
        const d = await r.json()
        return d?.data?.short_link || d?.data?.affiliate_link || null
      }
    } catch(_) {}

    return null
  }

  // ════════════════════════════════════════════════════════════════
  // 3. Gera links em massa via "Obter Link em Massa"
  //    = mesmo endpoint que o botão laranja usa
  // ════════════════════════════════════════════════════════════════
  async function getBulkLinks(offers) {
    const items = offers
      .filter(o => o.item_id || o.product_id || o.itemid)
      .map(o => ({ item_id: o.item_id || o.product_id || o.itemid, shop_id: o.shop_id || o.shopid || 0 }))

    if (!items.length) return []

    // Tenta endpoint de bulk
    const endpoints = [
      'https://affiliate.shopee.com.br/api/v1/link/generate',
      'https://affiliate.shopee.com.br/api/v1/offer/batch_generate_affiliate_link',
    ]

    for (const ep of endpoints) {
      try {
        const body = ep.includes('batch')
          ? { items }
          : { item_list: items }

        const r = await fetch(ep, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
          body: JSON.stringify(body)
        })
        if (!r.ok) continue
        const d = await r.json()

        // Normaliza resposta dos diferentes endpoints
        const list = d?.data?.link_list || d?.data?.links || d?.data || []
        if (Array.isArray(list) && list.length > 0) {
          const links = list.map(l => l?.short_link || l?.affiliate_link || l?.link).filter(Boolean)
          if (links.length > 0) return { links, items }
        }
      } catch(_) {}
    }
    return { links: [], items }
  }

  // ════════════════════════════════════════════════════════════════
  // 4. Envia links para o KainowRadar
  // ════════════════════════════════════════════════════════════════
  async function sendToKainow(richLines) {
    if (!richLines.length) return { imported: 0, updated: 0 }
    try {
      const r = await fetch(`${CONFIG.kainowUrl}/admin/api/stores/${CONFIG.storeId}/import-links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ links: richLines.join('\n') })
      })
      if (!r.ok) {
        addLog(`⚠️ KainowRadar retornou ${r.status}`, '#f59e0b')
        return { imported: 0, updated: 0 }
      }
      const d = await r.json()
      return { imported: d.imported || 0, updated: d.updated || 0 }
    } catch(e) {
      addLog('Erro ao enviar: ' + e.message, '#f87171')
      return { imported: 0, updated: 0 }
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 5. Loop principal
  // ════════════════════════════════════════════════════════════════
  try {
    // Testa conexão primeiro
    const testData = await apiGet(1, 1)
    const serverTotal = testData?.data?.total_count || testData?.data?.total || 0
    setStatus(`Encontrados ${serverTotal > 0 ? serverTotal.toLocaleString('pt-BR') : '?'} produtos. Iniciando...`)
    addLog(`Total servidor: ${serverTotal}`, '#60a5fa')
    await new Promise(r => setTimeout(r, 800))

    while (hasMore && !window.__krStop) {
      if (CONFIG.maxPages > 0 && currentPage > CONFIG.maxPages) break

      setStatus(`Buscando página ${currentPage}...`)
      setBar(serverTotal > 0 ? Math.min(90, (totalFound / serverTotal) * 90) : (currentPage * 2))

      // Busca página
      let data
      try {
        data = await apiGet(currentPage, CONFIG.pageSize)
      } catch(err) {
        addLog('❌ ' + err.message, '#f87171')
        setStatus('❌ ' + err.message)
        break
      }

      const offers = data?.data?.offers || data?.data?.list || data?.data?.items
        || (Array.isArray(data?.data) ? data.data : [])

      if (!offers || !offers.length) {
        addLog('Sem mais produtos', '#22c55e')
        hasMore = false
        break
      }

      addLog(`Pág ${currentPage}: ${offers.length} produtos`, '#60a5fa')

      // ── Gera links ────────────────────────────────────────────────
      setStatus(`Pág ${currentPage}: gerando ${offers.length} links...`)

      // Tenta bulk primeiro (mais rápido, mesmo que o botão "Obter Link em Massa")
      const { links: bulkLinks, items: bulkItems } = await getBulkLinks(offers)

      const richLines = []

      if (bulkLinks.length > 0) {
        // Associa link gerado → oferta original pela posição
        addLog(`Bulk: ${bulkLinks.length} links gerados`, '#22c55e')
        bulkLinks.forEach((link, i) => {
          const offer = bulkItems[i] ? offers.find(o =>
            (o.item_id || o.product_id) === bulkItems[i].item_id
          ) : offers[i]
          if (!link) return
          const name  = offer?.name || offer?.product_name || offer?.title || ''
          const price = offer?.price || offer?.sale_price || offer?.min_price || ''
          const image = offer?.image || offer?.item_image || offer?.product_image || ''
          const extId = offer?.item_id || offer?.product_id || ''
          richLines.push([link, name, price ? String(price) : '', image, extId ? String(extId) : ''].join('|'))
        })
      } else {
        // Fallback: gera um por um
        addLog(`Gerando links individualmente...`, '#f59e0b')
        for (let i = 0; i < offers.length; i++) {
          if (window.__krStop) break
          const offer = offers[i]
          const link  = await getAffiliateLink(offer)
          if (link) {
            const name  = offer?.name || offer?.product_name || offer?.title || ''
            const price = offer?.price || offer?.sale_price || ''
            const image = offer?.image || offer?.item_image || ''
            const extId = offer?.item_id || offer?.product_id || ''
            richLines.push([link, name, price ? String(price) : '', image, extId ? String(extId) : ''].join('|'))
          }
          if (i % 20 === 19) {
            setStatus(`Pág ${currentPage}: ${i+1}/${offers.length} links gerados...`)
            await new Promise(r => setTimeout(r, 100))
          }
        }
      }

      totalFound += richLines.length
      setStats(totalFound, totalSaved, currentPage)

      if (richLines.length === 0) {
        addLog('⚠️ Nenhum link gerado nesta página', '#f59e0b')
      }

      // ── Envia para KainowRadar em chunks ──────────────────────────
      if (richLines.length > 0) {
        setStatus(`Enviando ${richLines.length} links para KainowRadar...`)
        for (let i = 0; i < richLines.length; i += CONFIG.chunkSize) {
          if (window.__krStop) break
          const chunk = richLines.slice(i, i + CONFIG.chunkSize)
          const res   = await sendToKainow(chunk)
          totalSaved += res.imported + res.updated
          setStats(totalFound, totalSaved, currentPage)
          setBar(serverTotal > 0 ? Math.min(95, (totalSaved / serverTotal) * 95) : 50)
        }
        addLog(`✅ Pág ${currentPage}: ${richLines.length} enviados`, '#22c55e')
      }

      // ── Verifica se há mais páginas ───────────────────────────────
      if (offers.length < CONFIG.pageSize) {
        hasMore = false
      } else if (serverTotal > 0 && totalFound >= serverTotal) {
        hasMore = false
      }

      currentPage++

      if (hasMore && !window.__krStop) {
        await new Promise(r => setTimeout(r, CONFIG.delayMs))
      }
    }

    // ── Concluído ────────────────────────────────────────────────────
    setBar(100)
    const dot = document.querySelector('#__kr_overlay div > div:first-child > div:first-child')
    if (dot) { dot.style.background = '#22c55e'; dot.style.boxShadow = '0 0 6px #22c55e80'; dot.style.animation = 'none' }

    const msg = window.__krStop
      ? `⏹ Parado! ${totalSaved.toLocaleString('pt-BR')} importados de ${totalFound.toLocaleString('pt-BR')}`
      : `🎉 Concluído! ${totalSaved.toLocaleString('pt-BR')} importados de ${totalFound.toLocaleString('pt-BR')}`

    setStatus(msg)
    addLog(msg, '#22c55e')
    console.log('[KainowRadar] COMPLETO:', { totalFound, totalSaved, pages: currentPage - 1 })

  } catch(e) {
    setStatus('❌ Erro: ' + e.message)
    addLog('❌ ' + e.message, '#f87171')
    console.error('[KainowRadar] Erro:', e)
  }

  // Retorna resultado para o console
  return { ok: true, totalFound, totalSaved, pages: currentPage - 1 }

})()
