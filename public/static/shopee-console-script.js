// ═══════════════════════════════════════════════════════════════════════
// KainowRadar — Script de Console para Shopee Afiliados
// Cole este script no Console do DevTools em affiliate.shopee.com.br
// O script roda com sua sessão ativa — sem precisar de nada extra!
// ═══════════════════════════════════════════════════════════════════════
(async function KainowShopeeCollect() {

  // ── CONFIG ────────────────────────────────────────────────────────────
  const KAINOW_URL = 'https://shopping-compare.pages.dev'   // URL do KainowRadar
  const STORE_ID   = __KAINOW_STORE_ID__ || 4              // ID da loja no banco (substitua se necessário)
  const PAGE_LIMIT = 100   // produtos por página
  const BATCH_LINK = 50    // gerar links em lotes de 50
  const MAX_ITEMS  = 0     // 0 = todos
  const DELAY_MS   = 300   // delay entre requisições (ms)

  // ── UI OVERLAY ────────────────────────────────────────────────────────
  const existing = document.getElementById('__kainow_overlay__')
  if (existing) existing.remove()

  const overlay = document.createElement('div')
  overlay.id = '__kainow_overlay__'
  overlay.style.cssText = `
    position:fixed;bottom:20px;right:20px;z-index:999999;
    background:#1e293b;color:#e2e8f0;border-radius:16px;
    padding:16px 20px;width:340px;font-family:monospace;font-size:12px;
    box-shadow:0 8px 32px rgba(0,0,0,0.4);border:1px solid #334155;
  `
  overlay.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div style="font-size:14px;font-weight:bold;color:#f97316">🛒 KainowRadar Shopee</div>
      <button id="__kainow_stop__" style="background:#ef4444;color:white;border:none;border-radius:8px;padding:3px 10px;cursor:pointer;font-size:11px">⏹ Parar</button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:10px">
      <div style="background:#0f172a;border-radius:8px;padding:6px;text-align:center">
        <div id="__k_found__" style="font-size:18px;font-weight:900;color:#f97316">0</div>
        <div style="font-size:10px;color:#64748b">Encontrados</div>
      </div>
      <div style="background:#0f172a;border-radius:8px;padding:6px;text-align:center">
        <div id="__k_saved__" style="font-size:18px;font-weight:900;color:#22c55e">0</div>
        <div style="font-size:10px;color:#64748b">Salvos</div>
      </div>
      <div style="background:#0f172a;border-radius:8px;padding:6px;text-align:center">
        <div id="__k_page__" style="font-size:18px;font-weight:900;color:#3b82f6">0</div>
        <div style="font-size:10px;color:#64748b">Páginas</div>
      </div>
    </div>
    <div id="__k_bar_wrap__" style="background:#0f172a;border-radius:6px;height:6px;margin-bottom:8px;overflow:hidden">
      <div id="__k_bar__" style="height:100%;background:linear-gradient(90deg,#f97316,#ef4444);width:0%;transition:width 0.4s"></div>
    </div>
    <div id="__k_log__" style="height:90px;overflow-y:auto;background:#0f172a;border-radius:8px;padding:8px;font-size:11px;color:#94a3b8;line-height:1.5"></div>
    <div id="__k_status__" style="margin-top:8px;font-size:11px;color:#64748b;text-align:center">Iniciando...</div>
  `
  document.body.appendChild(overlay)

  let __stop = false
  document.getElementById('__kainow_stop__').onclick = () => {
    __stop = true
    kLog('🛑 Parando após página atual...')
  }

  // ── HELPERS ───────────────────────────────────────────────────────────
  let totalFound = 0, totalSaved = 0, pagesDone = 0

  function kLog(msg) {
    const el = document.getElementById('__k_log__')
    if (!el) return
    const t = new Date().toLocaleTimeString('pt-BR')
    el.innerHTML += `<div><span style="color:#475569">[${t}]</span> ${msg}</div>`
    el.scrollTop = el.scrollHeight
    console.log('[KainowRadar]', msg)
  }

  function kUpdate(found, saved, page, pct, status) {
    const ef = document.getElementById('__k_found__')
    const es = document.getElementById('__k_saved__')
    const ep = document.getElementById('__k_page__')
    const eb = document.getElementById('__k_bar__')
    const est = document.getElementById('__k_status__')
    if (ef) ef.textContent = found.toLocaleString('pt-BR')
    if (es) es.textContent = saved.toLocaleString('pt-BR')
    if (ep) ep.textContent = page
    if (eb) eb.style.width = Math.min(pct, 100) + '%'
    if (est) est.textContent = status || ''
  }

  function delay(ms) { return new Promise(r => setTimeout(r, ms)) }

  const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || ''

  // ── PASSO 1: Lista todos os produtos com paginação ────────────────────
  kLog('🚀 Iniciando coleta via API da Shopee...')
  kUpdate(0, 0, 0, 2, 'Buscando lista de produtos...')

  const allItems = []
  let offset = 0
  let hasMore = true
  let totalAPI = 0

  while (hasMore && (MAX_ITEMS === 0 || allItems.length < MAX_ITEMS)) {
    if (__stop) break

    kLog(`📄 Página ${pagesDone + 1} (offset ${offset})...`)

    const res = await fetch(
      `/api/v3/offer/product/list?list_type=2&sort_type=2&page_offset=${offset}&page_limit=${PAGE_LIMIT}&client_type=1`,
      {
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
          'x-requested-with': 'XMLHttpRequest',
          'x-csrftoken': csrf
        }
      }
    ).catch(e => { kLog('❌ Erro: ' + e.message); return null })

    if (!res) { hasMore = false; break }

    const json = await res.json().catch(() => null)

    if (!json || json.is_login === false || json.error) {
      kLog('⚠️ Sessão inválida ou sem produtos: ' + JSON.stringify(json))
      hasMore = false; break
    }

    const items = json?.data?.items || json?.data?.list || (Array.isArray(json?.data) ? json.data : [])
    totalAPI = json?.data?.total_count || json?.data?.total || totalAPI

    if (!items.length) { hasMore = false; break }

    for (const it of items) {
      allItems.push({
        item_id:    it.item_id || it.id,
        item_name:  it.item_name || it.name || it.title || '',
        price_min:  it.price_min != null ? Number(it.price_min) / 100000 : null,
        image:      it.image || it.image_url || null,
        commission: it.commission_rate || it.commission || null,
        sales:      it.sales || 0,
        shop_id:    it.shop_id || null,
      })
    }

    pagesDone++
    totalFound = allItems.length
    offset += PAGE_LIMIT

    const pct = totalAPI > 0 ? Math.round((allItems.length / totalAPI) * 45) : Math.min(pagesDone * 3, 45)
    kUpdate(totalFound, totalSaved, pagesDone, pct, `${totalFound} produtos encontrados...`)
    kLog(`✅ Página ${pagesDone}: ${items.length} itens (total: ${totalFound}${totalAPI ? ' / ' + totalAPI : ''})`)

    if (items.length < PAGE_LIMIT) hasMore = false
    await delay(DELAY_MS)
  }

  if (allItems.length === 0) {
    kLog('❌ Nenhum produto encontrado! Verifique se está logado.')
    kUpdate(0, 0, 0, 0, '❌ Sem produtos')
    return
  }

  kLog(`📦 Total de produtos encontrados: ${allItems.length}`)
  kLog('🔗 Gerando links afiliados em lotes de ' + BATCH_LINK + '...')
  kUpdate(totalFound, 0, pagesDone, 50, 'Gerando links afiliados...')

  // ── PASSO 2: Gera links afiliados em lotes ────────────────────────────
  const itemsWithLinks = []

  for (let i = 0; i < allItems.length; i += BATCH_LINK) {
    if (__stop) break

    const batch = allItems.slice(i, i + BATCH_LINK)
    const itemIds = batch.map(it => it.item_id).filter(Boolean)

    kLog(`🔗 Lote ${Math.floor(i/BATCH_LINK)+1}: gerando ${itemIds.length} links...`)

    const linkRes = await fetch('/api/v3/offer/batch_product_links', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
        'x-csrftoken': csrf
      },
      body: JSON.stringify({
        item_ids: itemIds,
        source_caller: 'WEB_SITE_CALLER'
      })
    }).catch(e => { kLog('⚠️ Erro batch: ' + e.message); return null })

    if (linkRes) {
      const linkJson = await linkRes.json().catch(() => null)
      const linksMap = {}

      // Estrutura: data = array de { item_id, product_link } ou { item_id, short_link }
      const linkData = linkJson?.data || []
      if (Array.isArray(linkData)) {
        for (const ld of linkData) {
          const id = ld.item_id || ld.id
          const lk = ld.short_link || ld.product_link || ld.affiliate_link || ld.link
          if (id && lk) linksMap[id] = lk
        }
      }

      for (const it of batch) {
        itemsWithLinks.push({
          ...it,
          affiliate_link: linksMap[it.item_id] || null
        })
      }

      const gotLinks = Object.keys(linksMap).length
      kLog(`  ✅ ${gotLinks} links gerados`)
    } else {
      // Sem link — adiciona com link nulo (vai usar URL da página)
      for (const it of batch) {
        itemsWithLinks.push({ ...it, affiliate_link: null })
      }
    }

    const pct = 50 + Math.round(((i + BATCH_LINK) / allItems.length) * 30)
    kUpdate(totalFound, totalSaved, pagesDone, pct, 'Gerando links...')
    await delay(DELAY_MS)
  }

  kLog(`✅ ${itemsWithLinks.filter(i => i.affiliate_link).length} links gerados de ${itemsWithLinks.length} produtos`)
  kLog('💾 Enviando para o KainowRadar...')
  kUpdate(totalFound, 0, pagesDone, 82, 'Salvando no banco...')

  // ── PASSO 3: Envia para o backend em chunks ───────────────────────────
  const IMPORT_CHUNK = 200
  let savedTotal = 0

  for (let i = 0; i < itemsWithLinks.length; i += IMPORT_CHUNK) {
    if (__stop) break

    const chunk = itemsWithLinks.slice(i, i + IMPORT_CHUNK)

    // Monta formato URL|Nome|Preço|Img|ExternalId
    const lines = chunk.map(it => {
      const url   = it.affiliate_link
                  || `https://affiliate.shopee.com.br/offer/product_offer/${it.item_id}`
      const name  = (it.item_name || '').replace(/\|/g, ' ')
      const price = it.price_min ? it.price_min.toFixed(2) : ''
      const img   = it.image || ''
      const extId = String(it.item_id || '')
      return `${url}|${name}|${price}|${img}|${extId}`
    }).join('\n')

    kLog(`💾 Enviando chunk ${Math.floor(i/IMPORT_CHUNK)+1} (${chunk.length} itens)...`)

    try {
      const saveRes = await fetch(`${KAINOW_URL}/admin/api/stores/${STORE_ID}/import-links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ links: lines })
      })
      const saveJson = await saveRes.json().catch(() => ({}))
      const chunkSaved = (saveJson.imported || 0) + (saveJson.updated || 0)
      savedTotal += chunkSaved
      totalSaved = savedTotal
      kLog(`  ✅ ${chunkSaved} salvos (total: ${savedTotal})`)
    } catch (e) {
      kLog('  ⚠️ Erro ao salvar: ' + e.message)
    }

    const pct = 82 + Math.round(((i + IMPORT_CHUNK) / itemsWithLinks.length) * 16)
    kUpdate(totalFound, totalSaved, pagesDone, pct, `Salvando... ${savedTotal}/${totalFound}`)
    await delay(200)
  }

  // ── CONCLUÍDO ─────────────────────────────────────────────────────────
  kUpdate(totalFound, totalSaved, pagesDone, 100, '✅ Concluído!')
  kLog('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  kLog(`🎉 CONCLUÍDO!`)
  kLog(`📦 Encontrados: ${totalFound} produtos`)
  kLog(`💾 Salvos no banco: ${totalSaved}`)
  kLog(`📄 Páginas: ${pagesDone}`)
  kLog('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const btn = document.getElementById('__kainow_stop__')
  if (btn) {
    btn.textContent = '✓ Fechar'
    btn.style.background = '#22c55e'
    btn.onclick = () => overlay.remove()
  }

})();
