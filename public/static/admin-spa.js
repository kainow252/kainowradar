// ============================================================
// ADMIN SPA — JavaScript
// ============================================================

const App = {
  token: localStorage.getItem('admin_token') || '',
  currentSection: 'dashboard',
  charts: {},
}

// ── Auth ─────────────────────────────────────────────────
async function doLogin() {
  const pwd = document.getElementById('login-password').value
  const btn = document.getElementById('login-btn')
  const err = document.getElementById('login-error')
  if (!pwd) return
  btn.textContent = 'Entrando...'
  btn.disabled = true
  try {
    const res = await fetch('/admin/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd })
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Senha incorreta')
    App.token = data.token
    localStorage.setItem('admin_token', data.token)
    err.classList.add('hidden')
    document.getElementById('login-screen').classList.add('hidden')
    document.getElementById('admin-app').classList.remove('hidden')
    loadSection('dashboard')
  } catch (e) {
    err.textContent = e.message
    err.classList.remove('hidden')
    btn.textContent = 'Entrar'
    btn.disabled = false
  }
}

async function doLogout() {
  await api('POST', '/admin/api/logout').catch(() => {})
  localStorage.removeItem('admin_token')
  App.token = ''
  location.reload()
}

// ── API helper ───────────────────────────────────────────
async function api(method, path, body, timeoutMs = 15000) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + App.token },
    signal: AbortSignal.timeout(timeoutMs)
  }
  if (body) opts.body = JSON.stringify(body)
  try {
    const res = await fetch(path, opts)
    if (res.status === 401) { doLogout(); return null }
    return await res.json()
  } catch(e) {
    console.warn('api() error:', method, path, e?.message)
    return null
  }
}

// ── Toast ────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const t = document.getElementById('toast')
  const colors = { info:'#1e293b', success:'#166534', error:'#991b1b', warning:'#92400e' }
  t.style.background = colors[type] || colors.info
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(t._t)
  t._t = setTimeout(() => t.classList.remove('show'), 3000)
}

// ── Format helpers ────────────────────────────────────────
const fBRL = v => v != null ? new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(v) : '—'
const fDate = d => d ? new Date(d).toLocaleDateString('pt-BR') : '—'
const fDateTime = d => d ? new Date(d).toLocaleString('pt-BR') : '—'
const badge = (text, color) => `<span class="badge-${color}">${text}</span>`
const spin = `<div class="flex items-center justify-center py-20"><div class="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div></div>`

// ── Navigation ────────────────────────────────────────────
function showSection(name) {
  App.currentSection = name
  document.querySelectorAll('[data-section]').forEach(el => el.classList.remove('active'))
  const link = document.querySelector(`[data-section="${name}"]`)
  if (link) link.classList.add('active')
  loadSection(name)
}

async function loadSection(name) {
  const area = document.getElementById('content-area')
  area.innerHTML = spin
  const titles = {
    dashboard: ['Dashboard', 'Visão geral do sistema'],
    'top-deals': ['Top Deals', 'Melhor preço por produto — GROUP BY MIN(price)'],
    products: ['Produtos', 'Gerenciar catálogo de produtos'],
    offers: ['Ofertas', 'Gerenciar ofertas por loja'],
    stores: ['Lojas Parceiras', 'Ativar/desativar lojas e ver métricas'],
    'api-configs': ['APIs & Feeds', 'Configurar integrações e chaves de API'],
    // queue: oculto do menu
    editorial: ['🤖 IA Editorial', 'Motor de destaques automáticos — analisa D1 e gera banners'],
    footer:    ['🦶 Rodapé do Site', 'Editar textos, lojas parceiras e links de informações'],
    analytics: ['Analytics', 'Cliques, conversões e performance'],
    users: ['Usuários', 'Gerenciar clientes e membros'],
    social: ['📣 Social Media', 'Gerencie contas e publique nas redes sociais'],
    // 'affiliate-bot': oculto do menu
    // 'ml-import': oculto do menu
    'ml-categories': ['🗂️ Categorias ML', 'Sincroniza árvore de categorias do Mercado Livre com o D1'],
    'ml-search': ['🔍 Busca ML API', 'Busca e importa produtos por categoria ou termo via API do ML'],
    'ml-crawl': ['🕷️ Crawl em Massa', 'Varre uma categoria completa do ML com paginação automática (limit=50, loop de páginas)'],
    'api-keys': ['🔑 API Keys', 'Gerencie chaves de acesso para parceiros e integrações externas'],
    'affiliate-codes': ['🔗 Códigos Afiliados', 'Configure seus códigos por rede e gere links para todos os produtos'],
    'buscape-import': ['🛍️ Importar do Buscapé', 'Importa produtos e preços de múltiplas lojas via Buscapé — gera links afiliados automaticamente'],
    'lomadee-import': ['🟠 Importar Lomadee', 'Busca produtos e gera links afiliados automáticos via API da Lomadee (136 lojas parceiras)'],
    'ml-linkbuilder': ['🔗 ML LinkBuilder Bot', 'Gera links meli.la/* para todos os produtos com ml_item_id — roda no browser logado no ML'],
  }
  const [title, subtitle] = titles[name] || ['Admin', '']
  document.getElementById('page-title').textContent = title
  document.getElementById('page-subtitle').textContent = subtitle

  const sections = {
    dashboard: renderDashboard,
    'top-deals': renderTopDeals,
    products: renderProducts,
    offers: renderOffers,
    stores: renderStores,
    'api-configs': renderApiConfigs,
    editorial: renderEditorial,
    footer: renderFooterAdmin,
    // queue: oculto do menu
    analytics: renderAnalytics,
    users: renderUsers,
    social: renderSocial,
    // 'affiliate-bot': oculto do menu
    // 'ml-import': oculto do menu
    'ml-categories': renderMLCategories,
    'ml-search': renderMLSearch,
    'ml-crawl': renderMLCrawl,
    'api-keys': renderAPIKeys,
    'affiliate-codes': renderAffiliateCodes,
    'buscape-import': renderBuscapeImport,
    'lomadee-import': renderLomadeeImport,
    'ml-linkbuilder': renderMLLinkBuilder,
    'feed-ingestion': renderFeedIngestion,
    'categories': renderCategories,
  }
  if (sections[name]) await sections[name](area)
}

// ── DASHBOARD ─────────────────────────────────────────────
async function renderDashboard(area) {
  const data = await api('GET', '/admin/api/dashboard')
  if (!data) return
  const p = data.products || {}; const o = data.offers || {}; const s = data.stores || {}
  const u = data.users || {}; const cl = data.clicks || {}; const q = data.queue || {}

  area.innerHTML = `
    <div class="section">
      <!-- Stats grid -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
        ${statCard('[Itens]', 'Produtos', p.total, `${p.with_offers || 0} com ofertas`, 'blue')}
        ${statCard('[Preco]', 'Ofertas Ativas', o.total, `${o.in_stock || 0} em estoque`, 'green')}
        ${statCard('[Loja]', 'Lojas', s.total, `${s.active || 0} ativas`, 'purple')}
        ${statCard('[Click]', 'Cliques Hoje', cl.today, `Fila: ${q.pending || 0} pendentes`, 'orange')}
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <!-- Cliques por dia -->
        <div class="stat-card">
          <h3 class="font-bold text-slate-800 mb-4">📈 Cliques (7 dias)</h3>
          <canvas id="clicks-chart" height="180"></canvas>
        </div>

        <!-- Top Categorias -->
        <div class="stat-card">
          <h3 class="font-bold text-slate-800 mb-4">📂 Top Categorias</h3>
          <div class="space-y-3">
            ${(data.topCategories || []).map(c => `
              <div class="flex items-center justify-between">
                <span class="text-sm font-medium text-slate-700 capitalize">${c.category || 'Outros'}</span>
                <div class="flex items-center gap-3">
                  <div class="w-32 bg-slate-100 rounded-full h-2 overflow-hidden">
                    <div class="bg-blue-500 h-2 rounded-full" style="width:${Math.min(100, (c.count / p.total) * 100)}%"></div>
                  </div>
                  <span class="text-sm font-bold text-slate-800 w-8 text-right">${c.count}</span>
                </div>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- Top Lojas -->
        <div class="stat-card">
          <h3 class="font-bold text-slate-800 mb-4">🏆 Lojas por Ofertas</h3>
          <table class="w-full">
            <thead><tr>
              <th class="text-left text-xs text-slate-500 font-semibold pb-2">Loja</th>
              <th class="text-right text-xs text-slate-500 font-semibold pb-2">Ofertas</th>
              <th class="text-right text-xs text-slate-500 font-semibold pb-2">Menor Preço</th>
            </tr></thead>
            <tbody>
              ${(data.topStores || []).map(s => `
                <tr class="border-t border-slate-50 hover:bg-slate-50">
                  <td class="py-2 text-sm font-medium text-slate-700">${s.name}</td>
                  <td class="py-2 text-sm text-right text-slate-600">${s.offer_count}</td>
                  <td class="py-2 text-sm text-right font-semibold text-green-700">${fBRL(s.min_price)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>

        <!-- Faixa de preços -->
        <div class="stat-card">
          <h3 class="font-bold text-slate-800 mb-4">💵 Faixa de Preços</h3>
          <div class="space-y-4">
            ${priceRange('Menor preço', o.min_price, 'text-green-700')}
            ${priceRange('Preço médio', o.avg_price, 'text-blue-700')}
            ${priceRange('Maior preço', o.max_price, 'text-red-700')}
          </div>
          <div class="mt-4 pt-4 border-t border-slate-100">
            <div class="text-xs text-slate-500">Usuários cadastrados</div>
            <div class="flex items-baseline gap-2 mt-1">
              <span class="text-2xl font-bold text-slate-800">${u.total || 0}</span>
              <span class="text-sm text-green-600">${u.active || 0} ativos</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `

  // Gráfico de cliques
  const ctx = document.getElementById('clicks-chart')
  if (ctx && data.clicksByDay) {
    if (App.charts.clicks) App.charts.clicks.destroy()
    App.charts.clicks = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.clicksByDay.map(d => new Date(d.day).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})),
        datasets: [{ label: 'Cliques', data: data.clicksByDay.map(d => d.clicks),
          backgroundColor: '#3b82f6', borderRadius: 6 }]
      },
      options: { responsive: true, plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
    })
  }
}

function statCard(icon, label, value, sub, color) {
  const colors = { blue:'border-blue-200 bg-blue-50', green:'border-green-200 bg-green-50',
    purple:'border-purple-200 bg-purple-50', orange:'border-orange-200 bg-orange-50' }
  return `
    <div class="stat-card border-l-4 ${colors[color] || ''}">
      <div class="flex items-start justify-between">
        <div>
          <p class="text-sm font-medium text-slate-500">${label}</p>
          <p class="text-3xl font-black text-slate-900 mt-1">${value ?? '—'}</p>
          <p class="text-xs text-slate-400 mt-1">${sub}</p>
        </div>
        <span class="text-3xl">${icon}</span>
      </div>
    </div>
  `
}

function priceRange(label, value, cls) {
  return `
    <div class="flex justify-between items-center">
      <span class="text-sm text-slate-500">${label}</span>
      <span class="text-sm font-bold ${cls}">${fBRL(value)}</span>
    </div>
  `
}

// ── TOP DEALS ─────────────────────────────────────────────
async function renderTopDeals(area) {
  const data = await api('GET', '/admin/api/top-deals?limit=24')
  if (!data) return
  const rows = data.map((item, i) => `
    <tr class="hover:bg-slate-50 cursor-pointer" onclick="openProductPage('${item.slug}')">
      <td class="table-td w-8 font-bold text-slate-400">${i+1}</td>
      <td class="table-td">
        <div class="flex items-center gap-3">
          <img src="${item.image_url || 'https://via.placeholder.com/48?text=P'}" class="w-10 h-10 object-contain bg-slate-50 rounded-lg">
          <div>
            <div class="font-semibold text-slate-800 text-sm max-w-xs truncate">${item.name}</div>
            <div class="text-xs text-slate-400">${item.brand || ''} · EAN: ${item.ean || '—'}</div>
          </div>
        </div>
      </td>
      <td class="table-td">${badge(item.category || 'outros', 'blue')}</td>
      <td class="table-td">
        <div class="flex items-center gap-2">
          ${item.store_logo ? `<img src="${item.store_logo}" class="h-4 max-w-[60px] object-contain">` : `<span class="font-semibold text-xs">${item.store_name}</span>`}
        </div>
      </td>
      <td class="table-td">
        <div class="text-lg font-black text-green-700">${fBRL(item.lowest_price)}</div>
        ${item.original_price && item.original_price > item.lowest_price
          ? `<div class="text-xs text-slate-400 line-through">${fBRL(item.original_price)}</div>` : ''}
      </td>
      <td class="table-td">
        ${item.discount_percent > 0 ? badge('-' + Math.round(item.discount_percent) + '%', 'red') : '—'}
      </td>
      <td class="table-td">
        ${item.free_shipping ? badge('✓ Grátis', 'green') : badge('A consultar', 'yellow')}
      </td>
      <td class="table-td">
        <span class="text-xs text-slate-400">${item.offer_count} ${item.offer_count===1?'loja':'lojas'}</span>
      </td>
      <td class="table-td">
        ${item.checkout_url ? `<a href="${item.checkout_url}" target="_blank" class="btn-success text-xs" onclick="event.stopPropagation()">Testar →</a>` : '—'}
      </td>
    </tr>
  `).join('')

  area.innerHTML = `
    <div class="section">
      <div class="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-800 flex items-start gap-2">
        <span class="text-lg">💡</span>
        <div>
          <strong>Query otimizada:</strong> <code class="bg-blue-100 px-1.5 py-0.5 rounded text-xs">GROUP BY p.id + MIN(o.price)</code>
          — garante exatamente 1 linha por produto, sempre com a oferta mais barata. Se o estoque da loja mais barata acabar, a próxima assume automaticamente.
        </div>
      </div>
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div class="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 class="font-bold text-slate-800">Melhor preço por produto <span class="text-slate-400 font-normal text-sm ml-1">${data.length} resultados</span></h3>
          <div class="flex gap-2">
            ${['', 'smartphones', 'notebooks', 'tv', 'games', 'audio', 'eletrodomesticos'].map(cat =>
              `<button onclick="loadTopDealsCategory('${cat}')" class="text-xs px-3 py-1.5 rounded-lg border ${cat===''?'bg-blue-600 text-white border-blue-600':'border-slate-200 hover:bg-slate-50'}">${cat||'Todos'}</button>`
            ).join('')}
          </div>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full">
            <thead><tr>
              <th class="table-th">#</th>
              <th class="table-th">Produto</th>
              <th class="table-th">Categoria</th>
              <th class="table-th">Loja</th>
              <th class="table-th">Menor Preço</th>
              <th class="table-th">Desconto</th>
              <th class="table-th">Frete</th>
              <th class="table-th">Lojas</th>
              <th class="table-th">Ação</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    </div>
  `
}

async function loadTopDealsCategory(cat) {
  const area = document.getElementById('content-area')
  area.innerHTML = spin
  const url = cat ? `/admin/api/top-deals?limit=24&category=${cat}` : '/admin/api/top-deals?limit=24'
  App._topDealsUrl = url
  const data = await api('GET', url)
  if (!data) return
  // Só re-renderiza a tabela
  await renderTopDeals(area)
}

function openProductPage(slug) {
  window.open('/produto/' + slug, '_blank')
}

// ── PRODUCTS ──────────────────────────────────────────────
async function renderProducts(area, page = 1) {
  const q = App.productSearch || ''
  const data = await api('GET', `/admin/api/products?page=${page}&q=${encodeURIComponent(q)}`)
  if (!data) return

  const rows = data.products.map(p => `
    <tr class="hover:bg-slate-50">
      <td class="table-td w-12">
        <img src="${p.image_url || 'https://via.placeholder.com/40?text=P'}" class="w-10 h-10 object-contain bg-slate-50 rounded-lg">
      </td>
      <td class="table-td max-w-xs">
        <div class="font-semibold text-slate-800 text-sm truncate">${p.name}</div>
        <div class="text-xs text-slate-400">${p.brand || ''} ${p.ean ? '· EAN: '+p.ean : ''}</div>
      </td>
      <td class="table-td">${badge(p.category || 'outros', 'blue')}</td>
      <td class="table-td font-bold text-green-700">${fBRL(p.best_price)}</td>
      <td class="table-td">
        <span class="text-sm font-semibold text-blue-700">${p.live_offers || 0}</span>
        <span class="text-xs text-slate-400"> lojas</span>
      </td>
      <td class="table-td">${fDateTime(p.updated_at)}</td>
      <td class="table-td">${p.is_active ? badge('Ativo','green') : badge('Inativo','red')}</td>
      <td class="table-td">
        <div class="flex gap-2">
          <button onclick="editProduct(${p.id})" class="btn-secondary text-xs">Editar</button>
          <button onclick="toggleProduct(${p.id}, ${p.is_active})" class="${p.is_active?'btn-danger':'btn-success'} text-xs">
            ${p.is_active?'Desativar':'Ativar'}
          </button>
        </div>
      </td>
    </tr>
  `).join('')

  area.innerHTML = `
    <div class="section">
      <div class="flex items-center gap-3 mb-4">
        <input type="text" id="product-search" value="${q}" placeholder="Buscar por nome, marca, EAN..."
          class="input max-w-sm" oninput="App.productSearch=this.value" onkeydown="if(event.key==='Enter'){renderProducts(document.getElementById('content-area'))}">
        <button onclick="renderProducts(document.getElementById('content-area'))" class="btn-primary">Buscar</button>
        <span class="text-sm text-slate-500 ml-auto">${data.total} produtos</span>
      </div>
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full">
            <thead><tr>
              <th class="table-th"></th>
              <th class="table-th">Produto</th>
              <th class="table-th">Categoria</th>
              <th class="table-th">Melhor Preço</th>
              <th class="table-th">Ofertas</th>
              <th class="table-th">Atualizado</th>
              <th class="table-th">Status</th>
              <th class="table-th">Ações</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${renderPagination(data.page, data.total, data.per_page, (p) => renderProducts(document.getElementById('content-area'), p))}
      </div>
    </div>
  `
}

async function toggleProduct(id, currentActive) {
  await api('DELETE', `/admin/api/products/${id}`)
  toast(currentActive ? 'Produto desativado' : 'Produto ativado', 'success')
  renderProducts(document.getElementById('content-area'))
}

function editProduct(id) {
  toast('Edição em desenvolvimento', 'info')
}

// ── OFFERS ────────────────────────────────────────────────
async function renderOffers(area, page = 1) {
  const data = await api('GET', `/admin/api/offers?page=${page}`)
  if (!data) return
  const rows = data.offers.map(o => `
    <tr class="hover:bg-slate-50">
      <td class="table-td max-w-xs">
        <div class="font-medium text-slate-800 text-sm truncate">${o.product_name}</div>
        <div class="text-xs text-slate-400">ID: ${o.external_id}</div>
      </td>
      <td class="table-td">${badge(o.store_name, 'blue')}</td>
      <td class="table-td font-bold text-green-700 text-base">${fBRL(o.price)}</td>
      <td class="table-td">
        ${o.original_price && o.original_price > o.price ? `<span class="text-slate-400 line-through text-xs">${fBRL(o.original_price)}</span>` : '—'}
      </td>
      <td class="table-td">
        ${o.discount_percent > 0 ? badge('-' + Math.round(o.discount_percent) + '%','red') : '—'}
      </td>
      <td class="table-td">${o.in_stock ? badge('Em estoque','green') : badge('Sem estoque','red')}</td>
      <td class="table-td">${o.free_shipping ? badge('Grátis','green') : badge('A consultar','yellow')}</td>
      <td class="table-td text-xs text-slate-400">${fDateTime(o.last_updated)}</td>
      <td class="table-td">
        ${o.checkout_url ? `<a href="${o.checkout_url}" target="_blank" class="text-blue-600 text-xs hover:underline">Abrir →</a>` : '—'}
      </td>
    </tr>
  `).join('')

  area.innerHTML = `
    <div class="section">
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h3 class="font-bold text-slate-800">Todas as Ofertas <span class="text-slate-400 font-normal text-sm ml-1">${data.total} total</span></h3>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full">
            <thead><tr>
              <th class="table-th">Produto</th>
              <th class="table-th">Loja</th>
              <th class="table-th">Preço</th>
              <th class="table-th">Preço original</th>
              <th class="table-th">Desconto</th>
              <th class="table-th">Estoque</th>
              <th class="table-th">Frete</th>
              <th class="table-th">Atualizado</th>
              <th class="table-th">Link</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${renderPagination(data.page, data.total, data.per_page, (p) => renderOffers(document.getElementById('content-area'), p))}
      </div>
    </div>
  `
}

// ── STORES ────────────────────────────────────────────────
// ── Mapa de cores por rede ─────────────────────────────────
const NETWORK_COLORS = {
  'amazon-pa-api':      { bg: '#fff8ee', border: '#FF9900', label: 'Amazon PA-API' },
  'meli-api':           { bg: '#fffde6', border: '#FFE600', label: 'Mercado Livre' },
  'magalu-api':         { bg: '#eef5ff', border: '#0086FF', label: 'Magalu API'    },
  'shopee-api':         { bg: '#fff3f0', border: '#EE4D2D', label: 'Shopee API'    },
  'shein-api':          { bg: '#f5f5f5', border: '#444444', label: 'Shein'         },
  'aliexpress-portals': { bg: '#fff0f0', border: '#FF4747', label: 'AliExpress'    },
  'lomadee':            { bg: '#f0f0ff', border: '#6366F1', label: 'SocialSoul'    },
  'rakuten':            { bg: '#fff0f0', border: '#BF0000', label: 'Rakuten'       },
  'hotmart-api':        { bg: '#fff3f0', border: '#FF5722', label: 'Hotmart'       },
  'eduzz-api':          { bg: '#f5f3ff', border: '#7C3AED', label: 'Eduzz'         },
  'monetizze-api':      { bg: '#f0fdf4', border: '#00B359', label: 'Monetizze'     },
  'dafiti-api':         { bg: '#f8f8f8', border: '#555555', label: 'Dafiti'        },
  // Plataformas de Parceria
  'ltk-api':            { bg: '#fff0f3', border: '#FF385C', label: 'LTK'            },
  'impact-api':         { bg: '#fff4f0', border: '#FF6B35', label: 'Impact.com'     },
  // Live Commerce
  'twitch-api':         { bg: '#f5f0ff', border: '#9146FF', label: 'Twitch'         },
  // Discovery Commerce
  'pinterest-api':      { bg: '#fff0f0', border: '#E60023', label: 'Pinterest'      },
  // E-commerce Builder
  'woocommerce-api':    { bg: '#f5f0ff', border: '#7F54B3', label: 'WooCommerce'    },
  'shopify-store-api':  { bg: '#f0f1ff', border: '#5C6AC4', label: 'Shopify'        },
  // Social Commerce
  'tiktok-shop':        { bg: '#f0f0f5', border: '#010101', label: 'TikTok Shop'    },
  'kwai-shop':          { bg: '#fff4ee', border: '#FF6600', label: 'Kwai Shop'      },
  'instagram-shop':     { bg: '#fff0f5', border: '#E1306C', label: 'Instagram'      },
  'youtube-shop':       { bg: '#fff0f0', border: '#FF0000', label: 'YouTube'        },
  'facebook-shop':      { bg: '#eff5ff', border: '#1877F2', label: 'Facebook'       },
}

// Variável global para os dados de lojas (busca local)
let _storesData = []

function _buildStoreCard(s) {
  const nc = NETWORK_COLORS[s.affiliate_network] || { bg: '#f8fafc', border: '#94a3b8', label: s.affiliate_network || '—' }
  const logoHTML = s.logo_url
    ? '<img src="' + s.logo_url + '" class="h-7 max-w-[72px] object-contain">'
    : '<div class="w-9 h-9 rounded-xl flex items-center justify-center font-bold text-white text-sm" style="background:' + nc.border + '">' + s.name[0] + '</div>'
  const statusBadge = s.is_active
    ? '<span class="flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full"><span class="w-1.5 h-1.5 bg-green-500 rounded-full inline-block"></span>Ativa</span>'
    : '<span class="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">Inativa</span>'
  const offersBadge = s.offer_count > 0
    ? '<span class="text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">' + s.offer_count + ' produto' + (s.offer_count > 1 ? 's' : '') + '</span>'
    : ''
  const checked = s.is_active ? 'checked' : ''
  const urlHint = s.checkout_pattern || s.deeplink_base || '—'

  // Botao Importar Links aparece em TODOS os cards de loja
  const importBtn = '<button onclick="event.stopPropagation();openStoreImport(' + s.id + ',\'' + (s.name||'').replace(/'/g,'&#39;') + '\')" class="w-full text-xs font-semibold py-2 px-3 rounded-xl border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-all mt-2">&#128229; Importar Links</button>'

  return (
    '<div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden hover:shadow-md transition-shadow" id="store-card-' + s.id + '">'
    + '<div class="px-4 py-3 flex items-center justify-between" style="background:' + nc.bg + ';border-bottom:2px solid ' + nc.border + '20">'
    +   '<div class="flex items-center gap-2.5">'
    +     '<div style="width:40px;height:40px;background:#fff;border-radius:10px;display:flex;align-items:center;justify-content:center;border:1px solid ' + nc.border + '30;overflow:hidden;box-shadow:0 2px 6px rgba(0,0,0,0.07)">'
    +       logoHTML
    +     '</div>'
    +     '<div>'
    +       '<div class="font-bold text-slate-800 text-sm leading-tight">' + s.name + '</div>'
    +       '<div class="text-xs font-medium mt-0.5" style="color:' + nc.border + '">' + nc.label + '</div>'
    +     '</div>'
    +   '</div>'
    +   '<label class="toggle-switch flex-shrink-0">'
    +     '<input type="checkbox" ' + checked + ' onchange="toggleStore(' + s.id + ', this.checked)">'
    +     '<span class="toggle-slider"></span>'
    +   '</label>'
    + '</div>'
    + '<div class="px-4 py-3">'
    +   '<div class="grid grid-cols-3 gap-2 text-center mb-3">'
    +     '<div class="bg-slate-50 rounded-xl p-2"><div class="text-lg font-black text-slate-800">' + (s.offer_count || 0) + '</div><div class="text-xs text-slate-400">Ofertas</div></div>'
    +     '<div class="bg-green-50 rounded-xl p-2"><div class="text-sm font-bold text-green-700">' + fBRL(s.min_price) + '</div><div class="text-xs text-slate-400">Menor preço</div></div>'
    +     '<div class="bg-blue-50 rounded-xl p-2"><div class="text-sm font-bold text-blue-700">' + (s.commission_rate || 0) + '%</div><div class="text-xs text-slate-400">Comissão</div></div>'
    +   '</div>'
    +   '<div class="flex items-center gap-2 mb-2">' + statusBadge + offersBadge + '</div>'
    +   '<div class="text-xs text-slate-400 truncate mb-3" title="' + urlHint + '">🔗 ' + urlHint + '</div>'
    +   '<button onclick="event.stopPropagation();openStoreModal(' + s.id + ')" class="w-full text-xs font-semibold py-2 px-3 rounded-xl border bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100 transition-all">✏️ Editar loja</button>'
    +   importBtn
    + '</div>'
    + '</div>'
  )
}

// ── IMPORTAR LINKS — universal por loja ─────────────────────────
// ── IMPORTAR LINKS — modal automático ───────────────────────────
// Fluxo: colar links → clicar Importar → sistema busca nome/preço/imagem → salva tudo
function openStoreImport(storeId, storeName) {
  const modal = document.getElementById('modal-container')
  modal.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this) closeModal()">
      <div class="modal" style="max-width:660px;width:96vw;max-height:92vh;overflow-y:auto">

        <!-- Header -->
        <div class="flex items-center justify-between mb-4">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-xl bg-indigo-100 flex items-center justify-center text-xl">&#128229;</div>
            <div>
              <h3 class="font-bold text-slate-800 text-lg leading-tight">Importar Links</h3>
              <p class="text-xs text-slate-500">Loja: <strong>${storeName}</strong></p>
            </div>
          </div>
          <button onclick="closeModal()" class="text-slate-400 hover:text-slate-700 text-2xl leading-none">&times;</button>
        </div>

        <!-- Tabs -->
        <div class="flex gap-1 bg-slate-100 rounded-xl p-1 mb-4">
          <button id="si-tab-paste"   onclick="siTab('paste')"           class="flex-1 text-xs font-semibold py-2 rounded-lg bg-white shadow-sm text-slate-800 transition-all">&#128203; Colar Links</button>
          <button id="si-tab-csv"     onclick="siTab('csv')"             class="flex-1 text-xs font-semibold py-2 rounded-lg text-slate-500 hover:text-slate-700 transition-all">&#128196; CSV</button>
          <button id="si-tab-history" onclick="siTab('history',${storeId})" class="flex-1 text-xs font-semibold py-2 rounded-lg text-slate-500 hover:text-slate-700 transition-all">&#128339; Hist&oacute;rico</button>
        </div>

        <!-- PAINEL: Colar Links -->
        <div id="si-panel-paste">

          <!-- Modo simples vs duplo -->
          <div class="flex gap-1 mb-3">
            <button id="si-mode-single" onclick="siSetMode('single')"
              class="flex-1 text-xs font-semibold py-1.5 rounded-lg bg-indigo-600 text-white transition-all">&#128279; Um link por produto</button>
            <button id="si-mode-dual" onclick="siSetMode('dual')"
              class="flex-1 text-xs font-semibold py-1.5 rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200 transition-all">&#128279;&#128279; Produto + Afiliado ML</button>
          </div>

          <!-- MODO SIMPLES: textarea com múltiplos links -->
          <div id="si-mode-single-area">
            <p class="text-xs text-slate-500 mb-2">Cole um ou mais links (um por linha). O sistema busca <strong>nome, pre&ccedil;o e imagem automaticamente</strong>.</p>
            <textarea id="si-textarea" rows="6"
              class="w-full rounded-xl border border-slate-200 bg-slate-50 text-sm font-mono p-3 resize-none focus:outline-none focus:border-indigo-400 focus:bg-white transition-all"
              placeholder="https://meli.la/1guaPXV&#10;https://meli.la/1vTGDBn&#10;https://meli.la/1piMeCE"
              oninput="siCountLinks()"></textarea>
            <div class="flex items-center justify-between mt-1">
              <span id="si-count" class="text-xs text-slate-400">0 links detectados</span>
              <button onclick="document.getElementById('si-textarea').value='';siCountLinks();document.getElementById('si-live-area').innerHTML=''" class="text-xs text-slate-400 hover:text-red-500">&#10005; Limpar</button>
            </div>
            <div id="si-wid-warn" class="hidden mt-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1"></div>
            <div class="mt-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-xs text-amber-800 leading-relaxed">
              <strong>&#9888;&#65039; Produto com variante</strong> (URL tem <code class="bg-amber-100 px-1 rounded">#...&amp;wid=MLB...</code>)?
              Cole o <strong>link afiliado</strong> (<code class="bg-amber-100 px-1 rounded">/social/...?ref=...</code>) <strong>na mesma linha</strong> — o sistema detecta o par automaticamente.<br>
              <span class="text-amber-600">Sem o link /social/, produtos com wid= não podem ser importados (bloqueio do ML).</span>
            </div>
          </div>

          <!-- MODO DUPLO: URL produto + URL afiliada lado a lado -->
          <div id="si-mode-dual-area" class="hidden">
            <div class="bg-blue-50 border border-blue-200 rounded-xl px-3 py-2 text-xs text-blue-800 mb-3">
              &#128161; Cole a <strong>URL do produto</strong> (com <code>#...&amp;wid=MLB...</code>) e a <strong>URL afiliada</strong> (<code>/social/...</code>) — o sistema cruza os dois para pegar imagem e pre&ccedil;o.
            </div>
            <div id="si-dual-pairs">
              <!-- pares gerados por siAddDualPair() -->
            </div>
            <button onclick="siAddDualPair()" class="w-full text-xs text-indigo-600 hover:text-indigo-800 border border-dashed border-indigo-300 rounded-xl py-2 mt-1 hover:bg-indigo-50 transition-all">
              + Adicionar outro par
            </button>
          </div>

          <!-- Botão principal -->
          <div class="mt-3 mb-0">
            <button id="si-main-btn" onclick="siImportAuto(${storeId})"
              class="w-full py-3 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 active:scale-95 transition-all flex items-center justify-center gap-2">
              <span>&#128640;</span> Importar Automaticamente
            </button>
          </div>
          <!-- Área de progresso e resultado ao vivo -->
          <div id="si-live-area" class="mt-4"></div>
        </div>

        <!-- PAINEL: CSV -->
        <div id="si-panel-csv" class="hidden">
          <div class="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-800 mb-3">
            <p class="font-bold mb-1">&#128196; Formato CSV aceito:</p>
            <div class="font-mono space-y-0.5">
              <div class="text-amber-600">url,name,price,image_url</div>
              <div>https://meli.la/1guaPXV,T&ecirc;nis Adidas,299.90,https://img...</div>
            </div>
            <p class="mt-2 text-amber-700">Se name/price/image estiverem vazios, o sistema busca automaticamente.</p>
          </div>
          <div class="border-2 border-dashed border-slate-200 rounded-xl p-8 text-center cursor-pointer hover:border-indigo-400 hover:bg-indigo-50 transition-all" onclick="document.getElementById('si-csv-input').click()">
            <div class="text-3xl mb-2">&#128194;</div>
            <p class="text-sm font-semibold text-slate-700">Clique para selecionar CSV ou TXT</p>
            <p class="text-xs text-slate-400 mt-1" id="si-csv-name">Nenhum arquivo selecionado</p>
          </div>
          <input type="file" id="si-csv-input" accept=".csv,.txt" class="hidden" onchange="siReadCsv(this,${storeId})">
          <div id="si-csv-live-area" class="mt-3"></div>
        </div>

        <!-- PAINEL: Histórico -->
        <div id="si-panel-history" class="hidden">
          <div id="si-history-content"><div class="text-center py-10 text-slate-400 text-sm">&#128260; Carregando...</div></div>
        </div>
      </div>
    </div>
  `
  siCountLinks()
}

function siTab(tab, storeId) {
  ['paste','csv','history'].forEach(t => {
    const btn   = document.getElementById('si-tab-' + t)
    const panel = document.getElementById('si-panel-' + t)
    if (!btn || !panel) return
    const active = t === tab
    btn.classList.toggle('bg-white',       active)
    btn.classList.toggle('shadow-sm',      active)
    btn.classList.toggle('text-slate-800', active)
    btn.classList.toggle('text-slate-500', !active)
    panel.classList.toggle('hidden', !active)
  })
  if (tab === 'history' && storeId) siLoadHistory(storeId)
}

// Detecta se uma URL é link afiliado /social/ do ML
function siIsSocialUrl(u) {
  return /\/social\/[a-z0-9]+/i.test(u)
}
// Detecta se uma URL é link de produto do ML (não /social/)
function siIsProductUrl(u) {
  return /mercadolivre\.com\.br|meli\.la/i.test(u) && !siIsSocialUrl(u)
}

// Extrai URLs de um trecho de texto, separando mesmo URLs grudadas (sem espaço entre elas)
// Usa split em 'https://' como delimitador para capturar URLs concatenadas
function siExtractUrlsFromText(text) {
  return text
    .split(/(?=https?:\/\/)/g)
    .map(s => s.trim())
    .filter(s => /^https?:\/\//i.test(s))
    .map(u => u.replace(/[.,;)>\]]+$/, '').trim())
    .filter(Boolean)
}

// Parseia o texto da textarea em itens: cada item é { url1, url2? }
// Regra: se numa linha tiver URL de produto ML + URL /social/ → une como par
// Suporta URLs grudadas (sem espaço/vírgula entre elas) — split em https://
function siParseTextarea(val) {
  const items = []
  const seen  = new Set()
  const lines = val.split(/\n/)
  for (const line of lines) {
    if (!line.trim()) continue
    // Extrai todas as URLs da linha — separa mesmo URLs grudadas
    const raw = siExtractUrlsFromText(line)
    if (!raw.length) continue
    if (raw.length >= 2) {
      // Tenta achar par produto+social dentro da mesma linha
      const socialIdx  = raw.findIndex(u => siIsSocialUrl(u))
      const productIdx = raw.findIndex(u => siIsProductUrl(u))
      if (socialIdx !== -1 && productIdx !== -1 && socialIdx !== productIdx) {
        const key = raw[productIdx] + '|' + raw[socialIdx]
        if (!seen.has(key)) {
          seen.add(key)
          items.push({ url1: raw[productIdx], url2: raw[socialIdx] })
        }
        // Adiciona demais URLs da linha como itens individuais
        raw.forEach((u, i) => {
          if (i !== socialIdx && i !== productIdx && !seen.has(u)) {
            seen.add(u); items.push({ url1: u })
          }
        })
        continue
      }
    }
    // Linha com 1 URL (ou sem par detectável) → itens individuais
    for (const u of raw) {
      if (!seen.has(u)) { seen.add(u); items.push({ url1: u }) }
    }
  }
  return items
}

function siCountLinks() {
  const val   = document.getElementById('si-textarea')?.value || ''
  const items = siParseTextarea(val)
  const pairs = items.filter(i => i.url2).length
  const solo  = items.filter(i => !i.url2).length
  const el    = document.getElementById('si-count')
  if (!el) return
  if (!items.length) { el.textContent = '0 links detectados'; return }
  const parts = []
  if (pairs) parts.push(pairs + (pairs === 1 ? ' par produto+afiliado' : ' pares produto+afiliado'))
  if (solo)  parts.push(solo  + (solo  === 1 ? ' link'                  : ' links'))
  el.textContent = parts.join(' + ') + ' detectado' + (items.length === 1 ? '' : 's')
  // Avisa se há links solo com #wid= (precisam de par /social/ para funcionar)
  const widSolo = items.filter(i => !i.url2 && /[#&]wid=MLB/i.test(i.url1)).length
  const warnEl  = document.getElementById('si-wid-warn')
  if (warnEl) {
    if (widSolo > 0) {
      warnEl.textContent = '⚠️ ' + widSolo + (widSolo === 1 ? ' link tem #wid= mas está sem o link /social/ — cole os dois juntos na mesma linha.' : ' links têm #wid= mas estão sem o link /social/ — cole cada par junto na mesma linha.')
      warnEl.classList.remove('hidden')
    } else {
      warnEl.classList.add('hidden')
    }
  }
}

// ── IMPORTAÇÃO AUTOMÁTICA COMPLETA ───────────────────────────────

// Gera skeleton cards para cada URL (estado inicial — cinza/carregando)
function siLiveCards(urls) {
  return '<div id="si-cards-wrap" class="flex flex-col gap-2 mb-3">' +
    urls.map(function(u, i) {
      const short = u.length > 50 ? u.slice(0, 50) + '…' : u
      return '<div id="si-card-' + i + '" class="flex items-center gap-3 p-2.5 rounded-xl border border-slate-200 bg-slate-50">' +
        '<div class="w-10 h-10 rounded-lg bg-slate-200 animate-pulse flex-shrink-0"></div>' +
        '<div class="flex-1 min-w-0">' +
          '<div class="h-3 bg-slate-200 rounded animate-pulse mb-1.5 w-3/4"></div>' +
          '<div class="text-[10px] text-slate-400 truncate">' + short + '</div>' +
        '</div>' +
        '<div class="text-xs text-slate-400 animate-pulse">⏳</div>' +
      '</div>'
    }).join('') +
  '</div>'
}

// Converte URL de imagem ML para proxy interno (evita hotlink block)
function siProxyImg(imgUrl) {
  if (!imgUrl) return ''
  // URLs da API ML (pictures[0].url) já funcionam sem proxy
  // URLs do og:image (http2.mlstatic.com) precisam de proxy
  if (imgUrl.includes('mlstatic.com')) {
    return '/admin/api/proxy-img?url=' + encodeURIComponent(imgUrl)
  }
  return imgUrl
}

// Atualiza um card com os metadados recebidos (verde = ok, vermelho = erro)
function siUpdateCard(idx, url, meta) {
  const el = document.getElementById('si-card-' + idx)
  if (!el) return
  if (meta && meta.name) {
    const imgSrc = meta.image ? siProxyImg(meta.image) : ''
    const img = imgSrc
      ? '<img src="' + imgSrc + '" class="w-10 h-10 rounded-lg object-cover flex-shrink-0" onerror="this.style.display=\'none\'">'
      : '<div class="w-10 h-10 rounded-lg bg-green-100 flex items-center justify-center flex-shrink-0 text-lg">🛍️</div>'
    const priceHtml = meta.price
      ? '<span class="text-[11px] font-bold text-green-700">R$ ' + Number(meta.price).toLocaleString('pt-BR', {minimumFractionDigits:2}) + '</span>'
      : '<span class="text-[11px] text-slate-400">sem preço</span>'
    el.className = 'flex items-center gap-3 p-2.5 rounded-xl border border-green-200 bg-green-50'
    el.innerHTML = img +
      '<div class="flex-1 min-w-0">' +
        '<div class="text-xs font-semibold text-slate-800 truncate leading-tight">' + meta.name + '</div>' +
        priceHtml +
      '</div>' +
      '<span class="text-green-500 text-base">✓</span>'
  } else {
    el.className = 'flex items-center gap-3 p-2.5 rounded-xl border border-red-200 bg-red-50'
    el.innerHTML = '<div class="w-10 h-10 rounded-lg bg-red-100 flex items-center justify-center flex-shrink-0 text-lg">❌</div>' +
      '<div class="flex-1 min-w-0">' +
        '<div class="text-xs font-semibold text-red-600">Não foi possível obter dados</div>' +
        '<div class="text-[10px] text-slate-400 truncate">' + (url.length > 50 ? url.slice(0,50)+'…' : url) + '</div>' +
      '</div>' +
      '<span class="text-red-400 text-base">✗</span>'
  }
}

// Renderiza resumo final do import (quantos ok, erros, etc.)
function siRenderResult(data, el) {
  if (!data) return
  const rows = (data.results || []).map(function(r) {
    const icon = r.status === 'importado' ? '✅' : r.status === 'atualizado' ? '🔄' : r.status === 'já existe' ? '⏭️' : '❌'
    const info = r.error ? ' — ' + r.error : (r.name ? ' — ' + r.name.slice(0,40) : '')
    return '<li class="text-xs text-slate-600">' + icon + ' ' + r.status + info + '</li>'
  }).join('')
  el.innerHTML = '<div class="mt-2 p-3 rounded-xl bg-slate-50 border border-slate-200">' +
    '<div class="flex gap-4 text-xs font-bold mb-2">' +
      '<span class="text-green-700">✅ ' + (data.imported||0) + ' importados</span>' +
      (data.skipped ? '<span class="text-slate-500">⏭️ ' + data.skipped + ' já existiam</span>' : '') +
      (data.errors  ? '<span class="text-red-600">❌ ' + data.errors  + ' erros</span>'      : '') +
    '</div>' +
    (rows ? '<ul class="space-y-0.5 max-h-32 overflow-y-auto">' + rows + '</ul>' : '') +
  '</div>'
}

function siBtnReset(btn, storeId, label) {
  if (!btn) return
  btn.disabled = false
  btn.className = 'w-full py-3 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 active:scale-95 transition-all'
  btn.innerHTML = label || '&#128640; Importar Automaticamente'
  btn.onclick = function() { siImportAuto(storeId) }
}

// ── Modo simples / duplo ──────────────────────────────────────────
let _siMode = 'single'
function siSetMode(mode) {
  _siMode = mode
  const single = document.getElementById('si-mode-single-area')
  const dual   = document.getElementById('si-mode-dual-area')
  const btnS   = document.getElementById('si-mode-single')
  const btnD   = document.getElementById('si-mode-dual')
  if (single) single.classList.toggle('hidden', mode !== 'single')
  if (dual)   dual.classList.toggle('hidden',   mode !== 'dual')
  if (btnS) { btnS.className = 'flex-1 text-xs font-semibold py-1.5 rounded-lg transition-all ' + (mode==='single' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200') }
  if (btnD) { btnD.className = 'flex-1 text-xs font-semibold py-1.5 rounded-lg transition-all ' + (mode==='dual'   ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200') }
  // garante pelo menos 1 par no modo dual
  if (mode === 'dual') {
    const pairs = document.getElementById('si-dual-pairs')
    if (pairs && pairs.children.length === 0) siAddDualPair()
  }
}

let _siPairIdx = 0
function siAddDualPair() {
  const i = _siPairIdx++
  const wrap = document.getElementById('si-dual-pairs')
  if (!wrap) return
  const div = document.createElement('div')
  div.id = 'si-pair-' + i
  div.className = 'bg-white border border-slate-200 rounded-xl p-3 mb-2 relative'
  div.innerHTML = `
    <button onclick="document.getElementById('si-pair-${i}').remove()" class="absolute top-2 right-2 text-slate-300 hover:text-red-500 text-lg leading-none">&times;</button>
    <div class="mb-2">
      <label class="block text-xs font-semibold text-slate-600 mb-1">&#128279; URL do Produto (sem afiliado)</label>
      <input type="url" id="si-p1-${i}" class="w-full rounded-lg border border-slate-200 bg-slate-50 text-xs font-mono p-2 focus:outline-none focus:border-indigo-400" placeholder="https://www.mercadolivre.com.br/.../up/MLBU...#...&wid=MLB5385902202&...">
    </div>
    <div>
      <label class="block text-xs font-semibold text-slate-600 mb-1">&#128279; URL Afiliada (link /social/ com imagem e pre&ccedil;o)</label>
      <input type="url" id="si-p2-${i}" class="w-full rounded-lg border border-slate-200 bg-slate-50 text-xs font-mono p-2 focus:outline-none focus:border-indigo-400" placeholder="https://www.mercadolivre.com.br/social/cfeg...?matt_word=...&forceInApp=true">
    </div>
  `
  wrap.appendChild(div)
}

function siGetDualPairs() {
  // Retorna array de { url1, url2 } a partir dos campos do modo dual
  const pairs = []
  const wrap = document.getElementById('si-dual-pairs')
  if (!wrap) return pairs
  wrap.querySelectorAll('[id^="si-pair-"]').forEach(div => {
    const idx  = div.id.replace('si-pair-', '')
    const url1 = (document.getElementById('si-p1-' + idx)?.value || '').trim()
    const url2 = (document.getElementById('si-p2-' + idx)?.value || '').trim()
    if (url1 || url2) pairs.push({ url1: url1 || url2, url2: url1 ? url2 : '' })
  })
  return pairs
}
// ──────────────────────────────────────────────────────────────────

async function siImportAuto(storeId) {
  // Modo duplo: pega pares { url1, url2 } dos campos
  if (_siMode === 'dual') {
    const pairs = siGetDualPairs().filter(p => p.url1)
    if (!pairs.length) { toast('Preencha pelo menos um par de links', 'warning'); return }
    return siImportDual(storeId, pairs)
  }

  // Modo simples: detecta pares produto+afiliado automaticamente
  const val   = document.getElementById('si-textarea')?.value || ''
  const items = siParseTextarea(val)   // [{url1, url2?}, ...]

  // Se há pares detectados → delega ao siImportDual (já suporta url2)
  const hasPairs = items.some(i => i.url2)
  if (hasPairs) {
    return siImportDual(storeId, items)
  }

  // Sem pares → fluxo original (só url1)
  const urls = items.map(i => i.url1)

  if (!urls.length) { toast('Cole pelo menos um link antes de importar', 'warning'); return }

  const live = document.getElementById('si-live-area')
  const btn  = document.getElementById('si-main-btn')

  const setBtnLoading = (msg) => {
    if (!btn) return
    btn.disabled = true
    btn.className = 'w-full py-3 rounded-xl bg-indigo-400 text-white text-sm font-bold cursor-not-allowed mt-0'
    btn.innerHTML = '<svg class="w-4 h-4 animate-spin mr-2 inline" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"></path></svg> ' + msg
  }

  try {
    setBtnLoading('Buscando dados...')

    live.innerHTML = siLiveCards(urls) +
      '<div id="si-prog-wrap" class="mb-3">' +
        '<div class="flex justify-between text-xs text-slate-500 mb-1">' +
          '<span id="si-prog-txt">Buscando informa\u00e7\u00f5es dos produtos...</span>' +
          '<span id="si-prog-n" class="font-bold text-indigo-600">0/' + urls.length + '</span>' +
        '</div>' +
        '<div class="h-2 bg-slate-100 rounded-full overflow-hidden">' +
          '<div id="si-prog-bar" class="h-full bg-indigo-500 rounded-full transition-all duration-300" style="width:0%"></div>' +
        '</div>' +
      '</div>' +
      '<div id="si-result-area"></div>'

    const metaMap = {}
    const BATCH = 3  // reduzido para evitar timeout no Worker
    let done = 0

    for (let s = 0; s < urls.length; s += BATCH) {
      const batch = urls.slice(s, s + BATCH)
      const results = await Promise.all(batch.map(u => siFetchMetaClientSide(u)))
      batch.forEach((u, bi) => {
        metaMap[u] = results[bi]
        done++
        siUpdateCard(s + bi, u, results[bi])
        const pct = Math.round((done / urls.length) * 100)
        const bar = document.getElementById('si-prog-bar')
        const nEl = document.getElementById('si-prog-n')
        const tEl = document.getElementById('si-prog-txt')
        if (bar) bar.style.width = pct + '%'
        if (nEl) nEl.textContent = done + '/' + urls.length
        if (tEl) tEl.textContent = pct < 100 ? 'Buscando...' : '\u2713 Pronto!'
      })
    }

    // Filtra apenas URLs que têm nome (o backend exige nome)
    // Usa affiliateUrl montado pelo backend (permalink?matt_word=...) quando disponível
    const lines = urls.map(function(u) {
      const m = metaMap[u]
      if (!m || !m.name) return null   // sem nome = pula
      const saveUrl = m.affiliateUrl || u
      let line = saveUrl + ' | ' + m.name
      if (m.price) line += ' | ' + m.price
      if (m.image) line += ' | ' + m.image
      return line
    }).filter(Boolean)

    const semNome = urls.length - lines.length
    if (!lines.length) {
      const progWrap = document.getElementById('si-prog-wrap')
      if (progWrap) progWrap.innerHTML = '<p class="text-xs text-red-500 font-semibold text-center py-1">\u26a0 Nenhum produto com nome encontrado. Verifique os links.</p>'
      siBtnReset(btn, storeId, '\u26a0 Tentar novamente')
      return
    }

    const progWrap = document.getElementById('si-prog-wrap')
    if (progWrap) {
      const aviso = semNome > 0 ? ` (${semNome} sem nome, ignorados)` : ''
      progWrap.innerHTML = '<p class="text-xs text-green-600 font-semibold text-center py-1">\u2713 ' + lines.length + ' produto(s) prontos' + aviso + ' \u2014 salvando...</p>'
    }

    setBtnLoading('Salvando no banco...')

    const data = await api('POST', '/admin/api/stores/' + storeId + '/import-links', { links: lines.join('\n') }, 30000)

    const resEl = document.getElementById('si-result-area')
    if (resEl && data) siRenderResult(data, resEl)

    if (data && data.ok) {
      toast('\u2713 ' + data.imported + ' produto(s) importados em ' + data.store_name + '!', 'success')
      if (btn) {
        btn.disabled = false
        btn.className = 'w-full py-3 rounded-xl bg-green-600 text-white text-sm font-bold mt-0'
        btn.innerHTML = '\u2713 ' + data.imported + ' produto(s) salvos! Importar mais'
        btn.onclick = function() {
          document.getElementById('si-textarea').value = ''
          siCountLinks()
          document.getElementById('si-live-area').innerHTML = ''
          siBtnReset(btn, storeId)
        }
      }
    } else {
      toast((data && data.error) || 'Erro ao salvar', 'error')
      if (btn) {
        btn.disabled = false
        btn.className = 'w-full py-3 rounded-xl bg-red-600 text-white text-sm font-bold mt-0'
        btn.innerHTML = '\u26a0 Erro \u2014 Tentar novamente'
        btn.onclick = function() { siImportAuto(storeId) }
      }
    }

  } catch(err) {
    console.error('siImportAuto error:', err)
    const errMsg = err?.message || err?.name || String(err) || 'desconhecido'
    // Mostra o erro visível no modal para debug
    const live2 = document.getElementById('si-live-area')
    if (live2) live2.innerHTML += '<div class="mt-2 p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700 font-mono break-all">\u26a0 ERRO: ' + errMsg + '</div>'
    toast('Erro: ' + errMsg, 'error')
    siBtnReset(btn, storeId, '\u26a0 Erro \u2014 Tentar novamente')
  }
}

// ── Fetch de metadados — estratégia em camadas ──────────────────
// Para links Mercado Livre:
//   1) Backend resolve-url → mlbId + og:title + og:image + preço via /social/ (pares com #wid=)
//   2) Browser busca HTML da página ML como fallback (sem bloqueio de IP)
//   3) API ML direto do browser como fallback (só funciona para Item IDs ≥11 dígitos)
// Para outros links: allorigins.win como fallback
// ── siImportDual: importa pares url1+url2 (também usado pelo modo simples quando detecta pares) ──
async function siImportDual(storeId, pairs) {
  const live = document.getElementById('si-live-area')
  const btn  = document.getElementById('si-main-btn')
  const setBtnLoading = (msg) => {
    if (!btn) return
    btn.disabled = true
    btn.className = 'w-full py-3 rounded-xl bg-indigo-400 text-white text-sm font-bold cursor-not-allowed'
    btn.innerHTML = '<svg class="w-4 h-4 animate-spin mr-2 inline" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"></path></svg> ' + msg
  }

  // Monta skeleton cards com badge "par" para itens que têm url2
  const skeletonCards = '<div id="si-cards-wrap" class="flex flex-col gap-2 mb-3">' +
    pairs.map(function(p, i) {
      const label = p.url2
        ? '<span class="text-[9px] font-bold bg-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded-full mr-1">par</span>'
        : ''
      const short = (p.url1 || '').length > 50 ? p.url1.slice(0, 50) + '…' : (p.url1 || '')
      return '<div id="si-card-' + i + '" class="flex items-center gap-3 p-2.5 rounded-xl border border-slate-200 bg-slate-50">' +
        '<div class="w-10 h-10 rounded-lg bg-slate-200 animate-pulse flex-shrink-0"></div>' +
        '<div class="flex-1 min-w-0">' +
          '<div class="h-3 bg-slate-200 rounded animate-pulse mb-1.5 w-3/4"></div>' +
          '<div class="text-[10px] text-slate-400 truncate">' + label + short + '</div>' +
        '</div>' +
        '<div class="text-xs text-slate-400 animate-pulse">⏳</div>' +
      '</div>'
    }).join('') +
  '</div>'

  try {
    setBtnLoading('Buscando dados...')
    live.innerHTML = skeletonCards +
      '<div id="si-prog-wrap" class="mb-3">' +
        '<div class="flex justify-between text-xs text-slate-500 mb-1">' +
          '<span id="si-prog-txt">Buscando informações dos produtos...</span>' +
          '<span id="si-prog-n" class="font-bold text-indigo-600">0/' + pairs.length + '</span>' +
        '</div>' +
        '<div class="h-2 bg-slate-100 rounded-full overflow-hidden">' +
          '<div id="si-prog-bar" class="h-full bg-indigo-500 rounded-full transition-all duration-300" style="width:0%"></div>' +
        '</div>' +
      '</div>' +
      '<div id="si-result-area"></div>'

    // Processa em lotes de 3 com feedback visual em tempo real
    const metaArr = new Array(pairs.length).fill(null)
    const BATCH = 3
    let done = 0
    for (let s = 0; s < pairs.length; s += BATCH) {
      const batch = pairs.slice(s, s + BATCH)
      const results = await Promise.all(batch.map(p => siFetchMetaClientSide(p.url1, p.url2)))
      results.forEach((m, bi) => {
        const idx = s + bi
        metaArr[idx] = m
        done++
        siUpdateCard(idx, pairs[idx].url1, m)
        const pct = Math.round((done / pairs.length) * 100)
        const bar = document.getElementById('si-prog-bar')
        const nEl = document.getElementById('si-prog-n')
        const tEl = document.getElementById('si-prog-txt')
        if (bar) bar.style.width = pct + '%'
        if (nEl) nEl.textContent = done + '/' + pairs.length
        if (tEl) tEl.textContent = pct < 100 ? 'Buscando...' : '✓ Pronto!'
      })
    }

    const lines = []
    metaArr.forEach((m, i) => {
      if (!m || !m.name) return
      const u = pairs[i].url1
      // Usa affiliateUrl montado pelo backend (permalink?matt_word=...) quando disponível
      const saveUrl = m.affiliateUrl || u
      let line = saveUrl + ' | ' + m.name
      if (m.price) line += ' | ' + m.price
      if (m.image) line += ' | ' + m.image
      lines.push(line)
    })

    const semNome = pairs.length - lines.length
    const progWrap = document.getElementById('si-prog-wrap')
    if (!lines.length) {
      if (progWrap) progWrap.innerHTML = '<p class="text-xs text-red-500 font-semibold text-center py-1">⚠ Nenhum produto com nome encontrado. Verifique os links.</p>'
      siBtnReset(btn, storeId, '⚠ Tentar novamente')
      return
    }
    if (progWrap) {
      const aviso = semNome > 0 ? ` (${semNome} sem nome, ignorados)` : ''
      progWrap.innerHTML = '<p class="text-xs text-green-600 font-semibold text-center py-1">✓ ' + lines.length + ' produto(s) prontos' + aviso + ' — salvando...</p>'
    }

    setBtnLoading('Salvando no banco...')
    const data = await api('POST', '/admin/api/stores/' + storeId + '/import-links', { links: lines.join('\n') }, 30000)
    const resEl = document.getElementById('si-result-area')
    if (resEl && data) siRenderResult(data, resEl)

    if (data?.ok) {
      toast('✓ ' + data.imported + ' produto(s) importados!', 'success')
      if (btn) {
        btn.disabled = false
        btn.className = 'w-full py-3 rounded-xl bg-green-600 text-white text-sm font-bold'
        btn.innerHTML = '✓ ' + data.imported + ' produto(s) salvos! Importar mais'
        btn.onclick = function() {
          document.getElementById('si-textarea').value = ''
          siCountLinks()
          document.getElementById('si-live-area').innerHTML = ''
          siBtnReset(btn, storeId)
        }
      }
    } else {
      toast('Erro ao salvar: ' + (data?.error || '?'), 'error')
      siBtnReset(btn, storeId)
    }
  } catch(e) {
    toast('Erro: ' + e?.message, 'error')
    siBtnReset(btn, storeId)
  }
}
// ──────────────────────────────────────────────────────────────────

async function siFetchMetaClientSide(originalUrl, affiliateUrl) {
  const isML = /mercadolivre\.com\.br|mercadolibre\.com|meli\.la/i.test(originalUrl)

  // ── CAMADA 1: backend resolve-url → mlbId + nome + imagem ──────
  // Se temos affiliateUrl (link /social/), passa como url2 pro backend
  let r = null
  try {
    let endpoint = '/admin/api/resolve-url?url=' + encodeURIComponent(originalUrl)
    if (affiliateUrl) endpoint += '&url2=' + encodeURIComponent(affiliateUrl)
    r = await api('GET', endpoint, null, 18000)
  } catch(e) { r = null }

  let name  = (r?.name  || '').trim()
  let image = r?.image  || null
  let price = r?.price  || null
  const mlbId       = r?.mlbId       || null
  // affiliateUrl montado automaticamente pelo backend: permalink?matt_word=...&matt_tool=...
  const builtAffUrl = r?.affiliateUrl || null

  // ── CAMADA 2: browser busca HTML da página ML ──────────────────
  // IPs do datacenter Cloudflare são banidos pelo ML (302→account-verification).
  // O browser do usuário NÃO é banido (IP residencial/comercial + cookies ML).
  // O browser faz fetch do HTML completo e extrai preço/nome/imagem LOCALMENTE
  // (não envia o HTML para o servidor — é 460KB por produto).
  if (isML && (!price || !name || !image)) {
    try {
      let mlUrl = originalUrl
      if (mlbId) {
        const digits = mlbId.replace(/^MLB/i, '')
        if (digits.length <= 10) {
          mlUrl = `https://www.mercadolivre.com.br/p/${mlbId}`
        } else {
          mlUrl = `https://produto.mercadolivre.com.br/${mlbId.replace(/^MLB/i,'MLB-')}`
        }
      }
      const htmlResp = await fetch(mlUrl, {
        headers: { 'Accept': 'text/html', 'Accept-Language': 'pt-BR,pt;q=0.9' },
        signal: AbortSignal.timeout(14000),
      })
      if (htmlResp.ok) {
        const html = await htmlResp.text()
        if (html && html.length > 5000) {
          // Extrai preço localmente com regex — o price fica em ~53% do HTML (pos 244KB)
          const pricePatterns = [
            /"price"\s*:\s*([\d]+(?:\.[\d]{1,2})?)/,
            /"amount"\s*:\s*([\d]+(?:\.[\d]{1,2})?)/,
          ]
          for (const pat of pricePatterns) {
            const m = html.match(pat)
            if (m) {
              const val = parseFloat(m[1])
              if (!isNaN(val) && val > 0 && val < 9_000_000) { price = val; break }
            }
          }
          // Extrai nome do og:title se ainda não temos
          if (!name) {
            const tm = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
                    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)
            if (tm) {
              name = tm[1]
                .replace(/\s*-\s*R\$\s*[\d.,]+\s*$/i, '')
                .replace(/\s*[|–\-]\s*(Mercado Livr[eo].*|ML.*)$/i, '')
                .replace(/&amp;/g,'&').trim()
            }
          }
          // Extrai imagem do og:image se ainda não temos
          if (!image) {
            const im = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
            if (im) {
              let img = im[1].replace(/\\u002F/g,'/').replace(/\\/g,'')
              if (img.startsWith('//')) img = 'https:' + img
              img = img.replace(/_[A-Z](-\d+)?(\.(webp|jpg|png))(\?.*)?$/, '_O$2')
              if (img.includes('mlstatic')) image = img
            }
          }
        }
      }
    } catch(e) {
      console.warn('[browser-fetch-ML] falhou:', e?.message)
    }
  }

  // ── CAMADA 3: API ML via browser (fallback para Item IDs) ───────
  // Acionada quando falta preço OU nome (backend pode ter retornado 403/404 da API ML).
  // A API ML pública tem CORS aberto — o browser do usuário acessa sem bloqueio.
  // Product IDs (≤10 dígitos) retornam 403 da API pública, só Item IDs funcionam.
  if (mlbId && (!price || !name)) {
    const digits = mlbId.replace(/^MLB/i, '')
    if (digits.length >= 11) {
      try {
        const ml = await siFetchMlApi(mlbId)
        if (ml) {
          if (ml.name)  name  = name  || ml.name
          if (ml.image) image = image || ml.image
          if (ml.price && !price) price = ml.price
        }
      } catch(e) {
        console.warn('[siFetchMlApi] falhou para', mlbId, e?.message)
      }
    }
  }

  // Retorna se temos ao menos nome
  if (name) return { name, price, image, affiliateUrl: builtAffUrl }

  // ── CAMADA 4: fallback allorigins.win (links não-ML) ────────────
  if (!isML) {
    try { return await siFetchOgMeta(originalUrl) } catch(e) { /* ignora */ }
  }

  return null
}

// Chama API pública do Mercado Livre — CORS aberto para browsers em produção
// A API ML bloqueia servidores (403 "PA_UNAUTHORIZED_RESULT_FROM_POLICIES")
// mas permite acesso direto de browsers autorizados via CORS.
// Retorna: { name, price, image } — imagem via proxy só se for mlstatic.com
async function siFetchMlApi(mlbId) {
  try {
    const r = await fetch(
      'https://api.mercadolibre.com/items/' + mlbId + '?attributes=id,title,price,thumbnail,pictures',
      {
        headers: {
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        signal: AbortSignal.timeout(10000),
      }
    )
    if (!r.ok) {
      console.warn('[siFetchMlApi] HTTP', r.status, 'para', mlbId)
      return null
    }
    const d = await r.json()
    if (!d || !d.title) return null

    const pics = d.pictures || []
    // pictures[0].url da API ML é CDN direto — sem hotlink block, usa sem proxy
    const rawImg = (pics[0] && pics[0].url)
      ? pics[0].url.replace('http://', 'https://')
      : (d.thumbnail || '')
          .replace('-I.jpg', '-O.jpg')
          .replace('-I.webp', '-O.webp')
          .replace('http://', 'https://')

    // Aplica proxy só se for mlstatic.com (og:image fallback); CDN direto usa sem proxy
    const img = rawImg ? siProxyImg(rawImg) : null

    const price = (d.price && d.price > 0) ? d.price : null
    return { name: d.title || '', price, image: img || null }
  } catch(e) {
    console.warn('[siFetchMlApi] erro:', mlbId, e?.message)
    return null
  }
}

// Fallback: og:meta tags via allorigins (proxy CORS público)
async function siFetchOgMeta(url) {
  try {
    const proxyUrl = 'https://api.allorigins.win/get?url=' + encodeURIComponent(url)
    const r = await fetch(proxyUrl, { signal: AbortSignal.timeout(8000) })
    if (!r.ok) return null
    const d = await r.json()
    const html = d.contents || ''
    if (!html) return null

    function getMeta(prop) {
      const m = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]+content=["\']([^"\']+)["\']', 'i'))
             || html.match(new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']' + prop + '["\']', 'i'))
      return m ? m[1].trim() : ''
    }

    let name = getMeta('og:title') || getMeta('twitter:title') || ''
    name = name.replace(/\s*[|\u2013\u2014-]\s*(Mercado Livr[eo]|Amazon\.com\.br|Americanas|Magazine Luiza|Shopee).*/gi, '').trim()

    const img    = getMeta('og:image') || getMeta('twitter:image') || ''
    const priceM = html.match(/"price"\s*:\s*([\d]+(?:[.,][\d]{1,2})?)/)
    const price  = priceM ? parseFloat(priceM[1].replace(',', '.')) : null

    if (!name) return null
    return { name, price: price || null, image: img || null }
  } catch { return null }
}

// ── IMPORTAR LINKS AFILIADOS ML (legado) ────────────────────────
function openMlAffiliateImport() {
  const modal = document.getElementById('modal-container')
  modal.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this) closeModal()">
      <div class="modal" style="max-width:640px;width:95vw">

        <!-- Header -->
        <div class="flex items-center gap-3 mb-1">
          <div class="w-10 h-10 rounded-xl bg-yellow-100 flex items-center justify-center text-xl">📥</div>
          <div>
            <h3 class="font-bold text-slate-800 text-lg leading-tight">Importar Links Afiliados ML</h3>
            <p class="text-xs text-slate-500">Cole seus links meli.la/... ou links longos do Mercado Livre</p>
          </div>
        </div>

        <!-- Tabs: Colar / CSV / Histórico -->
        <div class="flex gap-1 bg-slate-100 rounded-xl p-1 mb-4 mt-4">
          <button id="tab-paste" onclick="mlImportTab('paste')"
            class="flex-1 text-xs font-semibold py-2 rounded-lg bg-white shadow-sm text-slate-700 transition-all">
            📋 Colar Links
          </button>
          <button id="tab-csv" onclick="mlImportTab('csv')"
            class="flex-1 text-xs font-semibold py-2 rounded-lg text-slate-500 hover:text-slate-700 transition-all">
            📄 Arquivo CSV
          </button>
          <button id="tab-history" onclick="mlImportTab('history')"
            class="flex-1 text-xs font-semibold py-2 rounded-lg text-slate-500 hover:text-slate-700 transition-all">
            🕓 Histórico
          </button>
        </div>

        <!-- Painel: Colar -->
        <div id="panel-paste">
          <div class="mb-3">
            <label class="block text-xs font-semibold text-slate-600 mb-1.5">
              Cole seus links abaixo — um por linha, separados por vírgula ou espaço
            </label>
            <textarea id="ml-links-textarea"
              class="w-full rounded-xl border border-slate-200 bg-slate-50 text-sm font-mono p-3 resize-none focus:outline-none focus:border-yellow-400 focus:bg-white transition-all"
              rows="8"
              placeholder="https://meli.la/2fsawYr&#10;https://meli.la/19tECKW&#10;https://www.mercadolivre.com.br/produto/MLB123456789..."></textarea>
            <div class="flex items-center justify-between mt-1.5">
              <span id="ml-link-count" class="text-xs text-slate-400">0 links detectados</span>
              <button onclick="document.getElementById('ml-links-textarea').value=''; updateMlLinkCount()"
                class="text-xs text-slate-400 hover:text-red-500 transition-colors">✕ Limpar</button>
            </div>
          </div>

          <!-- Barra de progresso (oculta por padrão) -->
          <div id="ml-import-progress" class="hidden mb-3">
            <div class="flex items-center justify-between text-xs text-slate-600 mb-1">
              <span id="ml-progress-label">Processando...</span>
              <span id="ml-progress-pct">0%</span>
            </div>
            <div class="w-full bg-slate-100 rounded-full h-2">
              <div id="ml-progress-bar" class="bg-yellow-400 h-2 rounded-full transition-all" style="width:0%"></div>
            </div>
          </div>

          <!-- Resultado -->
          <div id="ml-import-result" class="hidden"></div>

          <div class="flex gap-3 pt-3 border-t border-slate-100">
            <button id="ml-import-btn" onclick="runMlAffiliateImport('paste')"
              class="flex-1 text-sm font-bold py-2.5 px-4 rounded-xl bg-yellow-400 hover:bg-yellow-500 text-yellow-900 transition-all flex items-center justify-center gap-2">
              ⚡ Importar Agora
            </button>
            <button onclick="closeModal()" class="btn-secondary px-5">Cancelar</button>
          </div>
        </div>

        <!-- Painel: CSV -->
        <div id="panel-csv" class="hidden">
          <div class="border-2 border-dashed border-slate-200 rounded-xl p-6 text-center mb-4 hover:border-yellow-300 transition-colors" id="csv-drop-zone">
            <div class="text-3xl mb-2">📄</div>
            <p class="text-sm font-semibold text-slate-700 mb-1">Arraste um arquivo CSV ou TXT</p>
            <p class="text-xs text-slate-400 mb-3">ou clique para selecionar</p>
            <input type="file" id="csv-file-input" accept=".csv,.txt" class="hidden" onchange="readCsvFile(this)">
            <button onclick="document.getElementById('csv-file-input').click()"
              class="text-xs font-semibold px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 transition-all">
              📂 Selecionar arquivo
            </button>
          </div>
          <div class="bg-slate-50 rounded-xl p-3 mb-4">
            <p class="text-xs font-semibold text-slate-600 mb-1">Formato aceito:</p>
            <code class="text-xs text-slate-500 block">https://meli.la/2fsawYr<br>https://meli.la/19tECKW<br><span class="text-slate-400"># ou separado por vírgula, ponto-e-vírgula ou tab</span></code>
          </div>
          <div id="csv-preview" class="hidden mb-3"></div>
          <div id="ml-import-result-csv" class="hidden"></div>
          <div class="flex gap-3 pt-3 border-t border-slate-100">
            <button id="ml-import-btn-csv" onclick="runMlAffiliateImport('csv')"
              class="flex-1 text-sm font-bold py-2.5 px-4 rounded-xl bg-yellow-400 hover:bg-yellow-500 text-yellow-900 transition-all flex items-center justify-center gap-2">
              ⚡ Importar Arquivo
            </button>
            <button onclick="closeModal()" class="btn-secondary px-5">Cancelar</button>
          </div>
        </div>

        <!-- Painel: Histórico -->
        <div id="panel-history" class="hidden">
          <div id="ml-history-content">
            <div class="text-center py-8 text-slate-400 text-sm">Carregando histórico...</div>
          </div>
        </div>

      </div>
    </div>
  `

  // Listeners
  const ta = document.getElementById('ml-links-textarea')
  if (ta) ta.addEventListener('input', updateMlLinkCount)

  // Drag & drop CSV
  const dz = document.getElementById('csv-drop-zone')
  if (dz) {
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('border-yellow-400','bg-yellow-50') })
    dz.addEventListener('dragleave', () => dz.classList.remove('border-yellow-400','bg-yellow-50'))
    dz.addEventListener('drop', e => {
      e.preventDefault()
      dz.classList.remove('border-yellow-400','bg-yellow-50')
      const file = e.dataTransfer?.files?.[0]
      if (file) readCsvFile({ files: [file] })
    })
  }
}

function mlImportTab(tab) {
  // Atualiza tabs
  ;['paste','csv','history'].forEach(t => {
    const btn = document.getElementById('tab-' + t)
    const panel = document.getElementById('panel-' + t)
    if (!btn || !panel) return
    if (t === tab) {
      btn.className = 'flex-1 text-xs font-semibold py-2 rounded-lg bg-white shadow-sm text-slate-700 transition-all'
      panel.classList.remove('hidden')
    } else {
      btn.className = 'flex-1 text-xs font-semibold py-2 rounded-lg text-slate-500 hover:text-slate-700 transition-all'
      panel.classList.add('hidden')
    }
  })
  // Carrega histórico ao abrir a aba
  if (tab === 'history') loadMlImportHistory()
}

function updateMlLinkCount() {
  const ta = document.getElementById('ml-links-textarea')
  const el = document.getElementById('ml-link-count')
  if (!ta || !el) return
  const matches = ta.value.match(/https?:\/\/[^\s,;"'<>\n\r]+/g) || []
  const unique = new Set(matches.map(u => u.replace(/[.,;]+$/, '').trim()))
  const n = unique.size
  el.textContent = n === 0 ? '0 links detectados'
    : n === 1 ? '1 link detectado'
    : `${n} links detectados`
  el.className = 'text-xs ' + (n > 0 ? 'text-green-600 font-semibold' : 'text-slate-400')
}

// Lê CSV/TXT e joga no textarea de colar
function readCsvFile(input) {
  const file = input.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = e => {
    const text = e.target?.result || ''
    const urls = (text.match(/https?:\/\/[^\s,;"'<>\n\r]+/g) || [])
      .map(u => u.replace(/[.,;]+$/, '').trim())
      .filter(Boolean)
    const unique = [...new Set(urls)]

    // Mostra preview
    const preview = document.getElementById('csv-preview')
    if (preview) {
      preview.classList.remove('hidden')
      preview.innerHTML = `
        <div class="bg-green-50 border border-green-200 rounded-xl p-3">
          <p class="text-xs font-semibold text-green-700">✅ ${unique.length} links encontrados em "${file.name}"</p>
          <p class="text-xs text-green-600 mt-0.5">Pronto para importar!</p>
        </div>`
    }

    // Guarda no dataset para uso no import
    const btn = document.getElementById('ml-import-btn-csv')
    if (btn) btn.dataset.links = unique.join('\n')
  }
  reader.readAsText(file)
}

async function runMlAffiliateImport(source) {
  const iscsv = source === 'csv'
  const btnId = iscsv ? 'ml-import-btn-csv' : 'ml-import-btn'
  const resultId = iscsv ? 'ml-import-result-csv' : 'ml-import-result'
  const btn = document.getElementById(btnId)
  const resultEl = document.getElementById(resultId)

  // Pega os links
  let raw = ''
  if (iscsv) {
    raw = btn?.dataset?.links || ''
  } else {
    raw = document.getElementById('ml-links-textarea')?.value || ''
  }

  if (!raw.trim()) {
    toast('Cole ou carregue pelo menos um link!', 'error')
    return
  }

  // Desabilita botão e mostra progresso
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Processando...' }
  if (!iscsv) {
    const prog = document.getElementById('ml-import-progress')
    if (prog) prog.classList.remove('hidden')
    const bar = document.getElementById('ml-progress-bar')
    const pct = document.getElementById('ml-progress-pct')
    const lbl = document.getElementById('ml-progress-label')
    // Animação de progresso
    let p = 0
    const interval = setInterval(() => {
      p = Math.min(p + Math.random() * 15, 85)
      if (bar) bar.style.width = p + '%'
      if (pct) pct.textContent = Math.round(p) + '%'
      if (lbl) lbl.textContent = p < 40 ? 'Resolvendo links curtos...' : p < 70 ? 'Extraindo IDs do Mercado Livre...' : 'Salvando no banco de dados...'
    }, 400)

    const data = await api('POST', '/admin/api/stores/ml/import-affiliate-links', { links: raw })

    clearInterval(interval)
    if (bar) bar.style.width = '100%'
    if (pct) pct.textContent = '100%'
    if (lbl) lbl.textContent = 'Concluído!'

    renderMlImportResult(data, resultEl)
  } else {
    const data = await api('POST', '/admin/api/stores/ml/import-affiliate-links', { links: raw })
    renderMlImportResult(data, resultEl)
  }

  if (btn) { btn.disabled = false; btn.textContent = '⚡ Importar Novamente' }
}

function renderMlImportResult(data, container) {
  if (!container) return
  container.classList.remove('hidden')

  if (!data || data.error) {
    container.innerHTML = `
      <div class="bg-red-50 border border-red-200 rounded-xl p-4 mb-3">
        <p class="text-sm font-semibold text-red-700">❌ Erro: ${data?.error || 'Falha na requisição'}</p>
      </div>`
    return
  }

  const { total, matched, saved, errors, results } = data

  // Cards de resumo
  container.innerHTML = `
    <div class="grid grid-cols-4 gap-2 mb-4">
      <div class="bg-blue-50 rounded-xl p-2.5 text-center">
        <div class="text-xl font-black text-blue-700">${total}</div>
        <div class="text-xs text-blue-500 font-medium">Total</div>
      </div>
      <div class="bg-green-50 rounded-xl p-2.5 text-center">
        <div class="text-xl font-black text-green-700">${saved}</div>
        <div class="text-xs text-green-500 font-medium">Salvos</div>
      </div>
      <div class="bg-amber-50 rounded-xl p-2.5 text-center">
        <div class="text-xl font-black text-amber-700">${matched}</div>
        <div class="text-xs text-amber-500 font-medium">Vinculados</div>
      </div>
      <div class="bg-red-50 rounded-xl p-2.5 text-center">
        <div class="text-xl font-black text-red-700">${errors}</div>
        <div class="text-xs text-red-500 font-medium">Erros</div>
      </div>
    </div>

    <div class="border border-slate-100 rounded-xl overflow-hidden">
      <div class="bg-slate-50 px-3 py-2 flex items-center justify-between">
        <span class="text-xs font-semibold text-slate-600">Resultado por link</span>
        <span class="text-xs text-slate-400">${results?.length || 0} processados</span>
      </div>
      <div class="max-h-52 overflow-y-auto divide-y divide-slate-50">
        ${(results || []).map(r => {
          const icon = r.status === 'matched' ? '✅' : r.status === 'resolved' ? '🔗' : '❌'
          const bg   = r.status === 'matched' ? 'bg-green-50' : r.status === 'resolved' ? 'bg-blue-50' : 'bg-red-50'
          const label = r.status === 'matched'
            ? `<span class="text-green-700 font-semibold text-xs truncate max-w-[160px] block">${r.product_name || r.ml_item_id}</span>`
            : r.status === 'resolved'
            ? `<span class="text-blue-700 text-xs">${r.ml_item_id} — sem produto no banco</span>`
            : `<span class="text-red-600 text-xs">${r.error}</span>`
          const shortUrl = (r.url || '').replace('https://', '').substring(0, 28)
          return `<div class="flex items-center gap-2.5 px-3 py-2 ${bg}">
            <span class="text-sm flex-shrink-0">${icon}</span>
            <div class="min-w-0 flex-1">
              <div class="text-xs text-slate-500 font-mono truncate">${shortUrl}</div>
              ${label}
            </div>
          </div>`
        }).join('')}
      </div>
    </div>
  `

  if (saved > 0) toast(`✅ ${saved} link(s) de afiliado salvos com sucesso!`, 'success')
  else if (matched === 0 && errors === 0) toast('Links resolvidos! Nenhum produto vinculado ainda.', 'info')
}

async function loadMlImportHistory() {
  const container = document.getElementById('ml-history-content')
  if (!container) return

  const data = await api('GET', '/admin/api/stores/ml/import-history')
  const rows = data?.results || []

  if (rows.length === 0) {
    container.innerHTML = '<div class="text-center py-10 text-slate-400 text-sm">Nenhuma importação ainda</div>'
    return
  }

  container.innerHTML = `
    <div class="border border-slate-100 rounded-xl overflow-hidden">
      <div class="bg-slate-50 px-3 py-2 flex items-center justify-between">
        <span class="text-xs font-semibold text-slate-600">Últimas importações</span>
        <span class="text-xs text-slate-400">${rows.length} registros</span>
      </div>
      <div class="max-h-80 overflow-y-auto divide-y divide-slate-50">
        ${rows.map(r => {
          const icon = r.status === 'matched' ? '✅' : r.status === 'resolved' ? '🔗' : '❌'
          const bg   = r.status === 'matched' ? '' : r.status === 'resolved' ? 'bg-blue-50/40' : 'bg-red-50/40'
          const date = r.imported_at ? new Date(r.imported_at).toLocaleString('pt-BR', { dateStyle:'short', timeStyle:'short' }) : '—'
          const shortUrl = (r.original_url || '').replace('https://','').substring(0, 30)
          return `<div class="flex items-center gap-2.5 px-3 py-2 ${bg}">
            <span class="text-sm flex-shrink-0">${icon}</span>
            <div class="min-w-0 flex-1">
              <div class="text-xs font-mono text-slate-500 truncate">${shortUrl}</div>
              <div class="text-xs text-slate-400">${r.ml_item_id || r.error_msg || '—'} ${r.product_name ? '· ' + r.product_name : ''}</div>
            </div>
            <div class="text-xs text-slate-300 flex-shrink-0">${date}</div>
          </div>`
        }).join('')}
      </div>
    </div>
  `
}

async function renderStores(area) {
  const data = await api('GET', '/admin/api/stores')
  if (!data) return

  const total      = data.length
  const active     = data.filter(s => s.is_active).length
  const withOffers = data.filter(s => s.offer_count > 0).length
  const allCards   = data.map(_buildStoreCard).join('')

  area.innerHTML = `
    <div class="section">
      <div class="grid grid-cols-3 gap-4 mb-6">
        <div class="stat-card text-center border-t-4 border-blue-400">
          <div class="text-3xl font-black text-slate-800">${total}</div>
          <div class="text-sm text-slate-500 mt-1">Lojas cadastradas</div>
        </div>
        <div class="stat-card text-center border-t-4 border-green-400">
          <div class="text-3xl font-black text-green-700">${active}</div>
          <div class="text-sm text-slate-500 mt-1">Lojas ativas</div>
        </div>
        <div class="stat-card text-center border-t-4 border-amber-400">
          <div class="text-3xl font-black text-amber-700">${withOffers}</div>
          <div class="text-sm text-slate-500 mt-1">Com produtos</div>
        </div>
      </div>
      <div class="flex gap-3 mb-5">
        <div class="relative flex-1">
          <span class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">🔍</span>
          <input type="text" id="stores-search" placeholder="Buscar loja..."
            class="input pl-9 w-full" oninput="filterStores(this.value)">
        </div>
        <select id="stores-filter" class="input w-44" onchange="filterStores(document.getElementById('stores-search').value)">
          <option value="">Todas as redes</option>
          <option value="amazon-pa-api">Amazon PA-API</option>
          <option value="meli-api">Mercado Livre</option>
          <option value="magalu-api">Magalu API</option>
          <option value="shopee-api">Shopee</option>
          <option value="aliexpress-portals">AliExpress</option>
          <option value="lomadee">SocialSoul/Lomadee</option>
          <option value="hotmart-api">Hotmart</option>
          <option value="eduzz-api">Eduzz</option>
          <option value="tiktok-shop">TikTok Shop</option>
          <option value="kwai-shop">Kwai Shop</option>
          <option value="instagram-shop">Instagram</option>
          <option value="youtube-shop">YouTube</option>
          <option value="facebook-shop">Facebook</option>
          <option value="ltk-api">LTK</option>
          <option value="impact-api">Impact.com</option>
          <option value="twitch-api">Twitch</option>
          <option value="pinterest-api">Pinterest</option>
          <option value="woocommerce-api">WooCommerce</option>
          <option value="shopify-store-api">Shopify Store</option>
        </select>
        <button onclick="renderStores(document.getElementById('content-area'))"
          class="btn-secondary flex items-center gap-2 whitespace-nowrap">↻ Atualizar</button>
      </div>
      <div id="stores-grid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        ${allCards}
      </div>
    </div>
  `
}

function filterStores(q) {
  const filter = document.getElementById('stores-filter')?.value || ''
  const term = (q || '').toLowerCase().trim()
  document.querySelectorAll('#stores-grid > div').forEach(card => {
    const name    = (card.querySelector('.font-bold')?.textContent || '').toLowerCase()
    const network = (card.querySelector('.text-xs.font-medium')?.textContent || '').toLowerCase()
    const matchQ  = !term   || name.includes(term) || network.includes(term)
    const matchF  = !filter || card.innerHTML.includes(filter)
    card.style.display = (matchQ && matchF) ? '' : 'none'
  })
}

async function toggleStore(id, active) {
  await api('PATCH', `/admin/api/stores/${id}/toggle`, { active })
  toast(active ? 'Loja ativada ✓' : 'Loja desativada', active ? 'success' : 'info')
}

async function openStoreModal(id) {
  // Busca dados atuais da loja antes de abrir o modal
  const all = await api('GET', '/admin/api/stores')
  const s = (all || []).find(x => x.id === id) || {}
  const modal = document.getElementById('modal-container')

  const networkOptions = [
    ['','— nenhuma —'],
    ['amazon-pa-api','Amazon PA-API'],
    ['meli-api','Mercado Livre'],
    ['magalu-api','Magalu API'],
    ['shopee-api','Shopee'],
    ['aliexpress-portals','AliExpress Portals'],
    ['lomadee','SocialSoul/Lomadee'],
    ['hotmart-api','Hotmart'],
    ['eduzz-api','Eduzz'],
    ['monetizze-api','Monetizze'],
    ['rakuten','Rakuten'],
    ['shein-api','Shein'],
    ['dafiti-api','Dafiti'],
    ['tiktok-shop','TikTok Shop'],
    ['kwai-shop','Kwai Shop'],
    ['instagram-shop','Instagram Shopping'],
    ['youtube-shop','YouTube Shopping'],
    ['facebook-shop','Facebook Shops'],
    ['manual','Manual'],
    ['csv','CSV / Genérico'],
  ].map(([v,l]) => `<option value="${v}" ${s.affiliate_network === v ? 'selected' : ''}>${l}</option>`).join('')

  modal.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this) closeModal()">
      <div class="modal max-w-lg">

        <!-- Header -->
        <div class="flex items-center gap-3 mb-5">
          <div id="sm-logo-preview"
            class="w-16 h-16 rounded-2xl border-2 border-slate-100 bg-slate-50 flex items-center justify-center overflow-hidden shadow-sm flex-shrink-0">
            ${s.logo_url
              ? `<img src="${s.logo_url}" class="w-full h-full object-contain p-1" onerror="this.parentElement.innerHTML='<span class=\\'text-2xl\\'>🏪</span>'">`
              : `<span class="text-2xl">🏪</span>`}
          </div>
          <div>
            <h3 class="font-bold text-slate-800 text-lg leading-tight">✏️ ${s.name || 'Editar loja'}</h3>
            <p class="text-xs text-slate-400 mt-0.5">ID #${id} · ${s.offer_count || 0} ofertas cadastradas</p>
          </div>
        </div>

        <div class="space-y-4">

          <!-- ── LOGO ─────────────────────────────────── -->
          <div class="bg-slate-50 rounded-2xl p-4 border border-slate-100">
            <p class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Logo da loja</p>

            <!-- Zona de upload (drag & drop visual) -->
            <label for="sm-logo-file"
              class="flex flex-col items-center justify-center gap-2 w-full h-24 rounded-xl border-2 border-dashed border-slate-200 bg-white cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-all group">
              <span class="text-2xl group-hover:scale-110 transition-transform">📁</span>
              <span class="text-xs font-medium text-slate-500 group-hover:text-blue-600">
                Clique para escolher imagem <span class="text-slate-400">(PNG, JPG, SVG, WebP — máx 500 KB)</span>
              </span>
              <input type="file" id="sm-logo-file" accept="image/*" class="hidden"
                onchange="storeLogoFileChanged(this)">
            </label>

            <!-- Separador -->
            <div class="flex items-center gap-2 my-3">
              <div class="flex-1 h-px bg-slate-200"></div>
              <span class="text-xs text-slate-400 font-medium">ou cole uma URL</span>
              <div class="flex-1 h-px bg-slate-200"></div>
            </div>

            <!-- URL manual -->
            <div class="flex gap-2">
              <input type="url" id="store-logo-url"
                class="input flex-1 text-sm"
                placeholder="https://logo.clearbit.com/mercadolivre.com.br"
                value="${s.logo_url || ''}"
                oninput="storeLogoUrlChanged(this.value)">
              <button onclick="storeLogoUrlChanged(document.getElementById('store-logo-url').value)"
                class="btn-secondary text-xs px-3 flex-shrink-0">
                👁 Preview
              </button>
            </div>

            <!-- Dica Clearbit -->
            <p class="text-xs text-slate-400 mt-2">
              💡 Dica: <code class="bg-slate-100 px-1 rounded">https://logo.clearbit.com/<strong>dominio.com.br</strong></code> funciona para a maioria das lojas
            </p>
          </div>

          <!-- ── CONFIGURAÇÕES ──────────────────────── -->
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Rede de afiliados</label>
              <select id="store-network" class="input text-sm">${networkOptions}</select>
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Comissão (%)</label>
              <input type="number" id="store-commission" class="input text-sm"
                placeholder="5.0" step="0.1" min="0" max="100"
                value="${s.commission_rate || ''}">
            </div>
          </div>

          <div>
            <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Padrão de checkout</label>
            <input type="text" id="store-checkout" class="input text-sm"
              placeholder="https://loja.com/produto/{ID}"
              value="${s.checkout_pattern || ''}">
          </div>

        </div>

        <div class="flex gap-3 mt-5 pt-4 border-t border-slate-100">
          <button onclick="saveStore(${id})" class="btn-primary flex-1">💾 Salvar alterações</button>
          <button onclick="closeModal()" class="btn-secondary">Cancelar</button>
        </div>
      </div>
    </div>
  `
}

// ── Converte arquivo local em base64 e atualiza preview ──
function storeLogoFileChanged(input) {
  const file = input.files?.[0]
  if (!file) return

  // Valida tamanho (500 KB)
  if (file.size > 512 * 1024) {
    toast('Imagem muito grande. Máximo 500 KB.', 'error')
    input.value = ''
    return
  }

  const reader = new FileReader()
  reader.onload = (e) => {
    const dataUrl = e.target.result
    // Atualiza campo URL com o base64
    const urlInput = document.getElementById('store-logo-url')
    if (urlInput) urlInput.value = dataUrl
    // Atualiza preview
    _updateLogoPreview(dataUrl)
  }
  reader.readAsDataURL(file)
}

// ── Atualiza preview ao digitar URL ─────────────────────
function storeLogoUrlChanged(url) {
  if (!url) return
  const urlInput = document.getElementById('store-logo-url')
  if (urlInput) urlInput.value = url
  _updateLogoPreview(url)
}

function _updateLogoPreview(src) {
  const preview = document.getElementById('sm-logo-preview')
  if (!preview) return
  preview.innerHTML = `<img src="${src}"
    class="w-full h-full object-contain p-1"
    onerror="this.parentElement.innerHTML='<span class=\\'text-red-400 text-xs text-center px-1\\'>Imagem inválida</span>'">`
}

async function saveStore(id) {
  const logoUrl = document.getElementById('store-logo-url')?.value.trim() || undefined
  const body = {
    logo_url:          logoUrl,
    affiliate_network: document.getElementById('store-network')?.value || undefined,
    checkout_pattern:  document.getElementById('store-checkout')?.value.trim() || undefined,
    commission_rate:   parseFloat(document.getElementById('store-commission')?.value) || undefined,
  }
  Object.keys(body).forEach(k => (body[k] === undefined || body[k] === '') && delete body[k])

  const btn = document.querySelector('#modal-container .btn-primary')
  if (btn) { btn.disabled = true; btn.textContent = 'Salvando...' }

  await api('PATCH', `/admin/api/stores/${id}`, body)
  toast('Loja atualizada ✓', 'success')
  closeModal()
  renderStores(document.getElementById('content-area'))
}


// ── API CONFIGS ───────────────────────────────────────────
// Catálogo estático de todas as redes suportadas
const AFFILIATE_NETWORKS = [
  // ── Marketplaces ──────────────────────────────────────
  {
    id: 'amazon',
    name: 'Amazon Associados',
    group: 'Marketplaces',
    icon: '🟠',
    color: '#FF9900',
    bg: '#fff8ee',
    border: '#FF9900',
    desc: 'Amazon PA-API v5 — produtos, preços, imagens e links de afiliado',
    fields: ['api_key:API Key (Access Key ID)', 'client_secret:Secret Access Key', 'partner_tag:Associate Tag (ex: seusite-20)', 'client_id:Tracking ID'],
    docsUrl: 'https://webservices.amazon.com.br/paapi5/documentation/',
    commission: '1–10%',
    network: 'amazon-pa-api',
  },
  {
    id: 'mercadolivre',
    name: 'Mercado Livre Afiliados',
    group: 'Marketplaces',
    icon: '🟡',
    color: '#FFE600',
    bg: '#fffde6',
    border: '#e6c800',
    desc: 'MELI Affiliates — feed de produtos e deep links rastreados',
    fields: ['client_id:App ID', 'client_secret:Client Secret', 'partner_tag:Affiliate ID', 'api_key:Access Token'],
    docsUrl: 'https://developers.mercadolivre.com.br/',
    commission: '2–15%',
    network: 'meli-api',
  },
  {
    id: 'magalu',
    name: 'Magalu Parceiro',
    group: 'Marketplaces',
    icon: '🔵',
    color: '#0086FF',
    bg: '#eef5ff',
    border: '#0086FF',
    desc: 'Magazine Luiza — feed XML/CSV + API de produtos e rastreamento',
    fields: ['api_key:API Key', 'client_id:Client ID', 'client_secret:Client Secret', 'partner_tag:Publisher ID'],
    docsUrl: 'https://parceiro.magazineluiza.com.br/',
    commission: '2–12%',
    network: 'magalu-api',
  },
  {
    id: 'shopee',
    name: 'Shopee Afiliados',
    group: 'Marketplaces',
    icon: '🟠',
    color: '#EE4D2D',
    bg: '#fff3f0',
    border: '#EE4D2D',
    desc: 'Shopee Affiliate — API de produtos, deep links e rastreamento',
    fields: ['api_key:API Key', 'client_id:App ID', 'client_secret:App Secret', 'partner_tag:Sub ID'],
    docsUrl: 'https://open.shopee.com/documents',
    commission: '1–12%',
    network: 'shopee-api',
  },
  {
    id: 'shein',
    name: 'Shein Afiliados',
    group: 'Marketplaces',
    icon: '🖤',
    color: '#000000',
    bg: '#f5f5f5',
    border: '#444444',
    desc: 'Shein Affiliate Program — feed de produtos de moda e links de afiliado',
    fields: ['api_key:API Key', 'partner_tag:Affiliate ID', 'client_id:Publisher ID'],
    docsUrl: 'https://affiliate.shein.com/',
    commission: '10–20%',
    network: 'shein-api',
  },
  {
    id: 'aliexpress',
    name: 'AliExpress Portals',
    group: 'Marketplaces',
    icon: '🔴',
    color: '#FF4747',
    bg: '#fff0f0',
    border: '#FF4747',
    desc: 'AliExpress Affiliate — Portals API para produtos, hotlinks e comissões',
    fields: ['api_key:App Key', 'client_secret:App Secret', 'partner_tag:Tracking ID', 'client_id:Publisher SiteID'],
    docsUrl: 'https://portals.aliexpress.com/',
    commission: '3–9%',
    network: 'aliexpress-portals',
  },
  {
    id: 'dafiti',
    name: 'Dafiti Afiliados',
    group: 'Marketplaces',
    icon: '👟',
    color: '#2C2C2C',
    bg: '#f8f8f8',
    border: '#555555',
    desc: 'Dafiti — moda, calçados e acessórios. Feed de produtos',
    fields: ['api_key:API Token', 'partner_tag:Publisher ID', 'client_id:Site ID'],
    docsUrl: 'https://www.dafiti.com.br/afiliados/',
    commission: '5–10%',
    network: 'dafiti-api',
  },
  // ── Infoprodutos ──────────────────────────────────────
  {
    id: 'hotmart',
    name: 'Hotmart',
    group: 'Infoprodutos',
    icon: '🔥',
    color: '#FF5722',
    bg: '#fff3f0',
    border: '#FF5722',
    desc: 'Hotmart Club — cursos, e-books e infoprodutos digitais brasileiros',
    fields: ['client_id:Client ID', 'client_secret:Client Secret', 'api_key:Basic Token', 'partner_tag:HotLink ID'],
    docsUrl: 'https://developers.hotmart.com/',
    commission: '20–80%',
    network: 'hotmart-api',
  },
  {
    id: 'eduzz',
    name: 'Eduzz',
    group: 'Infoprodutos',
    icon: '🟣',
    color: '#7C3AED',
    bg: '#f5f3ff',
    border: '#7C3AED',
    desc: 'Eduzz — marketplace de infoprodutos, cursos e assinaturas',
    fields: ['api_key:API Key', 'client_id:Publisher ID', 'partner_tag:Affiliate Token'],
    docsUrl: 'https://api.eduzz.com/',
    commission: '20–80%',
    network: 'eduzz-api',
  },
  {
    id: 'monetizze',
    name: 'Monetizze',
    group: 'Infoprodutos',
    icon: '💚',
    color: '#00B359',
    bg: '#f0fdf4',
    border: '#00B359',
    desc: 'Monetizze — infoprodutos físicos e digitais com rastreamento avançado',
    fields: ['api_key:API Key', 'client_id:Publisher ID', 'partner_tag:Affiliate Slug'],
    docsUrl: 'https://app.monetizze.com.br/afiliados',
    commission: '20–70%',
    network: 'monetizze-api',
  },
  {
    id: 'braip',
    name: 'Braip',
    group: 'Infoprodutos',
    icon: '🔷',
    color: '#1565C0',
    bg: '#e8f0fe',
    border: '#1565C0',
    desc: 'Braip — plataforma de vendas de produtos físicos e digitais afiliados',
    fields: ['api_key:API Key', 'partner_tag:Affiliate ID', 'client_id:Account ID'],
    docsUrl: 'https://braip.com/afiliados',
    commission: '20–60%',
    network: 'braip-api',
  },
  // ── Redes Multimarcas ─────────────────────────────────
  {
    id: 'socialsoul',
    name: 'SocialSoul / Lomadee',
    group: 'Redes Multimarcas',
    icon: '🌐',
    color: '#6366F1',
    bg: '#f0f0ff',
    border: '#6366F1',
    desc: 'SocialSoul (ex-Lomadee) — rede multimarcas B2W, C&A, Renner e mais',
    fields: ['api_key:Token de Acesso', 'client_id:Source ID', 'partner_tag:Publisher ID'],
    docsUrl: 'https://developer.socialsoul.com.br/',
    commission: '2–15%',
    network: 'lomadee',
  },
  {
    id: 'rakuten',
    name: 'Rakuten Advertising',
    group: 'Redes Multimarcas',
    icon: '🔴',
    color: '#BF0000',
    bg: '#fff0f0',
    border: '#BF0000',
    desc: 'Rakuten — rede de performance marketing com grandes marcas globais',
    fields: ['api_key:Security Token', 'client_id:Publisher ID', 'client_secret:API Secret', 'partner_tag:Site ID'],
    docsUrl: 'https://developers.rakutenadvertising.com/',
    commission: '1–15%',
    network: 'rakuten',
  },
  // ── Tecnologia & SaaS ─────────────────────────────────
  {
    id: 'hostinger',
    name: 'Hostinger',
    group: 'Tecnologia & SaaS',
    icon: '🟣',
    color: '#673DE6',
    bg: '#f5f0ff',
    border: '#673DE6',
    desc: 'Hostinger Affiliate — hospedagem, domínios e ferramentas web',
    fields: ['api_key:API Token', 'partner_tag:Referral Code', 'client_id:Account ID'],
    docsUrl: 'https://www.hostinger.com.br/afiliados',
    commission: '40–60%',
    network: 'hostinger-api',
  },
  {
    id: 'shopify',
    name: 'Shopify Partners',
    group: 'Tecnologia & SaaS',
    icon: '🟢',
    color: '#96BF48',
    bg: '#f0f7ea',
    border: '#96BF48',
    desc: 'Shopify Affiliate — indicação de lojas e soluções de e-commerce',
    fields: ['api_key:API Key', 'client_id:Partner ID', 'client_secret:API Secret Key', 'partner_tag:Referral Tag'],
    docsUrl: 'https://www.shopify.com/partners',
    commission: '20% recorrente',
    network: 'shopify-partners',
  },
  {
    id: 'nuvemshop',
    name: 'Nuvemshop / Tiendanube',
    group: 'Tecnologia & SaaS',
    icon: '☁️',
    color: '#0070F3',
    bg: '#e6f0ff',
    border: '#0070F3',
    desc: 'Nuvemshop Afiliados — indicação de plataforma de e-commerce para PMEs',
    fields: ['api_key:Token de Afiliado', 'partner_tag:Publisher ID', 'client_id:Campaign ID'],
    docsUrl: 'https://www.nuvemshop.com.br/afiliados',
    commission: '20–30%',
    network: 'nuvemshop-api',
  },
  // ── Outros / CPG ──────────────────────────────────────
  {
    id: 'nestle',
    name: 'Nestlé',
    group: 'Outros',
    icon: '🍫',
    color: '#C8102E',
    bg: '#fff0f2',
    border: '#C8102E',
    desc: 'Nestlé — programa de afiliados para produtos alimentícios e parceiros',
    fields: ['api_key:API Key', 'partner_tag:Publisher ID', 'client_id:Account ID'],
    docsUrl: 'https://www.nestle.com.br/',
    commission: 'Sob consulta',
    network: 'nestle-api',
  },
  // ── Plataformas de Parceria ──────────────────────────
  {
    id: 'ltk',
    name: 'LTK (LikeToKnow.it)',
    group: 'Plataformas de Parceria',
    icon: '💗',
    color: '#FF385C',
    bg: '#fff0f3',
    border: '#FF385C',
    desc: 'LTK Creator API — vitrine de influenciadores de moda, beleza e decoração. Cada item é um link de afiliado rastreável. Padrão ouro para conteúdo estético.',
    fields: [
      'api_key:API Key (LTK Partner Portal)',
      'client_id:Publisher ID',
      'client_secret:Client Secret',
      'partner_tag:Creator Profile ID',
    ],
    docsUrl: 'https://www.ltk.com/partner',
    commission: '5–20%',
    network: 'ltk-api',
    authType: 'OAuth2',
    scopes: ['profile.read', 'products.read', 'links.create', 'analytics.read'],
    baseUrl: 'https://api.liketoknow.it/v2',
    webhookSupport: true,
    integrations: ['Instagram', 'TikTok', 'YouTube'],
    notes: 'Ecossistema fechado mas integrado ao Instagram/TikTok. Ideal para influenciadores de lifestyle. Requer aprovação editorial.',
  },
  {
    id: 'impact',
    name: 'Impact.com',
    group: 'Plataformas de Parceria',
    icon: '⚡',
    color: '#FF6B35',
    bg: '#fff4f0',
    border: '#FF6B35',
    desc: 'Impact Partnership Cloud API — automação completa de parcerias. Apple, Canva, Uber e centenas de marcas usam Impact para gerenciar afiliados.',
    fields: [
      'api_key:Account SID (Impact Dashboard)',
      'client_secret:Auth Token',
      'client_id:Program ID',
      'partner_tag:Media Partner ID',
    ],
    docsUrl: 'https://developer.impact.com/',
    commission: '2–30% (varia por marca)',
    network: 'impact-api',
    authType: 'Basic Auth (SID + Token)',
    scopes: ['Ads', 'Conversions', 'Reports', 'Catalogs', 'Coupons'],
    baseUrl: 'https://api.impact.com/Mediapartners',
    webhookSupport: true,
    brands: ['Apple', 'Canva', 'Uber', 'Airbnb', 'Nike', 'Sephora'],
    notes: 'A API mais completa do mercado para gestão de múltiplas marcas. Ideal para quem quer um painel único com centenas de anunciantes.',
  },
  // ── Live Commerce ─────────────────────────────────────
  {
    id: 'twitch',
    name: 'Twitch + Amazon Afiliados',
    group: 'Live Commerce',
    icon: '🎮',
    color: '#9146FF',
    bg: '#f5f0ff',
    border: '#9146FF',
    desc: 'Twitch Extensions API + Amazon Associates — overlays interativos em lives. Espectador clica e compra sem fechar a transmissão. Referência para público gamer e tech.',
    fields: [
      'api_key:Amazon Access Key (PA-API)',
      'client_id:Twitch Client ID (dev.twitch.tv)',
      'client_secret:Twitch Client Secret',
      'partner_tag:Amazon Associate Tag',
    ],
    docsUrl: 'https://dev.twitch.tv/docs/extensions/',
    commission: '1–10% (Amazon) + bits Twitch',
    network: 'twitch-api',
    authType: 'OAuth2 (Twitch) + AWS Signature (Amazon)',
    scopes: ['channel:read:subscriptions', 'bits:read', 'channel:manage:extensions'],
    baseUrl: 'https://api.twitch.tv/helix',
    webhookSupport: true,
    notes: 'Integração dupla: Twitch Extensions para overlays interativos + Amazon PA-API para produtos. Ideal para streamers que vendem produtos tech/gamer durante lives.',
  },
  // ── Discovery Commerce ────────────────────────────────
  {
    id: 'pinterest',
    name: 'Pinterest Shopping API v5',
    group: 'Discovery Commerce',
    icon: '📌',
    color: '#E60023',
    bg: '#fff0f0',
    border: '#E60023',
    desc: 'Pinterest API v5 — catálogos dinâmicos, Pins automatizados e API de Conversões. Ideal para moda, decoração e DIY. Automação de novos produtos como Pins.',
    fields: [
      'api_key:Access Token (Pinterest Developers)',
      'client_id:App ID',
      'client_secret:App Secret',
      'partner_tag:Ad Account ID',
    ],
    docsUrl: 'https://developers.pinterest.com/docs/api/v5/',
    commission: '3–10%',
    network: 'pinterest-api',
    authType: 'OAuth2',
    scopes: ['boards:read', 'boards:write', 'pins:read', 'pins:write', 'catalogs:read', 'catalogs:write', 'ads:read'],
    baseUrl: 'https://api.pinterest.com/v5',
    webhookSupport: true,
    notes: 'API v5 focada em Shopping: catálogos dinâmicos automáticos + Conversion API para otimizar anúncios. Criar Pin automaticamente ao adicionar novo produto na base de dados.',
  },
  // ── E-commerce Builder ────────────────────────────────
  {
    id: 'woocommerce',
    name: 'WooCommerce Affiliates',
    group: 'E-commerce Builder',
    icon: '🛍️',
    color: '#7F54B3',
    bg: '#f5f0ff',
    border: '#7F54B3',
    desc: 'WooCommerce REST API + plugins de afiliados (AffiliateWP, YITH) — crie sua própria rede multi-vendor onde outros vendem e ganham comissão automática.',
    fields: [
      'api_key:Consumer Key (WooCommerce → Settings → REST API)',
      'client_secret:Consumer Secret',
      'client_id:Site URL (ex: minhaloja.com)',
      'partner_tag:Affiliate Program Slug',
    ],
    docsUrl: 'https://woocommerce.github.io/woocommerce-rest-api-docs/',
    commission: 'Você define (5–30%)',
    network: 'woocommerce-api',
    authType: 'Basic Auth (Consumer Key/Secret) ou OAuth1',
    scopes: ['products', 'orders', 'customers', 'coupons', 'reports'],
    baseUrl: 'https://seusite.com/wp-json/wc/v3',
    webhookSupport: true,
    plugins: ['AffiliateWP', 'YITH WooCommerce Affiliates', 'SliceWP'],
    notes: 'Você vira o dono da plataforma. Use plugins como AffiliateWP para criar rede própria onde afiliados ganham comissão automática por cada venda.',
  },
  {
    id: 'shopify-store',
    name: 'Shopify Multi-vendor',
    group: 'E-commerce Builder',
    icon: '🏪',
    color: '#5C6AC4',
    bg: '#f0f1ff',
    border: '#5C6AC4',
    desc: 'Shopify Admin API + apps de afiliados (Refersion, Tapfiliate) — loja própria com sistema de comissões para afiliados/vendedores. Alternativa mais profissional ao WooCommerce.',
    fields: [
      'api_key:Admin API Access Token (Shopify Partners)',
      'client_id:API Key',
      'client_secret:API Secret Key',
      'partner_tag:Store Domain (ex: minhaloja.myshopify.com)',
    ],
    docsUrl: 'https://shopify.dev/docs/api/admin-rest',
    commission: 'Você define (5–30%)',
    network: 'shopify-store-api',
    authType: 'OAuth2 + Admin API Token',
    scopes: ['read_products', 'write_products', 'read_orders', 'write_orders', 'read_customers'],
    baseUrl: 'https://{shop}.myshopify.com/admin/api/2024-01',
    webhookSupport: true,
    apps: ['Refersion', 'Tapfiliate', 'Goaffpro', 'UpPromote'],
    notes: 'Solução enterprise para criar sua própria rede de afiliados. Use apps como Refersion para painel completo de gestão de comissões e pagamentos automáticos.',
  },
  // ── Social Commerce ──────────────────────────────────
  {
    id: 'tiktok-shop',
    name: 'TikTok Shop Afiliados',
    group: 'Social Commerce',
    icon: '🎵',
    color: '#000000',
    bg: '#f0f0f5',
    border: '#010101',
    desc: 'TikTok Shop Open API — produtos, lives de vendas, links em vídeos curtos e rastreamento de afiliados',
    fields: [
      'client_id:App ID (TikTok Developers)',
      'client_secret:App Secret',
      'api_key:Access Token',
      'partner_tag:Affiliate ID / Promo Code',
    ],
    docsUrl: 'https://partner.tiktokshop.com/doc/page/developer-guide',
    commission: '5–20%',
    network: 'tiktok-shop',
    authType: 'OAuth2',
    scopes: ['product.readonly', 'order.readonly', 'affiliate.readonly'],
    baseUrl: 'https://open-api.tiktokglobalshop.com',
    webhookSupport: true,
    notes: 'Requer conta Business no TikTok for Developers. Sandbox disponível para testes.',
  },
  {
    id: 'kwai-shop',
    name: 'Kwai Shop Afiliados',
    group: 'Social Commerce',
    icon: '🎬',
    color: '#FF6600',
    bg: '#fff4ee',
    border: '#FF6600',
    desc: 'Kwai for Business — shoppertainment com lives e vídeos curtos. Maior concorrente do TikTok Shop no Brasil.',
    fields: [
      'client_id:App Key (Kwai for Business)',
      'client_secret:App Secret',
      'api_key:Access Token',
      'partner_tag:Publisher ID / Sub ID',
    ],
    docsUrl: 'https://www.kwai-for-business.com/br',
    commission: '5–15%',
    network: 'kwai-shop',
    authType: 'OAuth2',
    scopes: ['shop.products', 'shop.orders', 'affiliate.links'],
    baseUrl: 'https://open.kwai.com/api',
    webhookSupport: true,
    notes: 'Cadastro via Kwai for Business. Ideal para criadores com audiência em vídeos curtos.',
  },
  {
    id: 'instagram-shop',
    name: 'Instagram Shopping',
    group: 'Social Commerce',
    icon: '📸',
    color: '#E1306C',
    bg: '#fff0f5',
    border: '#E1306C',
    desc: 'Meta Graph API — marcar produtos em Reels, Stories e Feed. Figurinha de link para afiliados de marketplaces parceiros.',
    fields: [
      'api_key:Access Token (Meta for Developers)',
      'client_id:App ID',
      'client_secret:App Secret',
      'partner_tag:Instagram Business Account ID',
    ],
    docsUrl: 'https://developers.facebook.com/docs/instagram-api',
    commission: '2–10%',
    network: 'instagram-shop',
    authType: 'OAuth2 (Meta)',
    scopes: ['instagram_basic', 'instagram_shopping_tag_products', 'catalog_management', 'pages_read_engagement'],
    baseUrl: 'https://graph.facebook.com/v18.0',
    webhookSupport: true,
    notes: 'Requer Página do Facebook + conta Instagram Business/Creator. Cadastro em Meta for Developers.',
  },
  {
    id: 'youtube-shop',
    name: 'YouTube Shopping',
    group: 'Social Commerce',
    icon: '▶️',
    color: '#FF0000',
    bg: '#fff0f0',
    border: '#FF0000',
    desc: 'YouTube Data API v3 + Shopping — marcar produtos em Shorts, vídeos e ao vivo. Integração via Google Merchant Center.',
    fields: [
      'api_key:API Key (Google Cloud Console)',
      'client_id:OAuth 2.0 Client ID',
      'client_secret:OAuth 2.0 Client Secret',
      'partner_tag:YouTube Channel ID',
    ],
    docsUrl: 'https://developers.google.com/youtube/v3',
    commission: '3–8%',
    network: 'youtube-shop',
    authType: 'OAuth2 (Google)',
    scopes: ['youtube.readonly', 'youtubepartner', 'yt-analytics.readonly'],
    baseUrl: 'https://www.googleapis.com/youtube/v3',
    webhookSupport: false,
    notes: 'Requer Google Merchant Center vinculado + canal com +10k inscritos para Shopping em Shorts. Programa de afiliados via parceiros globais.',
  },
  {
    id: 'facebook-shop',
    name: 'Facebook Shops / Meta',
    group: 'Social Commerce',
    icon: '👥',
    color: '#1877F2',
    bg: '#eff5ff',
    border: '#1877F2',
    desc: 'Meta Graph API — catálogo de produtos no Facebook Shops, Marketplace e anúncios. Página em Modo Profissional obrigatório.',
    fields: [
      'api_key:Page Access Token (Meta for Developers)',
      'client_id:App ID',
      'client_secret:App Secret',
      'partner_tag:Facebook Page ID',
    ],
    docsUrl: 'https://developers.facebook.com/docs/marketing-api',
    commission: '2–8%',
    network: 'facebook-shop',
    authType: 'OAuth2 (Meta)',
    scopes: ['pages_manage_metadata', 'catalog_management', 'business_management', 'ads_read'],
    baseUrl: 'https://graph.facebook.com/v18.0',
    webhookSupport: true,
    notes: 'Requer Página ou Perfil no Modo Profissional. Conformidade com Políticas de Monetização de Conteúdo da Meta. Cadastro em Meta for Developers.',
  },
]

const AFFILIATE_GROUPS = ['Marketplaces', 'Infoprodutos', 'Redes Multimarcas', 'Plataformas de Parceria', 'Live Commerce', 'Discovery Commerce', 'E-commerce Builder', 'Tecnologia & SaaS', 'Social Commerce', 'Outros']

// ── IA EDITORIAL PANEL ────────────────────────────────────────────────────────
async function renderEditorial(area) {
  area.innerHTML = spin

  // Busca estado atual dos destaques gerados
  const data = await api('GET', '/api/editorial')
  const banners  = data?.banners  || []
  const insights = data?.insights || []
  const lastGen  = data?.last_generated

  const bMain = banners.find(b => b.slot === 'banner_main')
  const bSec1 = banners.find(b => b.slot === 'banner_sec1')
  const bSec2 = banners.find(b => b.slot === 'banner_sec2')

  function fAge(iso) {
    if (!iso) return 'nunca'
    const diff = Date.now() - new Date(iso).getTime()
    const min  = Math.floor(diff / 60000)
    if (min < 1)  return 'agora mesmo'
    if (min < 60) return min + ' min atrás'
    const h = Math.floor(min / 60)
    if (h < 24)   return h + 'h atrás'
    return Math.floor(h / 24) + 'd atrás'
  }

  function bannerPreview(b, size) {
    if (!b) return `<div class="flex-1 rounded-xl border-2 border-dashed border-slate-200 flex items-center justify-center p-4 text-slate-400 text-sm">Sem dados</div>`
    const from  = b.color_from || '#2563EB'
    const to    = b.color_to   || '#7C3AED'
    const lines = (b.title || '').split('\\n')
    return `
      <div class="flex-1 rounded-xl overflow-hidden shadow-md" style="background:linear-gradient(135deg,${from},${to});min-height:${size}px;padding:16px;position:relative;">
        <div style="position:absolute;right:8px;bottom:0;font-size:3rem;opacity:0.2;">${b.emoji||'🛍️'}</div>
        <div style="position:relative;z-index:1;">
          <span style="background:rgba(255,255,255,0.2);color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:99px;display:inline-block;margin-bottom:6px;">${b.label||''}</span>
          <div style="color:white;font-weight:900;font-size:14px;line-height:1.3;">${lines.join('<br>')}</div>
          ${b.subtitle ? `<div style="color:rgba(255,255,255,0.65);font-size:11px;margin-top:4px;">${b.subtitle}</div>` : ''}
          ${b.stat_value ? `<div style="color:rgba(255,255,255,0.5);font-size:10px;margin-top:6px;font-weight:600;">${b.stat_value}</div>` : ''}
        </div>
      </div>
    `
  }

  const statusColor = lastGen
    ? (Date.now() - new Date(lastGen).getTime() < 7 * 3600000 ? 'text-green-600 bg-green-50' : 'text-amber-600 bg-amber-50')
    : 'text-slate-500 bg-slate-100'
  const statusLabel = lastGen ? 'Ativo' : 'Sem dados'

  area.innerHTML = `
    <div class="p-6 space-y-6">

      <!-- Header com status e botão gerar -->
      <div class="bg-gradient-to-r from-slate-900 to-slate-800 rounded-2xl p-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <div class="flex items-center gap-2 mb-1">
            <span class="text-2xl">🤖</span>
            <h2 class="text-white font-black text-xl">IA Editorial</h2>
            <span class="text-xs font-bold px-2 py-0.5 rounded-full ${statusColor}">${statusLabel}</span>
          </div>
          <p class="text-slate-400 text-sm">Motor interno que analisa produtos, ofertas e categorias do D1 e gera os banners da homepage automaticamente.</p>
          <p class="text-slate-500 text-xs mt-1">Última geração: <strong class="text-slate-300">${fAge(lastGen)}</strong> · Próxima: automática em até 6h</p>
        </div>
        <div class="flex gap-3 flex-shrink-0">
          <button onclick="forceGenerateEditorial()"
            class="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-5 py-2.5 rounded-xl transition-all shadow-lg shadow-indigo-900/30">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
            Gerar agora
          </button>
          <button onclick="renderEditorial(document.getElementById('content-area'))"
            class="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 text-white font-bold px-4 py-2.5 rounded-xl transition-all">
            🔄 Atualizar
          </button>
        </div>
      </div>

      <!-- Preview dos banners atuais -->
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-5">
        <div class="flex items-center gap-2 mb-4">
          <div class="w-1 h-6 bg-gradient-to-b from-indigo-500 to-purple-600 rounded-full"></div>
          <h3 class="font-bold text-slate-800">Preview — Banners da homepage agora</h3>
          ${lastGen ? `<span class="text-xs text-slate-400 ml-2">gerado ${fAge(lastGen)}</span>` : ''}
        </div>
        <div class="flex gap-3 flex-col md:flex-row">
          ${bannerPreview(bMain, 160)}
          <div class="flex md:flex-col gap-3 flex-1" style="max-width:38%">
            ${bannerPreview(bSec1, 72)}
            ${bannerPreview(bSec2, 72)}
          </div>
        </div>
        ${!lastGen ? `
          <div class="mt-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-700">
            ⚠️ Nenhum destaque foi gerado ainda. Clique em <strong>Gerar agora</strong> para criar os banners com base nos dados do banco.
          </div>
        ` : ''}
      </div>

      <!-- Insights textuais do ticker -->
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-5">
        <div class="flex items-center justify-between mb-4">
          <div class="flex items-center gap-2">
            <div class="w-1 h-6 bg-gradient-to-b from-green-500 to-emerald-600 rounded-full"></div>
            <h3 class="font-bold text-slate-800">Insights do Ticker</h3>
            <span class="text-xs text-slate-400">(faixa animada abaixo dos banners)</span>
          </div>
        </div>
        ${insights.length > 0
          ? `<div class="space-y-2">${insights.map(ins => `
              <div class="flex items-center gap-3 bg-slate-50 rounded-xl px-4 py-2.5">
                <span class="w-2 h-2 rounded-full bg-green-400 flex-shrink-0"></span>
                <span class="text-sm text-slate-700">${ins.insight_text}</span>
                <span class="ml-auto text-xs text-slate-400">${fAge(ins.generated_at)}</span>
              </div>
            `).join('')}</div>`
          : `<p class="text-slate-400 text-sm">Nenhum insight gerado ainda. Clique em <strong>Gerar agora</strong>.</p>`
        }
      </div>

      <!-- Histórico / dados raw dos slots -->
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-5">
        <div class="flex items-center gap-2 mb-4">
          <div class="w-1 h-6 bg-gradient-to-b from-slate-400 to-slate-600 rounded-full"></div>
          <h3 class="font-bold text-slate-800">Dados gerados por slot</h3>
        </div>
        ${banners.length > 0
          ? `<div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-slate-100">
                    <th class="text-left py-2 px-3 text-xs font-semibold text-slate-500 uppercase">Slot</th>
                    <th class="text-left py-2 px-3 text-xs font-semibold text-slate-500 uppercase">Label</th>
                    <th class="text-left py-2 px-3 text-xs font-semibold text-slate-500 uppercase">Categoria</th>
                    <th class="text-left py-2 px-3 text-xs font-semibold text-slate-500 uppercase">Stat</th>
                    <th class="text-left py-2 px-3 text-xs font-semibold text-slate-500 uppercase">Cor</th>
                    <th class="text-left py-2 px-3 text-xs font-semibold text-slate-500 uppercase">Gerado</th>
                  </tr>
                </thead>
                <tbody>
                  ${banners.map(b => `
                    <tr class="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                      <td class="py-2.5 px-3 font-mono text-xs text-slate-600 font-bold">${b.slot}</td>
                      <td class="py-2.5 px-3 text-slate-700">${b.emoji||''} ${b.label||''}</td>
                      <td class="py-2.5 px-3"><span class="font-mono text-xs bg-slate-100 px-2 py-0.5 rounded">${b.category_slug||'—'}</span></td>
                      <td class="py-2.5 px-3 text-slate-600 text-xs">${b.stat_value||'—'}</td>
                      <td class="py-2.5 px-3">
                        <span class="inline-flex items-center gap-1">
                          <span style="width:14px;height:14px;border-radius:4px;background:linear-gradient(135deg,${b.color_from},${b.color_to});display:inline-block;"></span>
                          <span class="font-mono text-xs text-slate-400">${b.color_from}</span>
                        </span>
                      </td>
                      <td class="py-2.5 px-3 text-xs text-slate-400">${fAge(b.generated_at)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>`
          : `<p class="text-slate-400 text-sm">Sem dados. Clique em <strong>Gerar agora</strong>.</p>`
        }
      </div>

      <!-- Como funciona -->
      <div class="bg-slate-50 rounded-2xl border border-slate-200 p-5">
        <h4 class="font-bold text-slate-700 mb-3">🧠 Como o motor funciona</h4>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm text-slate-600">
          <div class="bg-white rounded-xl p-4 border border-slate-100">
            <div class="text-xl mb-2">📊</div>
            <strong class="text-slate-800">1. Analisa o D1</strong>
            <p class="text-xs mt-1 text-slate-500">Consulta produtos, ofertas e categorias. Calcula scores por volume de ofertas e desconto médio.</p>
          </div>
          <div class="bg-white rounded-xl p-4 border border-slate-100">
            <div class="text-xl mb-2">✍️</div>
            <strong class="text-slate-800">2. Gera conteúdo</strong>
            <p class="text-xs mt-1 text-slate-500">Escolhe a categoria mais quente, monta títulos, subtítulos e insights baseados nos dados reais.</p>
          </div>
          <div class="bg-white rounded-xl p-4 border border-slate-100">
            <div class="text-xl mb-2">🔄</div>
            <strong class="text-slate-800">3. Persiste e serve</strong>
            <p class="text-xs mt-1 text-slate-500">Salva em <code class="bg-slate-100 px-1 rounded">ai_editorial</code> no D1. Homepage lê direto — sem API externa, sem custo extra.</p>
          </div>
        </div>
      </div>

    </div>
  `
}

async function forceGenerateEditorial() {
  const btn = document.querySelector('[onclick="forceGenerateEditorial()"]')
  if (btn) { btn.disabled = true; btn.innerHTML = '<svg class="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg> Gerando...' }
  const res = await api('POST', '/api/editorial/generate')
  if (res?.ok) {
    toast('✓ Destaques gerados! Categorias: ' + (res.data_summary?.categories_analyzed || 0) + ' | Produtos: ' + (res.data_summary?.products_total || 0), 'success')
    await renderEditorial(document.getElementById('content-area'))
  } else {
    toast(res?.message || 'Erro ao gerar destaques', 'error')
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg> Gerar agora' }
  }
}

// ── FOOTER ADMIN PANEL ────────────────────────────────────
async function renderFooterAdmin(area) {
  area.innerHTML = spin

  const data = await api('GET', '/admin/api/footer-config')
  if (!data) return

  const rows = data.rows || []
  const bySection = (s) => rows.filter(r => r.section === s).sort((a, b) => a.sort_order - b.sort_order)

  const brand      = bySection('brand')
  const stores     = bySection('stores')
  const categories = bySection('categories')
  const info       = bySection('info')
  const bottom     = bySection('bottom')

  const bGet = (k) => brand.find(r => r.key === k)?.value || ''

  const noDataWarning = rows.length === 0 ? `
    <div class="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800 flex items-center gap-2 mb-6">
      <span class="text-lg">⚠️</span>
      <span>Tabela <code class="bg-amber-100 px-1 rounded font-mono">footer_config</code> não encontrada ou vazia.
      Execute a migration 0016: <code class="bg-amber-100 px-1 rounded font-mono">npx wrangler d1 migrations apply webapp-production</code></span>
    </div>
  ` : ''

  area.innerHTML = `
    <div class="section">
      ${noDataWarning}

      <!-- Prévia -->
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h3 class="font-bold text-slate-800">🦶 Rodapé do Site</h3>
            <p class="text-xs text-slate-500 mt-0.5">Edite cada seção abaixo. As alterações ficam ativas imediatamente no site.</p>
          </div>
          <a href="/" target="_blank" class="text-xs text-blue-600 hover:underline flex items-center gap-1">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
            Ver site
          </a>
        </div>
        <!-- Prévia visual do footer -->
        <div class="bg-gray-900 text-gray-400 px-5 py-6 text-xs">
          <div class="grid grid-cols-4 gap-6 mb-4">
            <div>
              <div class="text-white font-bold mb-2 text-sm">${bGet('site_name') || 'KainowRadar'}</div>
              <p class="leading-relaxed opacity-70">${(bGet('tagline') || '').slice(0, 60)}${(bGet('tagline') || '').length > 60 ? '…' : ''}</p>
            </div>
            <div>
              <div class="text-white font-semibold mb-2">Categorias</div>
              <div class="space-y-1">
                ${categories.filter(c => c.is_visible).slice(0, 4).map(c => '<div class="opacity-70">' + escHtml(c.key) + '</div>').join('') || '<div class="opacity-70">Smartphones · Notebooks…</div>'}
              </div>
            </div>
            <div>
              <div class="text-white font-semibold mb-2">Lojas Parceiras</div>
              <div class="space-y-1">
                ${stores.filter(s => s.is_visible).slice(0, 4).map(s => `<div class="opacity-70">${s.key}</div>`).join('') || '<div class="opacity-70">Amazon · Magalu…</div>'}
              </div>
            </div>
            <div>
              <div class="text-white font-semibold mb-2">Informações</div>
              <div class="space-y-1">
                ${info.filter(i => i.is_visible).slice(0, 4).map(i => `<div class="opacity-70">${i.key}</div>`).join('') || '<div class="opacity-70">Sobre · Privacidade…</div>'}
              </div>
            </div>
          </div>
          <div class="border-t border-gray-700 pt-3 text-gray-600 text-center text-xs truncate">
            ${(bottom.find(b => b.key === 'disclaimer')?.value || '').slice(0, 80)}…
          </div>
        </div>
      </div>

      <!-- ═══ SEÇÃO: MARCA ═══ -->
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div class="px-5 py-4 border-b border-slate-100 bg-gradient-to-r from-blue-50 to-white">
          <h3 class="font-bold text-slate-800 flex items-center gap-2">
            <span class="w-7 h-7 bg-blue-100 text-blue-600 rounded-lg flex items-center justify-center text-sm">🏷️</span>
            Marca
          </h3>
          <p class="text-xs text-slate-500 mt-0.5">Nome do site e tagline exibidos no rodapé</p>
        </div>
        <div class="p-5 space-y-4">
          <div>
            <label class="block text-xs font-semibold text-slate-600 mb-1.5">Nome do site</label>
            <div class="flex gap-2">
              <input id="brand-site_name" class="input flex-1" value="${escHtml(bGet('site_name') || 'KainowRadar')}" placeholder="KainowRadar">
              <button onclick="saveFooterField('brand','site_name',document.getElementById('brand-site_name').value)" class="btn-primary flex-shrink-0">Salvar</button>
            </div>
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-600 mb-1.5">Tagline</label>
            <div class="flex gap-2">
              <textarea id="brand-tagline" class="input flex-1 resize-none" rows="2" placeholder="Seu radar inteligente de ofertas…">${escHtml(bGet('tagline') || '')}</textarea>
              <button onclick="saveFooterField('brand','tagline',document.getElementById('brand-tagline').value)" class="btn-primary flex-shrink-0 self-start">Salvar</button>
            </div>
          </div>
        </div>
      </div>

      <!-- ═══ SEÇÃO: LOJAS PARCEIRAS ═══ -->
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div class="px-5 py-4 border-b border-slate-100 bg-gradient-to-r from-green-50 to-white flex items-center justify-between">
          <div>
            <h3 class="font-bold text-slate-800 flex items-center gap-2">
              <span class="w-7 h-7 bg-green-100 text-green-600 rounded-lg flex items-center justify-center text-sm">🏪</span>
              Lojas Parceiras
            </h3>
            <p class="text-xs text-slate-500 mt-0.5">Controle visibilidade individual e adicione novas lojas</p>
          </div>
          <button onclick="openAddFooterModal('stores','Loja','URL da categoria')" class="btn-primary text-xs">
            + Adicionar loja
          </button>
        </div>
        <div class="divide-y divide-slate-50" id="footer-stores-list">
          ${stores.length > 0 ? stores.map((s, idx) => footerStoreRow(s, idx, stores.length)).join('') : '<div class="px-5 py-4 text-sm text-slate-400">Nenhuma loja configurada. Adicione abaixo.</div>'}
        </div>
      </div>

      <!-- ═══ SEÇÃO: CATEGORIAS ═══ -->
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div class="px-5 py-4 border-b border-slate-100 bg-gradient-to-r from-orange-50 to-white flex items-center justify-between">
          <div>
            <h3 class="font-bold text-slate-800 flex items-center gap-2">
              <span class="w-7 h-7 bg-orange-100 text-orange-600 rounded-lg flex items-center justify-center text-sm">📂</span>
              Categorias
            </h3>
            <p class="text-xs text-slate-500 mt-0.5">Links de categorias exibidos na coluna do rodapé</p>
          </div>
          <button onclick="openAddFooterModal('categories','Nome da categoria','URL (ex: /categoria/smartphones)')" class="btn-primary text-xs">
            + Adicionar categoria
          </button>
        </div>
        <div class="divide-y divide-slate-50" id="footer-categories-list">
          ${categories.length > 0 ? categories.map((c, idx) => footerCategoryRow(c, idx, categories.length)).join('') : '<div class="px-5 py-4 text-sm text-slate-400">Nenhuma categoria configurada. Adicione abaixo.</div>'}
        </div>
      </div>

      <!-- ═══ SEÇÃO: INFORMAÇÕES ═══ -->
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div class="px-5 py-4 border-b border-slate-100 bg-gradient-to-r from-purple-50 to-white flex items-center justify-between">
          <div>
            <h3 class="font-bold text-slate-800 flex items-center gap-2">
              <span class="w-7 h-7 bg-purple-100 text-purple-600 rounded-lg flex items-center justify-center text-sm">🔗</span>
              Informações
            </h3>
            <p class="text-xs text-slate-500 mt-0.5">Links da coluna de informações do rodapé</p>
          </div>
          <button onclick="openAddFooterModal('info','Label do link','URL (ex: /sobre)')" class="btn-primary text-xs">
            + Adicionar link
          </button>
        </div>
        <div class="divide-y divide-slate-50" id="footer-info-list">
          ${info.length > 0 ? info.map((i, idx) => footerInfoRow(i, idx, info.length)).join('') : '<div class="px-5 py-4 text-sm text-slate-400">Nenhum link configurado.</div>'}
        </div>
      </div>

      <!-- ═══ SEÇÃO: RODAPÉ INFERIOR ═══ -->
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div class="px-5 py-4 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white">
          <h3 class="font-bold text-slate-800 flex items-center gap-2">
            <span class="w-7 h-7 bg-slate-100 text-slate-600 rounded-lg flex items-center justify-center text-sm">📜</span>
            Rodapé Inferior
          </h3>
          <p class="text-xs text-slate-500 mt-0.5">Texto de disclaimer e copyright</p>
        </div>
        <div class="p-5 space-y-4">
          <div>
            <label class="block text-xs font-semibold text-slate-600 mb-1.5">Disclaimer (links de afiliados)</label>
            <div class="flex gap-2">
              <textarea id="bottom-disclaimer" class="input flex-1 resize-none" rows="3" placeholder="Este site usa links de afiliados…">${escHtml(bottom.find(b => b.key === 'disclaimer')?.value || '')}</textarea>
              <button onclick="saveFooterField('bottom','disclaimer',document.getElementById('bottom-disclaimer').value)" class="btn-primary flex-shrink-0 self-start">Salvar</button>
            </div>
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-600 mb-1.5">Copyright</label>
            <div class="flex gap-2">
              <input id="bottom-copyright" class="input flex-1" value="${escHtml(bottom.find(b => b.key === 'copyright')?.value || '')}" placeholder="© 2025 KainowRadar…">
              <button onclick="saveFooterField('bottom','copyright',document.getElementById('bottom-copyright').value)" class="btn-primary flex-shrink-0">Salvar</button>
            </div>
          </div>
        </div>
      </div>

    </div>

    <!-- Modal para adicionar item -->
    <div id="footer-add-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4">
      <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" onclick="closeFooterModal()"></div>
      <div class="relative bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 z-10">
        <h3 id="footer-modal-title" class="text-lg font-bold text-slate-800 mb-5">Adicionar item</h3>
        <div class="space-y-4">
          <div>
            <label class="block text-xs font-semibold text-slate-600 mb-1.5" id="footer-modal-label1">Nome / Label</label>
            <input id="footer-modal-key" class="input" placeholder="">
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-600 mb-1.5" id="footer-modal-label2">URL / Link</label>
            <input id="footer-modal-value" class="input" placeholder="/categoria/exemplo">
          </div>
          <div class="flex items-center gap-2">
            <input type="checkbox" id="footer-modal-visible" checked class="w-4 h-4 accent-blue-600">
            <label for="footer-modal-visible" class="text-sm text-slate-600">Visível no rodapé</label>
          </div>
        </div>
        <div class="flex gap-3 mt-6">
          <button onclick="closeFooterModal()" class="btn-secondary flex-1">Cancelar</button>
          <button onclick="confirmAddFooterItem()" class="btn-primary flex-1">Adicionar</button>
        </div>
      </div>
    </div>
  `
}

function footerStoreRow(s, idx, total) {
  const visClass = s.is_visible ? 'text-green-600 bg-green-50' : 'text-slate-400 bg-slate-100'
  const visLabel = s.is_visible ? 'Visível' : 'Oculto'
  return `
    <div class="flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors" id="frow-stores-${encodeURIComponent(s.key)}">
      <label class="toggle-switch flex-shrink-0">
        <input type="checkbox" ${s.is_visible ? 'checked' : ''} onchange="toggleFooterVisible('stores',${JSON.stringify(s.key)},this.checked,${s.sort_order})">
        <span class="toggle-slider"></span>
      </label>
      <div class="flex-1 min-w-0">
        <div class="text-sm font-medium text-slate-800 truncate">${escHtml(s.key)}</div>
        <div class="text-xs text-slate-400 truncate">${escHtml(s.value || '#')}</div>
      </div>
      <span class="text-xs px-2 py-0.5 rounded-full font-medium ${visClass}">${visLabel}</span>
      <button onclick="editFooterStore(${JSON.stringify(s.key)},${JSON.stringify(s.value||'')},${s.is_visible},${s.sort_order})"
        class="flex-shrink-0 p-1.5 text-slate-300 hover:text-blue-500 hover:bg-blue-50 rounded-lg transition-colors" title="Editar">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
      </button>
      <button onclick="deleteFooterItem('stores',${JSON.stringify(s.key)})"
        class="flex-shrink-0 p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors" title="Remover">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
      </button>
    </div>
  `
}

function footerInfoRow(item, idx, total) {
  const visClass = item.is_visible ? 'text-green-600 bg-green-50' : 'text-slate-400 bg-slate-100'
  const visLabel = item.is_visible ? 'Visível' : 'Oculto'
  return `
    <div class="flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors">
      <label class="toggle-switch flex-shrink-0">
        <input type="checkbox" ${item.is_visible ? 'checked' : ''} onchange="toggleFooterVisible('info',${JSON.stringify(item.key)},this.checked,${item.sort_order})">
        <span class="toggle-slider"></span>
      </label>
      <div class="flex-1 min-w-0">
        <div class="text-sm font-medium text-slate-800 truncate">${escHtml(item.key)}</div>
        <div class="text-xs text-slate-400 truncate">${escHtml(item.value || '#')}</div>
      </div>
      <span class="text-xs px-2 py-0.5 rounded-full font-medium ${visClass}">${visLabel}</span>
      <button onclick="editFooterInfo(${JSON.stringify(item.key)},${JSON.stringify(item.value||'')},${item.is_visible},${item.sort_order})"
        class="flex-shrink-0 p-1.5 text-slate-300 hover:text-blue-500 hover:bg-blue-50 rounded-lg transition-colors" title="Editar">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
      </button>
      <button onclick="deleteFooterItem('info',${JSON.stringify(item.key)})"
        class="flex-shrink-0 p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors" title="Remover">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
      </button>
    </div>
  `
}

function footerCategoryRow(item, idx, total) {
  const visClass = item.is_visible ? 'text-green-600 bg-green-50' : 'text-slate-400 bg-slate-100'
  const visLabel = item.is_visible ? 'Visível' : 'Oculto'
  return `
    <div class="flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors" id="frow-categories-${encodeURIComponent(item.key)}">
      <label class="toggle-switch flex-shrink-0">
        <input type="checkbox" ${item.is_visible ? 'checked' : ''} onchange="toggleFooterVisible('categories',${JSON.stringify(item.key)},this.checked,${item.sort_order})">
        <span class="toggle-slider"></span>
      </label>
      <div class="flex-1 min-w-0">
        <div class="text-sm font-medium text-slate-800 truncate">${escHtml(item.key)}</div>
        <div class="text-xs text-slate-400 truncate">${escHtml(item.value || '#')}</div>
      </div>
      <span class="text-xs px-2 py-0.5 rounded-full font-medium ${visClass}">${visLabel}</span>
      <button onclick="editFooterCategory(${JSON.stringify(item.key)},${JSON.stringify(item.value||'')},${item.is_visible},${item.sort_order})"
        class="flex-shrink-0 p-1.5 text-slate-300 hover:text-blue-500 hover:bg-blue-50 rounded-lg transition-colors" title="Editar">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
      </button>
      <button onclick="deleteFooterItem('categories',${JSON.stringify(item.key)})"
        class="flex-shrink-0 p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors" title="Remover">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
      </button>
    </div>
  `
}

// helpers JS para footer admin
function escHtml(s) {
  if (!s) return ''
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

async function saveFooterField(section, key, value) {
  const res = await api('PUT', `/admin/api/footer-config/${section}/${encodeURIComponent(key)}`, { value })
  if (res?.ok) toast('✓ Salvo com sucesso', 'success')
  else toast('Erro ao salvar', 'error')
}

async function toggleFooterVisible(section, key, visible, sort_order) {
  await api('PUT', `/admin/api/footer-config/${section}/${encodeURIComponent(key)}`, { is_visible: visible, sort_order })
  toast(visible ? '✓ Item visível' : 'Item ocultado', visible ? 'success' : 'info')
}

async function deleteFooterItem(section, key) {
  if (!confirm(`Remover "${key}" do rodapé?`)) return
  const res = await api('DELETE', `/admin/api/footer-config/${section}/${encodeURIComponent(key)}`)
  if (res?.ok) {
    toast('✓ Item removido', 'info')
    renderFooterAdmin(document.getElementById('content-area'))
  } else toast('Erro ao remover', 'error')
}

// Estado do modal de adição
let _footerModalSection = ''
function openAddFooterModal(section, label1, label2) {
  _footerModalSection = section
  const titles = { stores: 'Adicionar Loja Parceira', categories: 'Adicionar Categoria', info: 'Adicionar Link' }
  document.getElementById('footer-modal-title').textContent = titles[section] || 'Adicionar Item'
  document.getElementById('footer-modal-label1').textContent = label1
  document.getElementById('footer-modal-label2').textContent = label2
  document.getElementById('footer-modal-key').value = ''
  document.getElementById('footer-modal-value').value = ''
  document.getElementById('footer-modal-visible').checked = true
  document.getElementById('footer-add-modal').classList.remove('hidden')
  setTimeout(() => document.getElementById('footer-modal-key').focus(), 100)
}

function closeFooterModal() {
  document.getElementById('footer-add-modal').classList.add('hidden')
}

async function confirmAddFooterItem() {
  const key   = document.getElementById('footer-modal-key').value.trim()
  const value = document.getElementById('footer-modal-value').value.trim()
  const vis   = document.getElementById('footer-modal-visible').checked
  if (!key) { toast('Preencha o nome / label', 'error'); return }
  const res = await api('POST', `/admin/api/footer-config/${_footerModalSection}`, {
    key, value, is_visible: vis, sort_order: 99
  })
  if (res?.ok) {
    toast('✓ Item adicionado', 'success')
    closeFooterModal()
    renderFooterAdmin(document.getElementById('content-area'))
  } else toast('Erro ao adicionar', 'error')
}

// Edição inline de categoria (reutiliza modal)
function editFooterCategory(key, value, is_visible, sort_order) {
  _footerModalSection = 'categories'
  document.getElementById('footer-modal-title').textContent = 'Editar Categoria'
  document.getElementById('footer-modal-label1').textContent = 'Nome da categoria'
  document.getElementById('footer-modal-label2').textContent = 'URL (ex: /categoria/smartphones)'
  document.getElementById('footer-modal-key').value = key
  document.getElementById('footer-modal-key').readOnly = true
  document.getElementById('footer-modal-value').value = value
  document.getElementById('footer-modal-visible').checked = !!is_visible
  document.getElementById('footer-add-modal').classList.remove('hidden')
  setTimeout(() => document.getElementById('footer-modal-value').focus(), 100)
}

// Edição inline de loja (reutiliza modal)
function editFooterStore(key, value, is_visible, sort_order) {
  _footerModalSection = 'stores'
  document.getElementById('footer-modal-title').textContent = 'Editar Loja Parceira'
  document.getElementById('footer-modal-label1').textContent = 'Nome da loja'
  document.getElementById('footer-modal-label2').textContent = 'URL da categoria'
  document.getElementById('footer-modal-key').value = key
  document.getElementById('footer-modal-key').readOnly = true
  document.getElementById('footer-modal-value').value = value
  document.getElementById('footer-modal-visible').checked = !!is_visible
  document.getElementById('footer-add-modal').classList.remove('hidden')
  // troca botão para salvar edição
  const btn = document.querySelector('#footer-add-modal [onclick="confirmAddFooterItem()"]')
  if (btn) {
    btn.onclick = async () => {
      const newVal = document.getElementById('footer-modal-value').value.trim()
      const newVis = document.getElementById('footer-modal-visible').checked
      await api('PUT', `/admin/api/footer-config/stores/${encodeURIComponent(key)}`, { value: newVal, is_visible: newVis, sort_order })
      toast('✓ Loja atualizada', 'success')
      closeFooterModal()
      document.getElementById('footer-modal-key').readOnly = false
      btn.onclick = confirmAddFooterItem
      renderFooterAdmin(document.getElementById('content-area'))
    }
  }
}

function editFooterInfo(key, value, is_visible, sort_order) {
  _footerModalSection = 'info'
  document.getElementById('footer-modal-title').textContent = 'Editar Link'
  document.getElementById('footer-modal-label1').textContent = 'Label do link'
  document.getElementById('footer-modal-label2').textContent = 'URL'
  document.getElementById('footer-modal-key').value = key
  document.getElementById('footer-modal-key').readOnly = true
  document.getElementById('footer-modal-value').value = value
  document.getElementById('footer-modal-visible').checked = !!is_visible
  document.getElementById('footer-add-modal').classList.remove('hidden')
  const btn = document.querySelector('#footer-add-modal [onclick="confirmAddFooterItem()"]')
  if (btn) {
    btn.onclick = async () => {
      const newVal = document.getElementById('footer-modal-value').value.trim()
      const newVis = document.getElementById('footer-modal-visible').checked
      await api('PUT', `/admin/api/footer-config/info/${encodeURIComponent(key)}`, { value: newVal, is_visible: newVis, sort_order })
      toast('✓ Link atualizado', 'success')
      closeFooterModal()
      document.getElementById('footer-modal-key').readOnly = false
      btn.onclick = confirmAddFooterItem
      renderFooterAdmin(document.getElementById('content-area'))
    }
  }
}

async function renderApiConfigs(area) {
  // Garante que todos os 18 registros existam no banco (idempotente)
  await api('POST', '/admin/api/api-configs/seed').catch(() => {})

  const dbData = await api('GET', '/admin/api/api-configs')
  if (!dbData) return

  // Mapeia configs do banco por network id
  const dbMap = {}
  ;(dbData || []).forEach(cfg => { dbMap[cfg.network] = cfg })

  const groupIcons = {
    'Marketplaces': '🛒',
    'Infoprodutos': '🎓',
    'Redes Multimarcas': '🌐',
    'Plataformas de Parceria': '🤝',
    'Live Commerce': '🎮',
    'Discovery Commerce': '🔍',
    'E-commerce Builder': '🏗️',
    'Tecnologia & SaaS': '⚙️',
    'Social Commerce': '📱',
    'Outros': '🏷️',
  }

  function buildCard(net) {
    const db = dbMap[net.network] || {}
    const isActive = db.is_active ?? 0
    const configId = db.id || null
    const hasKey = !!db.api_key_preview
    const hasLogo = !!db.logo_url
    const lastSync = db.last_sync_at
    const syncStatus = db.last_sync_status

    const avatarHTML = hasLogo
      ? '<div style="width:38px;height:38px;border-radius:9px;background:#fff;border:1px solid ' + net.border + '30;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;box-shadow:0 2px 6px rgba(0,0,0,0.08)">'
        + '<img src="' + db.logo_url + '" alt="' + net.name + '" style="width:30px;height:30px;object-fit:contain">'
        + '</div>'
      : '<div style="width:38px;height:38px;border-radius:9px;background:' + net.color + '22;display:flex;align-items:center;justify-content:center;flex-shrink:0">'
        + '<span style="font-size:1.3rem">' + net.icon + '</span>'
        + '</div>'

    const activeBadge = isActive
      ? '<span class="flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full"><span class="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></span>Ativo</span>'
      : '<span class="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">Inativo</span>'
    const keyBadge = hasKey
      ? '<span class="text-xs text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full">\uD83D\uDD11 Chave configurada</span>'
      : '<span class="text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">\u26A0\uFE0F Sem credenciais</span>'
    const logoBadge = hasLogo ? '<span class="text-xs text-purple-700 bg-purple-50 px-2 py-0.5 rounded-full">\uD83D\uDDBC\uFE0F Logo OK</span>' : ''
    const syncBadge = syncStatus === 'ok'
      ? '<span class="text-xs text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full">\u2713 Sync OK</span>'
      : syncStatus === 'error'
        ? '<span class="text-xs text-red-700 bg-red-50 px-2 py-0.5 rounded-full">\u2717 Erro sync</span>'
        : ''
    const syncLine = lastSync ? '<div class="text-xs text-slate-400 mb-2">\u00DAltima sync: ' + fDateTime(lastSync) + '</div>' : ''
    const btnClass = hasKey ? 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100' : 'bg-blue-600 border-blue-600 text-white hover:bg-blue-700'
    const btnLabel = hasKey ? '\u270F\uFE0F Editar credenciais' : '\uD83D\uDD0C Configurar'
    const checked = isActive ? 'checked' : ''

    return (
      '<div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden hover:shadow-md transition-shadow" id="aff-card-' + net.id + '">'
      + '<div class="px-4 py-3 flex items-center justify-between" style="background:' + net.bg + '; border-bottom: 2px solid ' + net.border + '20">'
      +   '<div class="flex items-center gap-2.5">'
      +     avatarHTML
      +     '<div>'
      +       '<div class="font-bold text-slate-800 text-sm leading-tight">' + net.name + '</div>'
      +       '<div class="text-xs font-medium mt-0.5" style="color:' + net.color + '">' + net.commission + ' comiss\u00E3o</div>'
      +     '</div>'
      +   '</div>'
      +   '<label class="toggle-switch flex-shrink-0">'
      +     '<input type="checkbox" ' + checked + ' data-network="' + net.network + '" data-config-id="' + configId + '" onchange="toggleAffNetwork(this.dataset.network, this.dataset.configId, this.checked)">'
      +     '<span class="toggle-slider"></span>'
      +   '</label>'
      + '</div>'
      + '<div class="px-4 py-3">'
      +   '<p class="text-xs text-slate-500 mb-3 leading-relaxed">' + net.desc + '</p>'
      +   '<div class="flex items-center gap-2 flex-wrap mb-3">' + activeBadge + keyBadge + logoBadge + syncBadge + '</div>'
      +   syncLine
      +   '<div class="flex items-center gap-2 mt-2">'
      +     '<button data-net-id="' + net.id + '" onclick="openAffModal(this.dataset.netId)" class="flex-1 text-xs font-semibold py-2 px-3 rounded-xl border transition-all ' + btnClass + '">' + btnLabel + '</button>'
      +     '<a href="' + net.docsUrl + '" target="_blank" class="text-xs text-slate-400 hover:text-blue-600 transition-colors px-2" title="Ver documenta\u00E7\u00E3o">\uD83D\uDCC4</a>'
      +   '</div>'
      + '</div>'
      + '</div>'
    )
  }

  // ── Cards de empresas customizadas ──────────────────────────────────────────
  function buildCustomCard(cfg) {
    const isActive = cfg.is_active ?? 0
    const hasKey   = !!cfg.api_key_preview
    const color    = cfg.color || '#6366F1'
    const icon     = cfg.icon  || '🔌'
    const commission = cfg.commission_rate ? cfg.commission_rate + '%' : '—'
    const avatarHTML = cfg.logo_url
      ? '<div style="width:38px;height:38px;border-radius:9px;background:#fff;border:1px solid #e2e8f0;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;box-shadow:0 2px 6px rgba(0,0,0,0.08)">'
        + '<img src="' + cfg.logo_url + '" alt="' + cfg.name + '" style="width:30px;height:30px;object-fit:contain">'
        + '</div>'
      : '<div style="width:38px;height:38px;border-radius:9px;background:' + color + '22;display:flex;align-items:center;justify-content:center;flex-shrink:0">'
        + '<span style="font-size:1.3rem">' + icon + '</span>'
        + '</div>'
    const activeBadge = isActive
      ? '<span class="flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full"><span class="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></span>Ativo</span>'
      : '<span class="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">Inativo</span>'
    const keyBadge = hasKey
      ? '<span class="text-xs text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full">\uD83D\uDD11 Chave configurada</span>'
      : '<span class="text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">\u26A0\uFE0F Sem credenciais</span>'
    const checked = isActive ? 'checked' : ''
    const btnClass = hasKey ? 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100' : 'bg-blue-600 border-blue-600 text-white hover:bg-blue-700'
    const btnLabel = hasKey ? '\u270F\uFE0F Editar' : '\uD83D\uDD0C Configurar'
    return (
      '<div class="bg-white rounded-2xl border-2 border-indigo-100 shadow-sm overflow-hidden hover:shadow-md transition-shadow" id="aff-card-custom-' + cfg.id + '">'
      + '<div class="px-4 py-3 flex items-center justify-between" style="background:' + color + '12; border-bottom: 2px solid ' + color + '30">'
      +   '<div class="flex items-center gap-2.5">'
      +     avatarHTML
      +     '<div>'
      +       '<div class="font-bold text-slate-800 text-sm leading-tight">' + cfg.name + '</div>'
      +       '<div class="text-xs font-medium mt-0.5" style="color:' + color + '">' + commission + ' comiss\u00E3o</div>'
      +     '</div>'
      +   '</div>'
      +   '<div class="flex items-center gap-2">'
      +     '<span class="text-xs bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded-full font-semibold">custom</span>'
      +     '<label class="toggle-switch flex-shrink-0">'
      +       '<input type="checkbox" ' + checked + ' data-network="' + cfg.network + '" data-config-id="' + cfg.id + '" onchange="toggleAffNetwork(this.dataset.network, this.dataset.configId, this.checked)">'
      +       '<span class="toggle-slider"></span>'
      +     '</label>'
      +   '</div>'
      + '</div>'
      + '<div class="px-4 py-3">'
      +   '<p class="text-xs text-slate-500 mb-3 leading-relaxed">' + (cfg.description || cfg.network) + '</p>'
      +   '<div class="flex items-center gap-2 flex-wrap mb-3">' + activeBadge + keyBadge + '</div>'
      +   '<div class="flex items-center gap-2 mt-2">'
      +     '<button data-net-id="' + cfg.id + '" onclick="openCustomConfigModal(this.dataset.netId)" class="flex-1 text-xs font-semibold py-2 px-3 rounded-xl border transition-all ' + btnClass + '">' + btnLabel + '</button>'
      +     '<button data-custom-id="' + cfg.id + '" data-custom-name="' + cfg.name + '" onclick="deleteCustomIntegration(this.dataset.customId, this.dataset.customName)" class="flex-shrink-0 w-8 h-8 flex items-center justify-center text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-xl border border-slate-200 transition-colors" title="Remover empresa">'
      +       '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>'
      +     '</button>'
      +   '</div>'
      + '</div>'
      + '</div>'
    )
  }

  // Separa customizadas
  const customEntries = (dbData || []).filter(cfg => cfg.custom)

  let groupsHTML = ''
  AFFILIATE_GROUPS.forEach(group => {
    const nets = AFFILIATE_NETWORKS.filter(n => n.group === group)
    if (!nets.length) return
    const activeCount = nets.filter(n => (dbMap[n.network]?.is_active ?? 0)).length
    groupsHTML += `
      <div class="mb-8">
        <div class="flex items-center gap-3 mb-4">
          <span class="text-xl">${groupIcons[group]}</span>
          <h3 class="text-base font-bold text-slate-800">${group}</h3>
          <span class="text-xs font-medium px-2 py-0.5 rounded-full ${activeCount > 0 ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}">
            ${activeCount}/${nets.length} ativos
          </span>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          ${nets.map(buildCard).join('')}
        </div>
      </div>
    `
  })

  // Bloco empresas customizadas
  const totalCustom = customEntries.length
  const customHTML = totalCustom > 0 ? `
    <div class="mb-8">
      <div class="flex items-center gap-3 mb-4">
        <span class="text-xl">✨</span>
        <h3 class="text-base font-bold text-slate-800">Minhas Empresas</h3>
        <span class="text-xs font-medium px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700">
          ${totalCustom} cadastradas
        </span>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        ${customEntries.map(buildCustomCard).join('')}
      </div>
    </div>
  ` : ''

  // Sumário geral
  const totalActive = AFFILIATE_NETWORKS.filter(n => dbMap[n.network]?.is_active).length
  const totalConfigured = AFFILIATE_NETWORKS.filter(n => dbMap[n.network]?.api_key_preview).length

  area.innerHTML = `
    <div class="section">
      <!-- Banner de segurança -->
      <div class="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800 flex items-start gap-3">
        <span class="text-xl flex-shrink-0">🔒</span>
        <div>
          <strong>Segurança:</strong> As chaves são mascaradas na exibição. Em produção, prefira usar
          <code class="bg-amber-100 px-1.5 py-0.5 rounded text-xs">wrangler secret put AMAZON_ACCESS_KEY</code>
          para guardar segredos fora do banco. Ative o <strong>Cloudflare Zero Trust</strong> na rota
          <code class="bg-amber-100 px-1 rounded text-xs">/admin</code> para proteção máxima.
        </div>
      </div>

      <!-- Cabeçalho + botão Cadastrar -->
      <div class="flex items-end justify-between gap-4">
        <div class="grid grid-cols-4 gap-4 flex-1">
          <div class="stat-card text-center border-t-4 border-blue-400">
            <div class="text-3xl font-black text-slate-800">${AFFILIATE_NETWORKS.length + totalCustom}</div>
            <div class="text-sm text-slate-500 mt-1">Redes disponíveis</div>
          </div>
          <div class="stat-card text-center border-t-4 border-green-400">
            <div class="text-3xl font-black text-green-700">${totalActive}</div>
            <div class="text-sm text-slate-500 mt-1">Redes ativas</div>
          </div>
          <div class="stat-card text-center border-t-4 border-amber-400">
            <div class="text-3xl font-black text-amber-700">${totalConfigured}</div>
            <div class="text-sm text-slate-500 mt-1">Com credenciais</div>
          </div>
          <div class="stat-card text-center border-t-4 border-indigo-400">
            <div class="text-3xl font-black text-indigo-700">${totalCustom}</div>
            <div class="text-sm text-slate-500 mt-1">Customizadas</div>
          </div>
        </div>
        <button onclick="openNewIntegrationModal()"
          class="flex-shrink-0 flex items-center gap-2 bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-700 hover:to-blue-700 text-white font-bold px-5 py-3 rounded-xl shadow-md hover:shadow-lg transition-all text-sm whitespace-nowrap">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4"/>
          </svg>
          Cadastrar nova empresa
        </button>
      </div>

      <!-- Empresas customizadas (topo, destaque) -->
      ${customHTML}

      <!-- Cards por grupo (redes padrão) -->
      ${groupsHTML}
    </div>
  `
}

// Abre modal de configuração da rede pelo id estático
function openAffModal(netId) {
  const net = AFFILIATE_NETWORKS.find(n => n.id === netId)
  if (!net) return

  const fieldsHTML = net.fields.map(f => {
    const [fieldKey, fieldLabel] = f.split(':')
    const isSecret = ['api_key','client_secret'].includes(fieldKey)
    const placeholders = {
      api_key: '••••••••••••••••',
      client_id: 'ex: 12345678',
      client_secret: '••••••••••••••••',
      partner_tag: 'ex: seusite-20',
    }
    return `
      <div>
        <label class="block text-sm font-medium text-slate-600 mb-1">${fieldLabel}</label>
        <input type="${isSecret ? 'password' : 'text'}"
               id="modal-${fieldKey}"
               class="input"
               placeholder="${placeholders[fieldKey] || ''}">
      </div>
    `
  }).join('')

  const modal = document.getElementById('modal-container')
  modal.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this) closeModal()">
      <div class="modal max-w-lg" style="max-height:90vh;overflow-y:auto;">

        <!-- Header com logo preview -->
        <div class="flex items-center gap-3 mb-5 pb-4 border-b border-slate-100">
          <div id="modal-logo-preview"
               style="width:52px;height:52px;border-radius:12px;background:${net.color};flex-shrink:0;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,0.15);overflow:hidden;">
            <span class="text-2xl" id="modal-logo-emoji">${net.icon}</span>
          </div>
          <div class="flex-1 min-w-0">
            <h3 class="font-bold text-slate-800 text-lg leading-tight">${net.name}</h3>
            <p class="text-xs text-slate-500 mt-0.5 truncate">${net.desc}</p>
          </div>
        </div>

        <!-- Campo Logo URL (destaque visual) -->
        <div class="bg-slate-50 rounded-xl p-3 mb-4 border border-slate-200">
          <label class="block text-sm font-bold text-slate-700 mb-2">
            🖼️ Logo da empresa
          </label>
          <div class="flex gap-2 items-center">
            <input type="url" id="modal-logo-url" class="input flex-1 text-xs"
                   placeholder="https://logo.clearbit.com/amazon.com.br"
                   data-net-color="${net.color}"
                   oninput="previewLogo(this.value, this.dataset.netColor)">
            <button type="button"
                    data-net-id="${net.id}" data-net-name="${net.name}" data-net-color="${net.color}"
                    onclick="autoFetchLogo(this.dataset.netId, this.dataset.netName, this.dataset.netColor)"
                    class="flex-shrink-0 bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs font-semibold px-3 py-2 rounded-lg transition-all whitespace-nowrap">
              ✨ Auto
            </button>
          </div>
          <p class="text-xs text-slate-400 mt-1.5">
            Cole a URL da logo (PNG/SVG) ou clique em <strong>Auto</strong> para buscar automaticamente
          </p>
          <!-- Sugestões rápidas -->
          <div class="flex flex-wrap gap-1.5 mt-2">
            <button data-logo-url="https://logo.clearbit.com/${net.id}.com" data-net-color="${net.color}"
                    onclick="var u=this.dataset.logoUrl; document.getElementById('modal-logo-url').value=u; previewLogo(u, this.dataset.netColor)"
                    class="text-xs bg-white border border-slate-200 text-slate-600 px-2 py-0.5 rounded-md hover:border-blue-300 hover:text-blue-600 transition-all">
              Clearbit
            </button>
            <button data-logo-url="https://www.google.com/s2/favicons?domain=${net.id}.com.br&sz=64" data-net-color="${net.color}"
                    onclick="var u=this.dataset.logoUrl; document.getElementById('modal-logo-url').value=u; previewLogo(u, this.dataset.netColor)"
                    class="text-xs bg-white border border-slate-200 text-slate-600 px-2 py-0.5 rounded-md hover:border-blue-300 hover:text-blue-600 transition-all">
              Google Favicon
            </button>
            <button data-net-color="${net.color}"
                    onclick="document.getElementById('modal-logo-url').value=String(); previewLogo(String(), this.dataset.netColor)"
                    class="text-xs bg-white border border-red-100 text-red-400 px-2 py-0.5 rounded-md hover:bg-red-50 transition-all">
              Limpar
            </button>
          </div>
        </div>

        <!-- Demais campos -->
        <div class="space-y-3">
          ${fieldsHTML}
          <div class="grid grid-cols-2 gap-3 pt-1">
            <div>
              <label class="block text-sm font-medium text-slate-600 mb-1">Rate limit (req/min)</label>
              <input type="number" id="modal-rate-limit" class="input" placeholder="10">
            </div>
            <div>
              <label class="block text-sm font-medium text-slate-600 mb-1">Comissão base (%)</label>
              <input type="number" id="modal-commission" class="input" placeholder="5.0" step="0.1">
            </div>
          </div>
        </div>

        <div class="flex items-center gap-3 mt-5 pt-4 border-t border-slate-100">
          <button data-network="${net.network}" data-fields="${JSON.stringify(net.fields).replace(/"/g,'&quot;')}"
            onclick="saveAffConfig(this.dataset.network, JSON.parse(this.dataset.fields))"
            class="btn-primary flex-1">💾 Salvar configuração</button>
          <button onclick="closeModal()" class="btn-secondary">Cancelar</button>
          <a href="${net.docsUrl}" target="_blank"
             class="text-xs text-slate-400 hover:text-blue-600 transition-colors flex-shrink-0" title="Ver documentação">📄</a>
        </div>
      </div>
    </div>
  `
}

// Preview da logo em tempo real no header do modal
function previewLogo(url, color) {
  const preview = document.getElementById('modal-logo-preview')
  const emoji   = document.getElementById('modal-logo-emoji')
  if (!preview) return
  if (!url) {
    // Volta para emoji/ícone
    preview.style.background = color
    preview.innerHTML = `<span class="text-2xl" id="modal-logo-emoji">${emoji ? emoji.textContent : '[Plugin]'}</span>`
    return
  }
  // Mostra spinner enquanto carrega
  preview.innerHTML = `<div style="width:20px;height:20px;border:2px solid white;border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite"></div>`
  const img = new Image()
  img.onload = () => {
    preview.style.background = '#fff'
    preview.innerHTML = `<img src="${url}" style="width:42px;height:42px;object-fit:contain;border-radius:6px;">`
  }
  img.onerror = () => {
    preview.style.background = color
    preview.innerHTML = `<span style="color:white;font-size:11px;font-weight:700;text-align:center;padding:2px;">Erro</span>`
    toast('URL inválida ou imagem não carregou', 'error')
  }
  img.src = url
}

// Auto-busca a logo pela Clearbit usando o domínio da rede
function autoFetchLogo(netId, netName, color) {
  const domainMap = {
    amazon:       'amazon.com.br',
    mercadolivre: 'mercadolivre.com.br',
    magalu:       'magazineluiza.com.br',
    shopee:       'shopee.com.br',
    shein:        'shein.com',
    aliexpress:   'aliexpress.com',
    dafiti:       'dafiti.com.br',
    hotmart:      'hotmart.com',
    eduzz:        'eduzz.com',
    monetizze:    'monetizze.com.br',
    braip:        'braip.com',
    socialsoul:   'socialsoul.com.br',
    rakuten:      'rakuten.com',
    hostinger:    'hostinger.com.br',
    shopify:      'shopify.com',
    nuvemshop:    'nuvemshop.com.br',
    nestle:       'nestle.com.br',
  }
  const domain = domainMap[netId] || (netId + '.com')
  const url = `https://logo.clearbit.com/${domain}`
  const input = document.getElementById('modal-logo-url')
  if (input) input.value = url
  previewLogo(url, color)
  toast('Buscando logo...', 'info')
}

async function saveAffConfig(network, fields) {
  // Monta o body lendo os inputs do modal
  const body = { rate_limit_per_min: undefined, commission_rate: undefined }
  fields.forEach(f => {
    const [fieldKey] = f.split(':')
    const el = document.getElementById(`modal-${fieldKey}`)
    if (el && el.value.trim()) body[fieldKey] = el.value.trim()
  })
  const rateEl = document.getElementById('modal-rate-limit')
  const commEl = document.getElementById('modal-commission')
  const logoEl = document.getElementById('modal-logo-url')
  if (rateEl && rateEl.value) body.rate_limit_per_min = parseInt(rateEl.value)
  if (commEl && commEl.value) body.commission_rate = parseFloat(commEl.value)
  if (logoEl && logoEl.value.trim()) body.logo_url = logoEl.value.trim()

  // Usa rota por network — funciona para todas as 18 redes independente do id
  const res = await api('PUT', `/admin/api/api-configs/by-network/${network}`, body)
  if (res && res.ok) {
    toast('Configuração salva ✓', 'success')
  } else {
    toast('Erro ao salvar — tente novamente', 'error')
  }
  closeModal()
  renderApiConfigs(document.getElementById('content-area'))
}

async function toggleAffNetwork(network, configId, active) {
  // Usa rota por network — não depende do configId estar no banco
  await api('PUT', `/admin/api/api-configs/by-network/${network}/toggle`, { active })
  toast(active ? '✓ Integração ativada' : 'Integração desativada', active ? 'success' : 'info')
  renderApiConfigs(document.getElementById('content-area'))
}

async function toggleApiConfig(id, active) {
  await api('PATCH', `/admin/api/api-configs/${id}/toggle`, { active })
  toast(active ? 'API ativada ✓' : 'API desativada', active ? 'success' : 'info')
}

// ── Modal: Cadastrar nova empresa ────────────────────────────────────────────
function openNewIntegrationModal() {
  const groups = ['Marketplaces','Infoprodutos','Redes Multimarcas','Plataformas de Parceria','Live Commerce','Discovery Commerce','E-commerce Builder','Tecnologia & SaaS','Social Commerce','Outros']
  const modal = document.getElementById('modal-container')
  modal.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this) closeModal()">
      <div class="modal" style="max-width:520px;max-height:90vh;overflow-y:auto;">

        <!-- Header -->
        <div class="flex items-center gap-3 mb-5 pb-4 border-b border-slate-100">
          <div id="new-int-logo-preview"
            style="width:52px;height:52px;border-radius:12px;background:#6366F1;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:1.8rem;box-shadow:0 4px 12px rgba(0,0,0,0.15)">
            🔌
          </div>
          <div>
            <h3 class="font-bold text-slate-800 text-lg leading-tight">Cadastrar nova empresa</h3>
            <p class="text-xs text-slate-500 mt-0.5">Adicione uma nova integração de API ou rede afiliada</p>
          </div>
        </div>

        <!-- Campos principais -->
        <div class="space-y-3">

          <!-- Nome + Ícone -->
          <div class="grid grid-cols-3 gap-3">
            <div class="col-span-2">
              <label class="block text-sm font-semibold text-slate-700 mb-1">Nome da empresa <span class="text-red-500">*</span></label>
              <input type="text" id="new-int-name" class="input" placeholder="ex: Casas Bahia Afiliados"
                oninput="document.getElementById('new-int-logo-preview').title=this.value">
            </div>
            <div>
              <label class="block text-sm font-semibold text-slate-700 mb-1">Ícone (emoji)</label>
              <input type="text" id="new-int-icon" class="input text-center text-xl" placeholder="🏪" maxlength="4"
                oninput="var p=document.getElementById('new-int-logo-preview'); if(!document.getElementById('new-int-logo-url').value){p.innerHTML=this.value||'🔌'}">
            </div>
          </div>

          <!-- Network ID -->
          <div>
            <label class="block text-sm font-semibold text-slate-700 mb-1">
              ID da rede (network) <span class="text-red-500">*</span>
              <span class="text-xs font-normal text-slate-400 ml-1">— identificador único, ex: casasbahia-api</span>
            </label>
            <input type="text" id="new-int-network" class="input font-mono text-sm" placeholder="ex: minha-loja-api"
              oninput="this.value=this.value.toLowerCase().replace(/[^a-z0-9-]/g,'-')">
          </div>

          <!-- Descrição -->
          <div>
            <label class="block text-sm font-semibold text-slate-700 mb-1">Descrição</label>
            <input type="text" id="new-int-desc" class="input" placeholder="ex: API de afiliados da Casas Bahia — produtos, links e comissões">
          </div>

          <!-- Grupo + Comissão -->
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-sm font-semibold text-slate-700 mb-1">Grupo</label>
              <select id="new-int-group" class="input">
                ${groups.map(g => `<option value="${g}">${g}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="block text-sm font-semibold text-slate-700 mb-1">Comissão base (%)</label>
              <input type="number" id="new-int-commission" class="input" placeholder="ex: 8.5" step="0.1" min="0" max="100">
            </div>
          </div>

          <!-- Cor + Tipo de auth -->
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-sm font-semibold text-slate-700 mb-1">Cor da marca</label>
              <div class="flex gap-2 items-center">
                <input type="color" id="new-int-color" value="#6366F1" class="h-10 w-14 rounded-lg border border-slate-200 cursor-pointer p-1"
                  oninput="document.getElementById('new-int-logo-preview').style.background=this.value">
                <input type="text" id="new-int-color-text" class="input flex-1 font-mono text-sm" value="#6366F1" placeholder="#6366F1"
                  oninput="document.getElementById('new-int-color').value=this.value; document.getElementById('new-int-logo-preview').style.background=this.value">
              </div>
            </div>
            <div>
              <label class="block text-sm font-semibold text-slate-700 mb-1">Tipo de autenticação</label>
              <select id="new-int-auth" class="input">
                <option>API Key</option>
                <option>OAuth2</option>
                <option>Bearer Token</option>
                <option>Basic Auth</option>
                <option>Webhook</option>
                <option>Feed XML/CSV</option>
                <option>Outro</option>
              </select>
            </div>
          </div>

          <!-- Logo URL -->
          <div class="bg-slate-50 rounded-xl p-3 border border-slate-200">
            <label class="block text-sm font-bold text-slate-700 mb-2">🖼️ Logo da empresa</label>
            <div class="flex gap-2">
              <input type="url" id="new-int-logo-url" class="input flex-1 text-xs"
                placeholder="https://logo.clearbit.com/empresa.com.br"
                oninput="newIntPreviewLogo(this.value)">
              <button type="button" onclick="newIntAutoLogo()"
                class="flex-shrink-0 bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs font-semibold px-3 py-2 rounded-lg whitespace-nowrap">
                ✨ Auto
              </button>
            </div>
            <p class="text-xs text-slate-400 mt-1.5">Cole a URL ou clique em <strong>Auto</strong> para buscar pela Clearbit</p>
          </div>

          <!-- Divisor: Credenciais (opcionais) -->
          <div class="border-t border-slate-100 pt-3">
            <p class="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3">Credenciais (opcional — pode configurar depois)</p>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-sm font-medium text-slate-600 mb-1">API Key / Token</label>
                <input type="password" id="new-int-api-key" class="input" placeholder="••••••••••••">
              </div>
              <div>
                <label class="block text-sm font-medium text-slate-600 mb-1">Client ID</label>
                <input type="text" id="new-int-client-id" class="input" placeholder="ex: app-12345">
              </div>
              <div>
                <label class="block text-sm font-medium text-slate-600 mb-1">Client Secret</label>
                <input type="password" id="new-int-client-secret" class="input" placeholder="••••••••••••">
              </div>
              <div>
                <label class="block text-sm font-medium text-slate-600 mb-1">Partner Tag / ID afiliado</label>
                <input type="text" id="new-int-partner-tag" class="input" placeholder="ex: seusite-20">
              </div>
            </div>
          </div>

          <!-- URL Docs -->
          <div>
            <label class="block text-sm font-medium text-slate-600 mb-1">URL da documentação</label>
            <input type="url" id="new-int-docs" class="input text-xs" placeholder="https://dev.empresa.com/docs">
          </div>
        </div>

        <!-- Footer -->
        <div class="flex items-center gap-3 mt-5 pt-4 border-t border-slate-100">
          <button onclick="saveNewIntegration()"
            class="btn-primary flex-1 flex items-center justify-center gap-2">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4"/>
            </svg>
            Cadastrar empresa
          </button>
          <button onclick="closeModal()" class="btn-secondary">Cancelar</button>
        </div>

      </div>
    </div>
  `
}

function newIntPreviewLogo(url) {
  const preview = document.getElementById('new-int-logo-preview')
  if (!preview) return
  if (!url) { preview.innerHTML = document.getElementById('new-int-icon')?.value || '🔌'; return }
  preview.innerHTML = '<div style="width:20px;height:20px;border:2px solid white;border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite"></div>'
  const img = new Image()
  img.onload = () => { preview.style.background = '#fff'; preview.innerHTML = '<img src="'+url+'" style="width:42px;height:42px;object-fit:contain;border-radius:6px;">' }
  img.onerror = () => { preview.style.background = document.getElementById('new-int-color')?.value || '#6366F1'; preview.innerHTML = document.getElementById('new-int-icon')?.value || '🔌'; toast('Logo não carregou', 'error') }
  img.src = url
}

function newIntAutoLogo() {
  const network = document.getElementById('new-int-network')?.value || ''
  const domain = network.replace(/-api$|-shop$|-afiliados$/, '') + '.com.br'
  const url = 'https://logo.clearbit.com/' + domain
  const input = document.getElementById('new-int-logo-url')
  if (input) input.value = url
  newIntPreviewLogo(url)
  toast('Buscando logo...', 'info')
}

async function saveNewIntegration() {
  const name    = document.getElementById('new-int-name')?.value.trim()
  const network = document.getElementById('new-int-network')?.value.trim()
  if (!name || !network) { toast('Nome e ID da rede são obrigatórios', 'error'); return }

  const body = {
    name,
    network,
    group:           document.getElementById('new-int-group')?.value || 'Outros',
    description:     document.getElementById('new-int-desc')?.value.trim() || null,
    commission_rate: parseFloat(document.getElementById('new-int-commission')?.value) || 0,
    color:           document.getElementById('new-int-color')?.value || '#6366F1',
    icon:            document.getElementById('new-int-icon')?.value.trim() || '🔌',
    auth_type:       document.getElementById('new-int-auth')?.value || 'API Key',
    logo_url:        document.getElementById('new-int-logo-url')?.value.trim() || null,
    docs_url:        document.getElementById('new-int-docs')?.value.trim() || null,
    api_key:         document.getElementById('new-int-api-key')?.value.trim() || null,
    client_id:       document.getElementById('new-int-client-id')?.value.trim() || null,
    client_secret:   document.getElementById('new-int-client-secret')?.value.trim() || null,
    partner_tag:     document.getElementById('new-int-partner-tag')?.value.trim() || null,
  }

  const btn = document.querySelector('#modal-container .btn-primary')
  if (btn) { btn.disabled = true; btn.textContent = 'Salvando...' }

  const res = await api('POST', '/admin/api/api-configs/new', body)
  if (res?.ok) {
    toast('Empresa cadastrada com sucesso! ✓', 'success')
    closeModal()
    renderApiConfigs(document.getElementById('content-area'))
  } else {
    toast(res?.error || 'Erro ao cadastrar empresa', 'error')
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4"/></svg> Cadastrar empresa' }
  }
}

// ── Modal: Configurar empresa customizada ────────────────────────────────────
async function openCustomConfigModal(cfgId) {
  const dbData = await api('GET', '/admin/api/api-configs')
  const cfg = (dbData || []).find(c => c.id === cfgId)
  if (!cfg) { toast('Empresa não encontrada', 'error'); return }

  const modal = document.getElementById('modal-container')
  modal.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this) closeModal()">
      <div class="modal" style="max-width:480px;max-height:90vh;overflow-y:auto;">
        <div class="flex items-center gap-3 mb-5 pb-4 border-b border-slate-100">
          <div style="width:52px;height:52px;border-radius:12px;background:${cfg.color||'#6366F1'};flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:1.8rem;box-shadow:0 4px 12px rgba(0,0,0,0.15)">
            ${cfg.icon||'🔌'}
          </div>
          <div>
            <h3 class="font-bold text-slate-800 text-lg">${cfg.name}</h3>
            <p class="text-xs text-slate-500 font-mono">${cfg.network}</p>
          </div>
        </div>
        <div class="space-y-3">
          <div><label class="block text-sm font-medium text-slate-600 mb-1">API Key / Token</label>
            <input type="password" id="ccfg-api-key" class="input" placeholder="••••••••••••"></div>
          <div><label class="block text-sm font-medium text-slate-600 mb-1">Client ID</label>
            <input type="text" id="ccfg-client-id" class="input" placeholder="ex: app-12345"></div>
          <div><label class="block text-sm font-medium text-slate-600 mb-1">Client Secret</label>
            <input type="password" id="ccfg-client-secret" class="input" placeholder="••••••••••••"></div>
          <div><label class="block text-sm font-medium text-slate-600 mb-1">Partner Tag / ID afiliado</label>
            <input type="text" id="ccfg-partner-tag" class="input" placeholder="ex: seusite-20"></div>
          <div class="grid grid-cols-2 gap-3">
            <div><label class="block text-sm font-medium text-slate-600 mb-1">Rate limit (req/min)</label>
              <input type="number" id="ccfg-rate" class="input" placeholder="10"></div>
            <div><label class="block text-sm font-medium text-slate-600 mb-1">Comissão (%)</label>
              <input type="number" id="ccfg-commission" class="input" placeholder="${cfg.commission_rate||5}" step="0.1"></div>
          </div>
          <div><label class="block text-sm font-medium text-slate-600 mb-1">Logo URL</label>
            <input type="url" id="ccfg-logo" class="input text-xs" placeholder="https://logo.clearbit.com/empresa.com.br"></div>
        </div>
        <div class="flex gap-3 mt-5 pt-4 border-t border-slate-100">
          <button onclick="saveCustomConfig('${cfgId}')" class="btn-primary flex-1">💾 Salvar</button>
          <button onclick="closeModal()" class="btn-secondary">Cancelar</button>
        </div>
      </div>
    </div>
  `
}

async function saveCustomConfig(cfgId) {
  const body = {
    api_key:         document.getElementById('ccfg-api-key')?.value.trim() || undefined,
    client_id:       document.getElementById('ccfg-client-id')?.value.trim() || undefined,
    client_secret:   document.getElementById('ccfg-client-secret')?.value.trim() || undefined,
    partner_tag:     document.getElementById('ccfg-partner-tag')?.value.trim() || undefined,
    rate_limit_per_min: parseInt(document.getElementById('ccfg-rate')?.value) || undefined,
    commission_rate: parseFloat(document.getElementById('ccfg-commission')?.value) || undefined,
    logo_url:        document.getElementById('ccfg-logo')?.value.trim() || undefined,
  }
  const res = await api('PATCH', `/admin/api/api-configs/${cfgId}`, body)
  if (res?.ok) { toast('Configuração salva ✓', 'success'); closeModal(); renderApiConfigs(document.getElementById('content-area')) }
  else toast('Erro ao salvar', 'error')
}

// ── Deletar empresa customizada ──────────────────────────────────────────────
async function deleteCustomIntegration(cfgId, name) {
  if (!confirm('Remover a empresa "' + name + '"? Esta ação não pode ser desfeita.')) return
  const res = await api('DELETE', `/admin/api/api-configs/${cfgId}`)
  if (res?.ok) { toast('Empresa removida ✓', 'success'); renderApiConfigs(document.getElementById('content-area')) }
  else toast(res?.error || 'Erro ao remover', 'error')
}


function editApiConfig(id, name) {
  const modal = document.getElementById('modal-container')
  modal.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this) closeModal()">
      <div class="modal">
        <h3 class="font-bold text-slate-800 text-lg mb-4">🔌 Configurar: ${name}</h3>
        <div class="space-y-3">
          <div>
            <label class="block text-sm font-medium text-slate-600 mb-1">API Key / Token</label>
            <input type="password" id="cfg-api-key" class="input" placeholder="••••••••••••">
          </div>
          <div>
            <label class="block text-sm font-medium text-slate-600 mb-1">Client ID</label>
            <input type="text" id="cfg-client-id" class="input" placeholder="ex: app-12345">
          </div>
          <div>
            <label class="block text-sm font-medium text-slate-600 mb-1">Client Secret</label>
            <input type="password" id="cfg-client-secret" class="input" placeholder="••••••••••••">
          </div>
          <div>
            <label class="block text-sm font-medium text-slate-600 mb-1">Partner Tag / Affiliate ID</label>
            <input type="text" id="cfg-partner-tag" class="input" placeholder="ex: seusite-20">
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-sm font-medium text-slate-600 mb-1">Rate limit (req/min)</label>
              <input type="number" id="cfg-rate-limit" class="input" placeholder="10">
            </div>
            <div>
              <label class="block text-sm font-medium text-slate-600 mb-1">Comissão (%)</label>
              <input type="number" id="cfg-commission" class="input" placeholder="5.0" step="0.1">
            </div>
          </div>
        </div>
        <div class="flex gap-3 mt-5">
          <button onclick="saveApiConfig('${id}')" class="btn-primary flex-1">Salvar</button>
          <button onclick="closeModal()" class="btn-secondary">Cancelar</button>
        </div>
      </div>
    </div>
  `
}

async function saveApiConfig(id) {
  const body = {
    api_key: document.getElementById('cfg-api-key').value || undefined,
    client_id: document.getElementById('cfg-client-id').value || undefined,
    client_secret: document.getElementById('cfg-client-secret').value || undefined,
    partner_tag: document.getElementById('cfg-partner-tag').value || undefined,
    rate_limit_per_min: parseInt(document.getElementById('cfg-rate-limit').value) || undefined,
    commission_rate: parseFloat(document.getElementById('cfg-commission').value) || undefined,
  }
  await api('PATCH', `/admin/api/api-configs/${id}`, body)
  toast('Configuração salva ✓', 'success')
  closeModal()
  renderApiConfigs(document.getElementById('content-area'))
}

function closeModal() {
  document.getElementById('modal-container').innerHTML = ''
}

// ── QUEUE ─────────────────────────────────────────────────
async function renderQueue(area) {
  const data = await api('GET', '/admin/api/queue')
  if (!data) return
  const statusBadge = s => s === 'pending' ? badge(s,'yellow') : s === 'done' ? badge(s,'green') : badge(s,'red')
  const rows = data.map(j => `
    <tr class="hover:bg-slate-50">
      <td class="table-td text-xs text-slate-500">${j.id}</td>
      <td class="table-td font-medium text-sm">${j.product_name}</td>
      <td class="table-td text-sm">${j.store_name}</td>
      <td class="table-td text-xs text-slate-500">${j.external_id}</td>
      <td class="table-td">
        <span class="text-sm font-bold ${j.priority<=2?'text-red-600':'text-slate-700'}">${j.priority}</span>
        ${j.priority<=2?'<span class="text-xs text-red-500 ml-1">(urgente)</span>':''}
      </td>
      <td class="table-td">${statusBadge(j.status)}</td>
      <td class="table-td text-xs text-slate-400">${fDateTime(j.scheduled_for)}</td>
      <td class="table-td text-xs text-slate-400">${j.attempts}</td>
    </tr>
  `).join('')

  area.innerHTML = `
    <div class="section">
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h3 class="font-bold text-slate-800">Fila de Atualização de Preços</h3>
          <button onclick="processQueue()" class="btn-primary">⚡ Processar Agora</button>
        </div>
        ${data.length === 0
          ? `<div class="py-16 text-center text-slate-400"><div class="text-4xl mb-3">[OK]</div>Fila vazia — todos os preços atualizados</div>`
          : `<div class="overflow-x-auto"><table class="w-full">
              <thead><tr>
                <th class="table-th">ID</th><th class="table-th">Produto</th>
                <th class="table-th">Loja</th><th class="table-th">External ID</th>
                <th class="table-th">Prioridade</th><th class="table-th">Status</th>
                <th class="table-th">Agendado</th><th class="table-th">Tentativas</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table></div>`}
      </div>
    </div>
  `
}

async function processQueue() {
  const syncStatus = document.getElementById('sync-status')
  syncStatus.classList.remove('hidden')
  syncStatus.classList.add('flex')
  const data = await api('POST', '/api/cron/process-queue')
  syncStatus.classList.add('hidden')
  syncStatus.classList.remove('flex')
  toast(`Processados: ${data?.processed || 0} jobs`, 'success')
  renderQueue(document.getElementById('content-area'))
}

// ── ANALYTICS ─────────────────────────────────────────────
async function renderAnalytics(area) {
  const data = await api('GET', '/admin/api/clicks?days=7')
  if (!data) return
  area.innerHTML = `
    <div class="section">
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div class="stat-card">
          <h3 class="font-bold text-slate-800 mb-4">📈 Cliques por dia (7 dias)</h3>
          <canvas id="analytics-daily" height="200"></canvas>
        </div>
        <div class="stat-card">
          <h3 class="font-bold text-slate-800 mb-4">🏆 Cliques por loja</h3>
          <canvas id="analytics-stores" height="200"></canvas>
        </div>
        <div class="stat-card col-span-full">
          <h3 class="font-bold text-slate-800 mb-4">🔥 Produtos mais clicados</h3>
          <div class="space-y-2">
            ${(data.byProduct || []).map((p, i) => `
              <div class="flex items-center gap-3">
                <span class="text-lg font-black text-slate-300 w-6">${i+1}</span>
                <div class="flex-1 bg-slate-100 rounded-full h-6 overflow-hidden">
                  <div class="h-6 bg-gradient-to-r from-blue-500 to-blue-600 rounded-full flex items-center px-3" style="width:${Math.max(5, (p.clicks/((data.byProduct[0]?.clicks)||1))*100)}%">
                    <span class="text-white text-xs font-semibold truncate">${p.name}</span>
                  </div>
                </div>
                <span class="text-sm font-bold text-slate-700 w-12 text-right">${p.clicks}</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </div>
  `

  // Gráfico diário
  if (data.byDay?.length) {
    if (App.charts.daily) App.charts.daily.destroy()
    App.charts.daily = new Chart(document.getElementById('analytics-daily'), {
      type: 'line',
      data: {
        labels: data.byDay.map(d => new Date(d.day).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})),
        datasets: [{ label:'Cliques', data: data.byDay.map(d=>d.clicks),
          borderColor:'#3b82f6', backgroundColor:'rgba(59,130,246,0.1)',
          fill:true, tension:.3, pointRadius:4 }]
      },
      options: { responsive:true, plugins:{legend:{display:false}}, scales:{y:{beginAtZero:true}} }
    })
  }

  // Gráfico lojas
  if (data.byStore?.length) {
    if (App.charts.stores) App.charts.stores.destroy()
    App.charts.stores = new Chart(document.getElementById('analytics-stores'), {
      type: 'doughnut',
      data: {
        labels: data.byStore.map(s => s.store),
        datasets: [{ data: data.byStore.map(s=>s.clicks),
          backgroundColor: ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316','#84cc16'] }]
      },
      options: { responsive:true, plugins:{legend:{position:'right'}} }
    })
  }
}

// ── USERS — 2 abas: Clientes + Admins ────────────────────
const PERMS_LIST = [
  { key:'dashboard.view',    label:'📊 Ver Dashboard'       },
  { key:'products.view',     label:'📦 Ver Produtos'         },
  { key:'products.edit',     label:'📦 Editar Produtos'      },
  { key:'offers.view',       label:'💰 Ver Ofertas'          },
  { key:'offers.edit',       label:'💰 Editar Ofertas'       },
  { key:'stores.view',       label:'🏪 Ver Lojas'            },
  { key:'stores.edit',       label:'🏪 Editar Lojas'         },
  { key:'api.view',          label:'🔌 Ver APIs'             },
  { key:'api.edit',          label:'🔌 Editar APIs'          },
  { key:'editorial.view',    label:'🤖 Ver IA Editorial'     },
  { key:'editorial.edit',    label:'🤖 Usar IA Editorial'    },
  { key:'users.view',        label:'👥 Ver Usuários'         },
  { key:'users.edit',        label:'👥 Editar Usuários'      },
  { key:'admins.manage',     label:'🔑 Gerenciar Admins'     },
  { key:'analytics.view',    label:'📈 Ver Analytics'        },
  { key:'footer.edit',       label:'🦶 Editar Rodapé'        },
  { key:'social.view',       label:'📣 Ver Social Media'     },
  { key:'social.edit',       label:'📣 Publicar Social Media'},
]

const ROLES_MAP = {
  super_admin: { label:'Super Admin', color:'red'    },
  admin:       { label:'Admin',       color:'yellow' },
  moderator:   { label:'Moderador',   color:'blue'   },
  editor:      { label:'Editor',      color:'green'  },
}

function rolePermissions(role) {
  if (role === 'super_admin') return PERMS_LIST.map(p => p.key)
  if (role === 'admin')       return PERMS_LIST.map(p => p.key).filter(k => k !== 'admins.manage')
  if (role === 'moderator')   return ['dashboard.view','products.view','offers.view','stores.view','users.view','analytics.view']
  if (role === 'editor')      return ['dashboard.view','products.view','products.edit','editorial.view','editorial.edit','footer.edit']
  return []
}

let _usersTab = 'clients'

async function renderUsers(area) {
  area.innerHTML = `
  <div class="space-y-4">
    <!-- Abas -->
    <div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      <div class="flex border-b border-slate-100">
        <button id="utab-clients" onclick="switchUsersTab('clients')"
          class="flex-1 py-3.5 text-sm font-bold text-blue-600 border-b-2 border-blue-600 transition-all">
          👥 Clientes / Membros
        </button>
        <button id="utab-admins" onclick="switchUsersTab('admins')"
          class="flex-1 py-3.5 text-sm font-bold text-slate-400 border-b-2 border-transparent hover:text-slate-600 transition-all">
          🔑 Administradores
        </button>
      </div>
    </div>
    <!-- Conteúdo da aba ativa -->
    <div id="users-tab-content"></div>
  </div>`
  switchUsersTab(_usersTab)
}

function switchUsersTab(tab) {
  _usersTab = tab
  const tc  = document.getElementById('utab-clients')
  const ta  = document.getElementById('utab-admins')
  if (!tc || !ta) return
  const activeClass   = 'flex-1 py-3.5 text-sm font-bold text-blue-600 border-b-2 border-blue-600 transition-all'
  const inactiveClass = 'flex-1 py-3.5 text-sm font-bold text-slate-400 border-b-2 border-transparent hover:text-slate-600 transition-all'
  tc.className = tab === 'clients' ? activeClass : inactiveClass
  ta.className = tab === 'admins'  ? activeClass : inactiveClass
  const content = document.getElementById('users-tab-content')
  if (tab === 'clients') renderMembersTab(content)
  else                   renderAdminsTab(content)
}

// ── ABA CLIENTES ──────────────────────────────────────────
async function renderMembersTab(area, page = 1, q = '', filter = '') {
  area.innerHTML = spin
  const qs   = new URLSearchParams({ page, q, filter }).toString()
  const data = await api('GET', `/admin/api/members?${qs}`)
  if (!data) return

  const providerBadge = p => p === 'google'
    ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-700"><svg class="w-3 h-3" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>Google</span>`
    : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-600"> Email</span>`

  const rows = (data.members || []).length > 0
    ? data.members.map(u => `
      <tr class="hover:bg-slate-50 transition-colors">
        <td class="table-td">
          <div class="flex items-center gap-3">
            ${u.avatar_url
              ? `<img src="${u.avatar_url}" class="w-9 h-9 rounded-full object-cover border border-slate-200" alt="">`
              : `<div class="w-9 h-9 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center text-white font-bold text-sm">${(u.full_name||u.email||'?')[0].toUpperCase()}</div>`}
            <div>
              <div class="font-semibold text-sm text-slate-800">${u.full_name || '—'}</div>
              <div class="text-xs text-slate-400">${u.email}</div>
            </div>
          </div>
        </td>
        <td class="table-td">${providerBadge(u.auth_provider)}</td>
        <td class="table-td text-center">
          ${u.notify_email ? '<span class="text-green-500 text-lg" title="Alertas de preço">🔔</span>' : '<span class="text-slate-300 text-lg">🔔</span>'}
          ${u.offers_email ? '<span class="text-blue-500 text-lg" title="Ofertas por email">📧</span>' : '<span class="text-slate-300 text-lg">📧</span>'}
        </td>
        <td class="table-td text-xs text-slate-500">${u.login_count || 0}x</td>
        <td class="table-td text-xs text-slate-500">${fDateTime(u.last_login_at)}</td>
        <td class="table-td text-xs text-slate-500">${fDate(u.created_at)}</td>
        <td class="table-td">
          <div class="flex gap-1.5">
            <button onclick='openEditMemberModal(${JSON.stringify(u)})' class="btn-secondary text-xs px-2.5 py-1.5">✏️ Editar</button>
            <button onclick="blockMember('${u.id}', ${!u.session_expires_at})" class="text-xs px-2.5 py-1.5 rounded-lg ${!u.session_expires_at ? 'bg-green-50 text-green-600 hover:bg-green-100' : 'bg-red-50 text-red-600 hover:bg-red-100'} transition-all">
              ${!u.session_expires_at ? '✅ Ativar' : '🚫 Bloquear'}
            </button>
          </div>
        </td>
      </tr>`).join('')
    : `<tr><td colspan="7" class="py-16 text-center text-slate-400">Nenhum membro cadastrado ainda</td></tr>`

  const filterOpts = [
    ['','Todos'],['google','Google'],['email','Email'],['offers','Quer Ofertas'],['notified','Alertas Ativos']
  ].map(([v,l]) => `<option value="${v}" ${filter===v?'selected':''}>${l}</option>`).join('')

  area.innerHTML = `
  <div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
    <!-- Toolbar -->
    <div class="px-5 py-4 border-b border-slate-100 flex flex-wrap items-center gap-3">
      <div class="flex-1 min-w-[200px]">
        <input id="members-search" type="text" value="${q}" placeholder="Buscar por nome ou email..."
          class="input w-full"
          onkeydown="if(event.key==='Enter'){const v=this.value;renderMembersTab(document.getElementById('users-tab-content'),1,v,document.getElementById('members-filter').value)}">
      </div>
      <select id="members-filter" class="input w-44"
        onchange="renderMembersTab(document.getElementById('users-tab-content'),1,document.getElementById('members-search').value,this.value)">
        ${filterOpts}
      </select>
      <button onclick="renderMembersTab(document.getElementById('users-tab-content'),1,document.getElementById('members-search').value,document.getElementById('members-filter').value)"
        class="btn-primary">🔍 Buscar</button>
      <span class="text-sm text-slate-500 ml-auto">${data.total || 0} membros</span>
    </div>
    <!-- Tabela -->
    <div class="overflow-x-auto">
      <table class="w-full">
        <thead><tr>
          <th class="table-th">Membro</th>
          <th class="table-th">Provedor</th>
          <th class="table-th text-center">Notif.</th>
          <th class="table-th">Logins</th>
          <th class="table-th">Último login</th>
          <th class="table-th">Cadastro</th>
          <th class="table-th">Ações</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${renderPagination(page, data.total, data.per_page, p => `renderMembersTab(document.getElementById('users-tab-content'),${p},'${q}','${filter}')`)}
  </div>`
}

function openEditMemberModal(u) {
  document.getElementById('modal-container').innerHTML = `
  <div id="edit-member-modal" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
    <div class="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden">
      <div class="bg-gradient-to-r from-blue-600 to-blue-700 px-6 py-5 flex items-center justify-between">
        <div class="flex items-center gap-3">
          ${u.avatar_url
            ? `<img src="${u.avatar_url}" class="w-10 h-10 rounded-full border-2 border-white/30">`
            : `<div class="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center text-white font-bold">${(u.full_name||u.email||'?')[0].toUpperCase()}</div>`}
          <div>
            <div class="text-white font-bold">${u.full_name || 'Sem nome'}</div>
            <div class="text-blue-200 text-xs">${u.email}</div>
          </div>
        </div>
        <button onclick="document.getElementById('edit-member-modal').remove()" class="text-white/70 hover:text-white text-xl leading-none">✕</button>
      </div>
      <div class="p-6 space-y-4">
        <div>
          <label class="block text-xs font-semibold text-slate-600 mb-1.5">Nome completo</label>
          <input type="text" id="em-name" value="${u.full_name||''}" class="input" placeholder="Nome do usuário">
        </div>
        <div>
          <label class="block text-xs font-semibold text-slate-600 mb-1.5">Provedor</label>
          <div class="px-3 py-2 bg-slate-50 rounded-xl text-sm text-slate-500">${u.auth_provider === 'google' ? '🔵 Google OAuth' : '✉️ Email/Senha'}</div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <label class="flex items-center gap-2.5 p-3 rounded-xl border border-slate-200 hover:border-blue-400 cursor-pointer transition-all">
            <input type="checkbox" id="em-notify" ${u.notify_email ? 'checked' : ''} class="w-4 h-4 rounded accent-blue-600">
            <div>
              <div class="text-sm font-semibold text-slate-700">🔔 Alertas</div>
              <div class="text-xs text-slate-400">Alertas de preço</div>
            </div>
          </label>
          <label class="flex items-center gap-2.5 p-3 rounded-xl border border-slate-200 hover:border-blue-400 cursor-pointer transition-all">
            <input type="checkbox" id="em-offers" ${u.offers_email ? 'checked' : ''} class="w-4 h-4 rounded accent-blue-600">
            <div>
              <div class="text-sm font-semibold text-slate-700">📧 Ofertas</div>
              <div class="text-xs text-slate-400">Email de promos</div>
            </div>
          </label>
        </div>
        <div id="em-error" class="hidden text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2"></div>
      </div>
      <div class="px-6 pb-6 flex gap-3">
        <button onclick="document.getElementById('edit-member-modal').remove()" class="btn-secondary flex-1">Cancelar</button>
        <button onclick="saveMember('${u.id}')" class="btn-primary flex-1">💾 Salvar</button>
      </div>
    </div>
  </div>`
}

async function saveMember(id) {
  const name         = document.getElementById('em-name')?.value?.trim()
  const notify_email = document.getElementById('em-notify')?.checked ? 1 : 0
  const offers_email = document.getElementById('em-offers')?.checked ? 1 : 0
  const err          = document.getElementById('em-error')
  const r = await api('PATCH', `/admin/api/members/${id}`, { full_name: name, notify_email, offers_email })
  if (!r?.ok) { err.textContent = 'Erro ao salvar.'; err.classList.remove('hidden'); return }
  document.getElementById('edit-member-modal')?.remove()
  toast('Membro atualizado ✓', 'success')
  renderMembersTab(document.getElementById('users-tab-content'))
}

async function blockMember(id, activate) {
  const action = activate ? 'ativar' : 'bloquear'
  if (!confirm(`Confirmar: ${action} este membro?`)) return
  await api('PATCH', `/admin/api/members/${id}`, { status: activate ? 'active' : 'blocked' })
  toast(activate ? 'Membro ativado ✓' : 'Membro bloqueado', activate ? 'success' : 'info')
  renderMembersTab(document.getElementById('users-tab-content'))
}

// ── ABA ADMINS ────────────────────────────────────────────
async function renderAdminsTab(area) {
  area.innerHTML = spin
  const admins = await api('GET', '/admin/api/admin-users')
  if (!admins) return

  const rows = admins.length > 0
    ? admins.map(a => {
        const rm = ROLES_MAP[a.role] || { label: a.role, color: 'blue' }
        const perms = a.permissions ? a.permissions.split(',') : []
        return `
        <tr class="hover:bg-slate-50 transition-colors">
          <td class="table-td">
            <div class="flex items-center gap-3">
              <div class="w-9 h-9 rounded-xl bg-gradient-to-br from-slate-600 to-slate-800 flex items-center justify-center text-white font-bold text-sm">
                ${(a.name||a.email||'?')[0].toUpperCase()}
              </div>
              <div>
                <div class="font-semibold text-sm text-slate-800">${a.name}</div>
                <div class="text-xs text-slate-400">${a.email}</div>
              </div>
            </div>
          </td>
          <td class="table-td">${badge(rm.label, rm.color)}</td>
          <td class="table-td">${a.status==='active' ? badge('Ativo','green') : badge('Inativo','red')}</td>
          <td class="table-td">
            <div class="flex flex-wrap gap-1 max-w-xs">
              ${perms.slice(0,4).map(p => `<span class="text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">${p.split('.')[0]}</span>`).join('')}
              ${perms.length > 4 ? `<span class="text-xs text-slate-400">+${perms.length-4}</span>` : ''}
            </div>
          </td>
          <td class="table-td text-xs text-slate-500">${fDateTime(a.last_login_at)}</td>
          <td class="table-td text-xs text-slate-500">${fDate(a.created_at)}</td>
          <td class="table-td">
            <div class="flex gap-1.5">
              <button onclick='openEditAdminModal(${JSON.stringify(a)})' class="btn-secondary text-xs px-2.5 py-1.5">✏️ Editar</button>
              <button onclick="deleteAdminUser('${a.id}','${a.name}')" class="btn-danger text-xs px-2.5 py-1.5">🗑️</button>
            </div>
          </td>
        </tr>`
      }).join('')
    : `<tr><td colspan="7" class="py-16 text-center text-slate-400">Nenhum administrador cadastrado ainda</td></tr>`

  area.innerHTML = `
  <div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
    <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
      <div>
        <h3 class="font-bold text-slate-800">Administradores <span class="text-slate-400 font-normal text-sm ml-1">${admins.length} cadastrados</span></h3>
        <p class="text-xs text-slate-400 mt-0.5">Gerencie o acesso ao painel admin e as permissões de cada usuário</p>
      </div>
      <button onclick="openNewAdminModal()" class="btn-primary">+ Novo Admin</button>
    </div>
    <div class="overflow-x-auto">
      <table class="w-full">
        <thead><tr>
          <th class="table-th">Administrador</th>
          <th class="table-th">Cargo</th>
          <th class="table-th">Status</th>
          <th class="table-th">Permissões</th>
          <th class="table-th">Último acesso</th>
          <th class="table-th">Criado em</th>
          <th class="table-th">Ações</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`
}

function openNewAdminModal() { openAdminModal(null) }
function openEditAdminModal(a) { openAdminModal(a) }

function openAdminModal(a) {
  const isEdit = !!a
  const currentPerms = a?.permissions ? a.permissions.split(',') : (a ? rolePermissions(a.role) : rolePermissions('moderator'))

  const permsHTML = PERMS_LIST.map(p => `
    <label class="flex items-center gap-2 cursor-pointer p-2 rounded-lg hover:bg-slate-50 transition-colors">
      <input type="checkbox" name="aperm" value="${p.key}"
        ${currentPerms.includes(p.key) ? 'checked' : ''}
        class="w-4 h-4 rounded accent-blue-600">
      <span class="text-sm text-slate-700">${p.label}</span>
    </label>`).join('')

  const rolesHTML = Object.entries(ROLES_MAP).map(([v, r]) =>
    `<option value="${v}" ${a?.role===v?'selected':''}>${r.label}</option>`).join('')

  document.getElementById('modal-container').innerHTML = `
  <div id="admin-modal" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
    <div class="bg-white rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
      <!-- Header -->
      <div class="bg-gradient-to-r from-slate-800 to-slate-900 px-6 py-5 flex items-center justify-between shrink-0">
        <div>
          <h3 class="text-white font-black text-lg">${isEdit ? '✏️ Editar Admin' : '+ Novo Administrador'}</h3>
          <p class="text-slate-400 text-xs mt-0.5">${isEdit ? a.email : 'Configure acesso e permissões'}</p>
        </div>
        <button onclick="document.getElementById('admin-modal').remove()" class="text-white/60 hover:text-white text-2xl leading-none">✕</button>
      </div>

      <!-- Scroll body -->
      <div class="overflow-y-auto flex-1 p-6 space-y-5">

        <!-- Dados básicos -->
        <div class="grid grid-cols-2 gap-4">
          <div class="col-span-2">
            <label class="block text-xs font-semibold text-slate-600 mb-1.5">Nome completo *</label>
            <input type="text" id="am-name" value="${a?.name||''}" class="input" placeholder="Ex: João Silva">
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-600 mb-1.5">Email *</label>
            <input type="email" id="am-email" value="${a?.email||''}" class="input" placeholder="joao@empresa.com">
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-600 mb-1.5">${isEdit ? 'Nova senha (deixe em branco para manter)' : 'Senha *'}</label>
            <input type="password" id="am-password" class="input" placeholder="••••••••" autocomplete="new-password">
          </div>
        </div>

        <!-- Cargo -->
        <div>
          <label class="block text-xs font-semibold text-slate-600 mb-1.5">Cargo / Role</label>
          <select id="am-role" class="input" onchange="applyRolePreset(this.value)">
            ${rolesHTML}
          </select>
          <p class="text-xs text-slate-400 mt-1">Ao selecionar um cargo, as permissões padrão serão preenchidas automaticamente.</p>
        </div>

        ${isEdit ? `
        <div>
          <label class="block text-xs font-semibold text-slate-600 mb-1.5">Status</label>
          <select id="am-status" class="input">
            <option value="active" ${a.status==='active'?'selected':''}>✅ Ativo</option>
            <option value="inactive" ${a.status==='inactive'?'selected':''}>⏸️ Inativo</option>
          </select>
        </div>` : ''}

        <!-- Permissões -->
        <div>
          <div class="flex items-center justify-between mb-2">
            <label class="text-xs font-semibold text-slate-600">Permissões individuais</label>
            <div class="flex gap-2">
              <button type="button" onclick="setAllPerms(true)"  class="text-xs text-blue-600 hover:underline">Marcar tudo</button>
              <button type="button" onclick="setAllPerms(false)" class="text-xs text-slate-400 hover:underline">Desmarcar tudo</button>
            </div>
          </div>
          <div class="border border-slate-200 rounded-xl p-3 grid grid-cols-2 gap-0.5 max-h-56 overflow-y-auto">
            ${permsHTML}
          </div>
        </div>

        <div id="am-error" class="hidden text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2"></div>
      </div>

      <!-- Footer -->
      <div class="px-6 py-4 border-t border-slate-100 flex gap-3 shrink-0">
        <button onclick="document.getElementById('admin-modal').remove()" class="btn-secondary flex-1">Cancelar</button>
        <button onclick="saveAdminUser('${a?.id||''}')" class="btn-primary flex-1">${isEdit ? '💾 Salvar' : '✅ Criar Admin'}</button>
      </div>
    </div>
  </div>`
}

function applyRolePreset(role) {
  const perms = rolePermissions(role)
  document.querySelectorAll('input[name="aperm"]').forEach(cb => {
    cb.checked = perms.includes(cb.value)
  })
}

function setAllPerms(checked) {
  document.querySelectorAll('input[name="aperm"]').forEach(cb => { cb.checked = checked })
}

async function saveAdminUser(id) {
  const name     = document.getElementById('am-name')?.value?.trim()
  const email    = document.getElementById('am-email')?.value?.trim()
  const password = document.getElementById('am-password')?.value
  const role     = document.getElementById('am-role')?.value
  const status   = document.getElementById('am-status')?.value
  const err      = document.getElementById('am-error')
  const permissions = [...document.querySelectorAll('input[name="aperm"]:checked')].map(cb => cb.value)

  if (!name)  { err.textContent='Nome obrigatório.';  err.classList.remove('hidden'); return }
  if (!email) { err.textContent='Email obrigatório.'; err.classList.remove('hidden'); return }

  const isEdit = !!id
  const method = isEdit ? 'PATCH' : 'POST'
  const url    = isEdit ? `/admin/api/admin-users/${id}` : '/admin/api/admin-users'
  const body = { name, email, role, permissions }
  if (status)                body.status   = status
  if (password?.length >= 6) body.password = password
  if (!isEdit && !password)  { err.textContent='Senha obrigatória.'; err.classList.remove('hidden'); return }
  if (!isEdit) body.password = password

  const r = await api(method, url, body)
  if (!r?.ok) {
    err.textContent = r?.error || 'Erro ao salvar.'
    err.classList.remove('hidden')
    return
  }
  document.getElementById('admin-modal')?.remove()
  toast(isEdit ? 'Admin atualizado ✓' : 'Admin criado com sucesso ✓', 'success')
  renderAdminsTab(document.getElementById('users-tab-content'))
}

async function deleteAdminUser(id, name) {
  if (!confirm(`Remover o admin "${name}"? Esta ação não pode ser desfeita.`)) return
  await api('DELETE', `/admin/api/admin-users/${id}`)
  toast('Admin removido', 'info')
  renderAdminsTab(document.getElementById('users-tab-content'))
}

// Mantém compatibilidade com funções antigas
async function setUserStatus(id, status) {
  await api('PATCH', `/admin/api/users/${id}/status`, { status })
  toast(status === 'active' ? 'Usuário ativado ✓' : 'Usuário bloqueado', status === 'active' ? 'success' : 'info')
}
async function deleteUser(id) {
  if (!confirm('Excluir este usuário? Esta ação não pode ser desfeita.')) return
  await api('DELETE', `/admin/api/users/${id}`)
  toast('Usuário excluído', 'info')
}

// ── Pagination helper ─────────────────────────────────────
function renderPagination(page, total, perPage, onPage) {
  const totalPages = Math.ceil(total / perPage)
  if (totalPages <= 1) return ''
  const btns = []
  for (let i = 1; i <= Math.min(totalPages, 7); i++) {
    btns.push(`<button onclick="(${onPage.toString()})(${i})" class="px-3 py-1.5 text-sm rounded-lg border ${i===page?'bg-blue-600 text-white border-blue-600':'border-slate-200 hover:bg-slate-50'}">${i}</button>`)
  }
  return `<div class="flex items-center gap-2 px-5 py-4 border-t border-slate-100">${btns.join('')}<span class="text-sm text-slate-500 ml-2">${total} total</span></div>`
}

// ── SOCIAL MEDIA ──────────────────────────────────────────
// Estado local da seção Social
const Social = {
  tab: 'accounts',       // 'accounts' | 'create' | 'schedule' | 'history'
  accounts: [],
  aiLoading: false,
}

const PLATFORM_META = {
  tiktok:    { label: 'TikTok',     color: 'from-black to-slate-800',      icon: '🎵', textLimit: 2200 },
  instagram: { label: 'Instagram',  color: 'from-pink-500 to-purple-600',  icon: '📸', textLimit: 2200 },
  youtube:   { label: 'YouTube',    color: 'from-red-500 to-red-700',      icon: '▶️', textLimit: 5000 },
  linkedin:  { label: 'LinkedIn',   color: 'from-blue-700 to-blue-900',    icon: '💼', textLimit: 3000 },
  facebook:  { label: 'Facebook',   color: 'from-blue-600 to-blue-800',    icon: '👍', textLimit: 63206 },
  threads:   { label: 'Threads',    color: 'from-slate-700 to-slate-900',  icon: '🧵', textLimit: 500 },
  x:         { label: 'X (Twitter)',color: 'from-slate-800 to-black',      icon: '✖️', textLimit: 280 },
  pinterest: { label: 'Pinterest',  color: 'from-red-500 to-red-700',      icon: '📌', textLimit: 500 },
  reddit:    { label: 'Reddit',     color: 'from-orange-500 to-orange-700',icon: '🤖', textLimit: 40000 },
  bluesky:   { label: 'Bluesky',   color: 'from-sky-400 to-sky-600',      icon: '🦋', textLimit: 300 },
}

async function renderSocial(area) {
  area.innerHTML = `
    <div class="section">
      <!-- Abas -->
      <div class="flex gap-1 bg-slate-100 rounded-xl p-1 mb-6 w-fit">
        ${[
          { id: 'accounts', label: '🔗 Contas Conectadas' },
          { id: 'create',   label: '✏️ Criar Post' },
          { id: 'schedule', label: '📅 Agenda' },
          { id: 'history',  label: '📋 Histórico' },
        ].map(t => `
          <button onclick="switchSocialTab('${t.id}')" id="social-tab-${t.id}"
            class="px-4 py-2 rounded-lg text-sm font-medium transition-all ${Social.tab === t.id ? 'bg-white text-blue-700 shadow-sm font-semibold' : 'text-slate-600 hover:text-slate-800'}">
            ${t.label}
          </button>
        `).join('')}
      </div>
      <!-- Conteúdo das abas -->
      <div id="social-tab-content"></div>
    </div>
  `
  await loadSocialTab(Social.tab)
}

function switchSocialTab(tab) {
  Social.tab = tab
  document.querySelectorAll('[id^="social-tab-"]').forEach(el => {
    const isActive = el.id === `social-tab-${tab}`
    el.className = `px-4 py-2 rounded-lg text-sm font-medium transition-all ${isActive ? 'bg-white text-blue-700 shadow-sm font-semibold' : 'text-slate-600 hover:text-slate-800'}`
  })
  loadSocialTab(tab)
}

async function loadSocialTab(tab) {
  const content = document.getElementById('social-tab-content')
  if (!content) return
  content.innerHTML = `<div class="flex items-center justify-center py-16"><div class="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div></div>`

  if (tab === 'accounts')  await renderSocialAccounts(content)
  if (tab === 'create')    await renderSocialCreate(content)
  if (tab === 'schedule')  await renderSocialSchedule(content)
  if (tab === 'history')   await renderSocialHistory(content)
}

// ── ABA: Contas Conectadas ────────────────────────────────
async function renderSocialAccounts(area) {
  const data = await api('GET', '/admin/api/social-accounts')
  Social.accounts = data || []

  const platformBadge = (p) => {
    const m = PLATFORM_META[p] || { label: p, icon: '🌐' }
    return `<span class="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-gradient-to-r ${m.color || 'from-slate-500 to-slate-700'} text-white">${m.icon} ${m.label}</span>`
  }

  const statusBadge = (acc) => {
    if (!acc.last_test_at) return `<span class="text-xs text-slate-400">Não testado</span>`
    return acc.last_test_ok
      ? `<span class="text-xs text-green-600 font-semibold"> Conectado</span>`
      : `<span class="text-xs text-red-500 font-semibold" title="${acc.last_test_msg || ''}"> Falhou</span>`
  }

  area.innerHTML = `
    <div class="flex items-center justify-between mb-4">
      <div class="text-sm text-slate-500">${Social.accounts.length} conta(s) cadastrada(s)</div>
      <button onclick="openSocialAccountModal()" class="btn-primary text-sm">+ Conectar Conta</button>
    </div>

    ${!Social.accounts.length ? `
      <div class="text-center py-16 bg-white rounded-2xl border border-dashed border-slate-200">
        <div class="text-4xl mb-3">📡</div>
        <div class="text-slate-600 font-medium mb-1">Nenhuma conta conectada</div>
        <div class="text-slate-400 text-sm mb-4">Conecte uma rede social para começar a publicar</div>
        <button onclick="openSocialAccountModal()" class="btn-primary text-sm">+ Conectar Primeira Conta</button>
      </div>
    ` : `
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        ${Social.accounts.map(acc => `
          <div class="bg-white rounded-2xl border border-slate-100 p-5 shadow-sm hover:shadow-md transition-shadow">
            <div class="flex items-start justify-between mb-3">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-xl bg-gradient-to-br ${(PLATFORM_META[acc.platform] || {}).color || 'from-slate-400 to-slate-600'} flex items-center justify-center text-lg shadow">
                  ${(PLATFORM_META[acc.platform] || { icon: '🌐' }).icon}
                </div>
                <div>
                  <div class="font-semibold text-slate-800 text-sm">${acc.account_name}</div>
                  <div class="flex items-center gap-2 mt-0.5">${platformBadge(acc.platform)}</div>
                </div>
              </div>
              <div class="flex items-center gap-1">
                <button onclick="testSocialAccount('${acc.id}', this)" class="text-xs text-blue-600 hover:bg-blue-50 px-2 py-1 rounded-lg transition-colors font-medium">Testar</button>
                <button onclick="openSocialAccountModal('${acc.id}')" class="text-xs text-slate-500 hover:bg-slate-100 px-2 py-1 rounded-lg transition-colors">Editar</button>
                <button onclick="deleteSocialAccount('${acc.id}', this.dataset.name)" data-name="${acc.account_name}" class="text-xs text-red-400 hover:bg-red-50 px-2 py-1 rounded-lg transition-colors">Remover</button>
              </div>
            </div>

            <div class="flex items-center justify-between text-xs text-slate-400">
              <div class="flex items-center gap-3">
                ${acc.is_active
                  ? '<span class="text-green-600 font-medium">● Ativa</span>'
                  : '<span class="text-slate-400">○ Inativa</span>'}
                ${statusBadge(acc)}
              </div>
              ${acc.last_test_msg && !acc.last_test_ok ? `<div class="text-red-400 text-xs truncate max-w-[200px]" title="${acc.last_test_msg}">${acc.last_test_msg}</div>` : ''}
              <div>${acc.last_test_at ? 'Testado ' + fDate(acc.last_test_at) : ''}</div>
            </div>
          </div>
        `).join('')}
      </div>
    `}

    <!-- Guia de configuração por plataforma -->
    <div class="mt-6 bg-blue-50 border border-blue-100 rounded-2xl p-5">
      <h4 class="font-semibold text-blue-800 mb-3 text-sm">📖 Guia rápido de tokens por plataforma</h4>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-blue-700">
        <div>
          <div class="font-semibold mb-1">📸 Instagram (Graph API)</div>
          <ol class="list-decimal ml-4 space-y-0.5 text-blue-600">
            <li>Crie um App no Meta for Developers</li>
            <li>Adicione o produto "Instagram Graph API"</li>
            <li>Obtenha o <strong>Instagram User ID</strong> (ig_user_id)</li>
            <li>Gere um <strong>Page Access Token</strong> com permissões instagram_content_publish</li>
            <li>Converta para Long-Lived Token (60 dias)</li>
          </ol>
        </div>
        <div>
          <div class="font-semibold mb-1">👍 Facebook (Graph API)</div>
          <ol class="list-decimal ml-4 space-y-0.5 text-blue-600">
            <li>Mesmo App Meta acima</li>
            <li>Obtenha o <strong>Page ID</strong> da sua Página</li>
            <li>Gere <strong>Page Access Token</strong> com pages_publish</li>
            <li>Converta para Long-Lived Token</li>
          </ol>
        </div>
        <div>
          <div class="font-semibold mb-1">✖️ X/Twitter (API v2)</div>
          <ol class="list-decimal ml-4 space-y-0.5 text-blue-600">
            <li>Acesse developer.twitter.com</li>
            <li>Crie um projeto e App com permissão Read+Write</li>
            <li>Gere <strong>Bearer Token</strong> (para token_secret)</li>
            <li>Ou use OAuth 2.0 User Token (access_token)</li>
          </ol>
        </div>
        <div>
          <div class="font-semibold mb-1">💼 LinkedIn (API v2)</div>
          <ol class="list-decimal ml-4 space-y-0.5 text-blue-600">
            <li>Crie App em linkedin.com/developers</li>
            <li>Solicite acesso ao produto "Share on LinkedIn"</li>
            <li>OAuth 2.0: scope r_liteprofile + w_member_social</li>
            <li>Account ID = URN: urn:li:person:{id}</li>
          </ol>
        </div>
      </div>
    </div>
  `
}

async function testSocialAccount(id, btn) {
  const origText = btn.textContent
  btn.textContent = 'Testando...'
  btn.disabled = true
  const res = await api('POST', `/admin/api/social-accounts/${id}/test`)
  btn.textContent = origText
  btn.disabled = false
  if (!res) return
  toast(res.ok ? ` ${res.message}` : ` ${res.message}`, res.ok ? 'success' : 'error')
  await loadSocialTab('accounts')
}

async function deleteSocialAccount(id, name) {
  if (!confirm(`Remover a conta "${name}"? Todos os posts vinculados serão apagados.`)) return
  await api('DELETE', `/admin/api/social-accounts/${id}`)
  toast('Conta removida', 'info')
  await loadSocialTab('accounts')
}

function openSocialAccountModal(id = null) {
  const acc = id ? Social.accounts.find(a => a.id === id) : null
  const isEdit = !!acc

  document.getElementById('modal-container').innerHTML = `
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm" id="soc-acc-modal">
      <div class="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div class="flex items-center justify-between p-5 border-b border-slate-100">
          <h3 class="font-bold text-slate-800">${isEdit ? 'Editar Conta' : 'Conectar Conta de Rede Social'}</h3>
          <button onclick="document.getElementById('soc-acc-modal').remove()" class="text-slate-400 hover:text-slate-600 text-xl leading-none">&times;</button>
        </div>
        <div class="p-5 space-y-4">
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="label">Plataforma</label>
              <select id="soc-platform" class="input" ${isEdit ? 'disabled' : ''} onchange="updateSocialFormFields()">
                <option value="">Selecione...</option>
                ${Object.entries(PLATFORM_META).map(([k,v]) => `<option value="${k}" ${acc?.platform===k?'selected':''}>${v.icon} ${v.label}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="label">Nome/Handle da Conta</label>
              <input id="soc-name" class="input" placeholder="@handle ou Nome da Página" value="${acc?.account_name || ''}">
            </div>
          </div>

          <div id="soc-platform-fields" class="space-y-3">
            <!-- preenchido por updateSocialFormFields() -->
          </div>

          <div>
            <label class="label">Data de Expiração do Token (opcional)</label>
            <input type="datetime-local" id="soc-expires" class="input" value="${acc?.token_expires_at ? acc.token_expires_at.slice(0,16) : ''}">
          </div>

          ${isEdit ? `
            <div class="flex items-center gap-2">
              <input type="checkbox" id="soc-active" class="rounded" ${acc.is_active?'checked':''}>
              <label for="soc-active" class="text-sm text-slate-600">Conta ativa</label>
            </div>
          ` : ''}

          <p class="text-xs text-amber-600 bg-amber-50 rounded-lg p-3">
            ⚠️ Os tokens são armazenados de forma criptografada. Nunca compartilhe seus tokens de acesso.
            ${isEdit ? 'Deixe os campos de token em branco para manter os valores atuais.' : ''}
          </p>
        </div>
        <div class="flex gap-3 p-5 border-t border-slate-100">
          <button onclick="document.getElementById('soc-acc-modal').remove()" class="btn-secondary flex-1">Cancelar</button>
          <button onclick="saveSocialAccount(${id ? `'${id}'` : 'null'})" class="btn-primary flex-1">${isEdit ? 'Salvar' : 'Conectar'}</button>
        </div>
      </div>
    </div>
  `
  // Preenche campos dinâmicos após injetar o modal
  setTimeout(() => updateSocialFormFields(acc), 50)
}

function updateSocialFormFields(acc = null) {
  const platform = document.getElementById('soc-platform')?.value || acc?.platform
  const container = document.getElementById('soc-platform-fields')
  if (!container) return

  const fieldSets = {
    tiktok: [
      { id: 'soc-acc-id',     label: 'Open ID (tiktok_open_id)',       placeholder: '0000-0000-0000-0000' },
      { id: 'soc-access',     label: 'Access Token',                   placeholder: 'act.xxxxxx...', type: 'password' },
      { id: 'soc-refresh',    label: 'Refresh Token (opcional)',        placeholder: 'rft.xxxxxx...', type: 'password' },
    ],
    instagram: [
      { id: 'soc-ig-user',    label: 'Instagram User ID (ig_user_id)', placeholder: '17841400000000000' },
      { id: 'soc-access',     label: 'Page Access Token (Long-Lived)',  placeholder: 'EAABsbCS...', type: 'password' },
    ],
    youtube: [
      { id: 'soc-acc-id',     label: 'Channel ID',                     placeholder: 'UCxxxxxxxxxxxxxxxxxxxxxxxx' },
      { id: 'soc-access',     label: 'OAuth 2.0 Access Token',         placeholder: 'ya29.xxxxxxx...', type: 'password' },
      { id: 'soc-refresh',    label: 'Refresh Token',                  placeholder: '1//xxxxxxxx...', type: 'password' },
    ],
    linkedin: [
      { id: 'soc-acc-id',     label: 'Person/Org URN',                 placeholder: 'urn:li:person:AbcDef123' },
      { id: 'soc-access',     label: 'OAuth 2.0 Access Token',         placeholder: 'AQV...', type: 'password' },
      { id: 'soc-refresh',    label: 'Refresh Token (opcional)',        placeholder: 'AQW...', type: 'password' },
    ],
    facebook: [
      { id: 'soc-page-id',    label: 'Facebook Page ID',               placeholder: '111234567890' },
      { id: 'soc-access',     label: 'Page Access Token (Long-Lived)',  placeholder: 'EAABsbCS...', type: 'password' },
    ],
    threads: [
      { id: 'soc-ig-user',    label: 'Threads User ID',                placeholder: '17841400000000000' },
      { id: 'soc-access',     label: 'Access Token (Long-Lived)',       placeholder: 'THQAAxxxxxxx...', type: 'password' },
    ],
    x: [
      { id: 'soc-acc-id',     label: 'Account ID (opcional)',          placeholder: '123456789' },
      { id: 'soc-secret',     label: 'Bearer Token (API v2)',           placeholder: 'AAAAAAAAAAAAAAAAAAAAAml...', type: 'password' },
      { id: 'soc-access',     label: 'OAuth 2.0 User Access Token (opcional)', placeholder: '...', type: 'password' },
    ],
    pinterest: [
      { id: 'soc-acc-id',     label: 'Pinterest User ID / Board ID',   placeholder: '123456789012345678' },
      { id: 'soc-access',     label: 'Access Token (OAuth 2.0)',        placeholder: 'pina_xxxxxxxx...', type: 'password' },
      { id: 'soc-refresh',    label: 'Refresh Token (opcional)',        placeholder: 'pinr_xxxxxxxx...', type: 'password' },
    ],
    reddit: [
      { id: 'soc-acc-id',     label: 'Subreddit ou Username',          placeholder: 'r/meusubreddit ou u/username' },
      { id: 'soc-secret',     label: 'Client ID (Reddit App)',         placeholder: 'xxxxxxxxxxxxxx', type: 'password' },
      { id: 'soc-access',     label: 'OAuth 2.0 Access Token',         placeholder: 'bearer xxxxxxx...', type: 'password' },
      { id: 'soc-refresh',    label: 'Refresh Token',                  placeholder: 'xxxxxxxx...', type: 'password' },
    ],
    bluesky: [
      { id: 'soc-acc-id',     label: 'Handle (DID ou @usuario.bsky.social)', placeholder: '@usuario.bsky.social' },
      { id: 'soc-access',     label: 'App Password',                   placeholder: 'xxxx-xxxx-xxxx-xxxx', type: 'password' },
    ],
  }

  const fields = fieldSets[platform] || []
  container.innerHTML = fields.map(f => `
    <div>
      <label class="label">${f.label}</label>
      <input id="${f.id}" class="input ${f.type === 'password' ? 'font-mono' : ''}" type="${f.type || 'text'}" placeholder="${f.placeholder}">
    </div>
  `).join('')
}

async function saveSocialAccount(id) {
  const platform = document.getElementById('soc-platform')?.value
  const account_name = document.getElementById('soc-name')?.value?.trim()
  if (!account_name) { toast('Preencha o nome/handle da conta', 'error'); return }
  if (!id && !platform) { toast('Selecione a plataforma', 'error'); return }

  const get = (sel) => document.getElementById(sel)?.value?.trim() || ''

  const payload = {
    account_name,
    token_expires_at: get('soc-expires') || null,
  }
  if (!id) payload.platform = platform

  // Tokens conforme plataforma
  const plat = id ? (Social.accounts.find(a => a.id === id)?.platform) : platform
  if (plat === 'tiktok') {
    if (get('soc-acc-id'))  payload.account_id    = get('soc-acc-id')
    if (get('soc-access'))  payload.access_token   = get('soc-access')
    if (get('soc-refresh')) payload.refresh_token  = get('soc-refresh')
  } else if (plat === 'instagram') {
    if (get('soc-ig-user')) payload.ig_user_id    = get('soc-ig-user')
    if (get('soc-access'))  payload.access_token   = get('soc-access')
  } else if (plat === 'youtube') {
    if (get('soc-acc-id'))  payload.account_id    = get('soc-acc-id')
    if (get('soc-access'))  payload.access_token   = get('soc-access')
    if (get('soc-refresh')) payload.refresh_token  = get('soc-refresh')
  } else if (plat === 'linkedin') {
    if (get('soc-acc-id'))  payload.account_id    = get('soc-acc-id')
    if (get('soc-access'))  payload.access_token   = get('soc-access')
    if (get('soc-refresh')) payload.refresh_token  = get('soc-refresh')
  } else if (plat === 'facebook') {
    if (get('soc-page-id')) payload.page_id        = get('soc-page-id')
    if (get('soc-access'))  payload.access_token   = get('soc-access')
  } else if (plat === 'threads') {
    if (get('soc-ig-user')) payload.ig_user_id    = get('soc-ig-user')
    if (get('soc-access'))  payload.access_token   = get('soc-access')
  } else if (plat === 'x') {
    if (get('soc-acc-id'))  payload.account_id    = get('soc-acc-id')
    if (get('soc-secret'))  payload.token_secret   = get('soc-secret')
    if (get('soc-access'))  payload.access_token   = get('soc-access')
  } else if (plat === 'pinterest') {
    if (get('soc-acc-id'))  payload.account_id    = get('soc-acc-id')
    if (get('soc-access'))  payload.access_token   = get('soc-access')
    if (get('soc-refresh')) payload.refresh_token  = get('soc-refresh')
  } else if (plat === 'reddit') {
    if (get('soc-acc-id'))  payload.account_id    = get('soc-acc-id')
    if (get('soc-secret'))  payload.token_secret   = get('soc-secret')
    if (get('soc-access'))  payload.access_token   = get('soc-access')
    if (get('soc-refresh')) payload.refresh_token  = get('soc-refresh')
  } else if (plat === 'bluesky') {
    if (get('soc-acc-id'))  payload.account_id    = get('soc-acc-id')
    if (get('soc-access'))  payload.access_token   = get('soc-access')
  }

  if (id) {
    const active = document.getElementById('soc-active')
    if (active) payload.is_active = active.checked ? 1 : 0
    await api('PATCH', `/admin/api/social-accounts/${id}`, payload)
    toast('Conta atualizada ✓', 'success')
  } else {
    await api('POST', '/admin/api/social-accounts', payload)
    toast('Conta conectada ✓', 'success')
  }

  document.getElementById('soc-acc-modal')?.remove()
  await loadSocialTab('accounts')
}

// ── ABA: Criar Post ───────────────────────────────────────
async function renderSocialCreate(area) {
  // Garante que accounts estão carregadas
  if (!Social.accounts.length) {
    const data = await api('GET', '/admin/api/social-accounts')
    Social.accounts = data || []
  }

  const activeAccounts = Social.accounts.filter(a => a.is_active)

  area.innerHTML = `
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <!-- Formulário -->
      <div class="bg-white rounded-2xl border border-slate-100 p-6 shadow-sm space-y-4">
        <h3 class="font-bold text-slate-800">Novo Post</h3>

        <!-- Conta -->
        <div>
          <label class="label">Conta de destino</label>
          ${!activeAccounts.length
            ? `<div class="p-3 bg-amber-50 border border-amber-100 rounded-xl text-sm text-amber-700">
                Nenhuma conta ativa. <button onclick="switchSocialTab('accounts')" class="underline font-medium">Conectar conta →</button>
              </div>`
            : `<select id="post-account" class="input" onchange="updatePostPreview()">
                <option value="">Selecione a conta...</option>
                ${activeAccounts.map(a => `<option value="${a.id}" data-platform="${a.platform}">${(PLATFORM_META[a.platform]||{icon:'[Web]'}).icon} ${a.account_name} (${a.platform})</option>`).join('')}
              </select>`
          }
        </div>

        <!-- Texto -->
        <div>
          <div class="flex items-center justify-between mb-1">
            <label class="label mb-0">Texto do post</label>
            <span id="post-chars" class="text-xs text-slate-400">0 / ∞</span>
          </div>
          <textarea id="post-text" class="input min-h-[140px] resize-y" placeholder="Digite o texto do post..."
            oninput="updatePostPreview()"></textarea>
        </div>

        <!-- Hashtags -->
        <div>
          <label class="label">Hashtags</label>
          <input id="post-hashtags" class="input font-mono text-sm" placeholder="#oferta #desconto #kainowradar"
            oninput="updatePostPreview()">
        </div>

        <!-- Imagem URL -->
        <div>
          <label class="label">URL da Imagem (opcional)</label>
          <input id="post-image" class="input" placeholder="https://..." oninput="updatePostPreview()">
        </div>

        <!-- Link URL -->
        <div>
          <label class="label">Link (opcional)</label>
          <input id="post-link" class="input" placeholder="https://kainowradar.com/...">
        </div>

        <!-- IA Generate -->
        <div class="bg-gradient-to-r from-purple-50 to-blue-50 rounded-xl p-4 border border-purple-100">
          <div class="flex items-center justify-between mb-3">
            <div class="text-sm font-semibold text-purple-800">🤖 Gerar com IA</div>
          </div>
          <div class="grid grid-cols-2 gap-2 mb-3">
            <div>
              <label class="text-xs text-slate-500 mb-1 block">Tom</label>
              <select id="ai-tone" class="input text-sm py-1.5">
                <option value="animado">Animado 🎉</option>
                <option value="urgente">Urgente ⚡</option>
                <option value="profissional">Profissional 💼</option>
                <option value="descontraido">Descontraído 😊</option>
              </select>
            </div>
            <div>
              <label class="text-xs text-slate-500 mb-1 block">Opções</label>
              <div class="flex flex-col gap-1 mt-1">
                <label class="flex items-center gap-1.5 text-xs text-slate-600">
                  <input type="checkbox" id="ai-price" checked class="rounded"> Incluir preços
                </label>
                <label class="flex items-center gap-1.5 text-xs text-slate-600">
                  <input type="checkbox" id="ai-hashtags" checked class="rounded"> Incluir hashtags
                </label>
              </div>
            </div>
          </div>
          <button onclick="generateWithAI()" id="ai-gen-btn"
            class="w-full bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700 text-white text-sm font-semibold py-2 rounded-xl transition-all">
            ✨ Gerar Conteúdo com IA
          </button>
        </div>

        <!-- Agendamento -->
        <div class="flex items-center gap-3">
          <div class="flex-1">
            <label class="label">Agendar para (opcional)</label>
            <input type="datetime-local" id="post-schedule" class="input">
          </div>
        </div>

        <!-- Botões de ação -->
        <div class="flex gap-2">
          <button onclick="submitSocialPost('draft')" class="btn-secondary flex-1 text-sm">💾 Salvar Rascunho</button>
          <button onclick="submitSocialPost('scheduled')" id="btn-schedule" class="btn-secondary flex-1 text-sm">📅 Agendar</button>
          <button onclick="submitSocialPost('publish_now')" class="btn-primary flex-1 text-sm">🚀 Publicar Agora</button>
        </div>
      </div>

      <!-- Preview -->
      <div>
        <div class="bg-white rounded-2xl border border-slate-100 p-6 shadow-sm sticky top-24">
          <h3 class="font-bold text-slate-800 mb-4">Preview</h3>
          <div id="post-preview" class="text-slate-400 text-sm text-center py-8">
            Selecione uma conta e escreva o texto para ver o preview
          </div>
        </div>
      </div>
    </div>
  `
}

function updatePostPreview() {
  const accountSel = document.getElementById('post-account')
  const text = document.getElementById('post-text')?.value || ''
  const hashtags = document.getElementById('post-hashtags')?.value || ''
  const imageUrl = document.getElementById('post-image')?.value || ''
  const preview = document.getElementById('post-preview')
  const charsEl = document.getElementById('post-chars')
  if (!preview) return

  const platform = accountSel?.options[accountSel?.selectedIndex]?.dataset?.platform || ''
  const meta = PLATFORM_META[platform] || {}
  const fullText = [text, hashtags].filter(Boolean).join(String.fromCharCode(10,10))
  const limit = meta.textLimit || Infinity
  const over = fullText.length > limit

  if (charsEl) {
    charsEl.textContent = `${fullText.length} / ${limit === Infinity ? '∞' : limit}`
    charsEl.className = `text-xs ${over ? 'text-red-500 font-semibold' : 'text-slate-400'}`
  }

  if (!platform || !text) {
    preview.innerHTML = `<div class="text-slate-400 text-sm text-center py-8">Preencha os campos para ver o preview</div>`
    return
  }

  const accountName = accountSel?.options[accountSel?.selectedIndex]?.text?.split('(')[0]?.trim() || 'Conta'

  preview.innerHTML = `
    <div class="rounded-xl border-2 border-gradient overflow-hidden" style="border-color: transparent; background: linear-gradient(white,white) padding-box, linear-gradient(135deg, #3b82f6, #a855f7) border-box;">
      <!-- Header mock -->
      <div class="flex items-center gap-2 p-3 bg-gradient-to-r ${meta.color || 'from-slate-500 to-slate-700'}">
        <div class="w-8 h-8 rounded-full bg-white/30 flex items-center justify-center text-base">${meta.icon || '🌐'}</div>
        <div>
          <div class="text-white font-semibold text-xs">${accountName}</div>
          <div class="text-white/70 text-xs">${meta.label || platform}</div>
        </div>
      </div>
      <!-- Imagem preview -->
      ${imageUrl ? `<div class="bg-slate-100 overflow-hidden"><img src="${imageUrl}" alt="preview" class="w-full max-h-48 object-cover" onerror="this.style.display='none'"></div>` : ''}
      <!-- Texto -->
      <div class="p-3">
        <div class="text-slate-800 text-sm whitespace-pre-wrap break-words">${fullText.slice(0,300)}${fullText.length > 300 ? '...' : ''}</div>
        ${over ? `<div class="mt-2 text-xs text-red-500 font-semibold">[AVISO] Texto excede o limite de ${limit} caracteres para ${meta.label || platform}</div>` : ''}
      </div>
    </div>
  `
}

async function generateWithAI() {
  const accountSel = document.getElementById('post-account')
  const platform = accountSel?.options[accountSel?.selectedIndex]?.dataset?.platform || ''
  if (!platform) { toast('Selecione a conta primeiro', 'error'); return }

  const btn = document.getElementById('ai-gen-btn')
  btn.textContent = '⏳ Gerando...'
  btn.disabled = true

  const res = await api('POST', '/admin/api/social/ai-generate', {
    platform,
    tone: document.getElementById('ai-tone')?.value || 'animado',
    include_price: document.getElementById('ai-price')?.checked !== false,
    include_hashtags: document.getElementById('ai-hashtags')?.checked !== false,
  })

  btn.textContent = '✨ Gerar Conteúdo com IA'
  btn.disabled = false

  if (!res || res.error) { toast(res?.error || 'Erro ao gerar conteúdo', 'error'); return }

  if (document.getElementById('post-text')) document.getElementById('post-text').value = res.content_text || ''
  if (document.getElementById('post-hashtags')) document.getElementById('post-hashtags').value = res.hashtags || ''
  updatePostPreview()
  toast(res.ai_generated ? '✓ Conteúdo gerado pela IA!' : '✓ Conteúdo criado (template)', 'success')
}

async function submitSocialPost(action) {
  const accountSel = document.getElementById('post-account')
  const account_id = accountSel?.value
  const platform = accountSel?.options[accountSel?.selectedIndex]?.dataset?.platform || ''
  const content_text = document.getElementById('post-text')?.value?.trim() || ''
  const hashtags = document.getElementById('post-hashtags')?.value?.trim() || ''
  const image_url = document.getElementById('post-image')?.value?.trim() || ''
  const link_url = document.getElementById('post-link')?.value?.trim() || ''
  const scheduled_at = document.getElementById('post-schedule')?.value || ''

  if (!account_id) { toast('Selecione a conta de destino', 'error'); return }
  if (!content_text) { toast('O texto do post não pode estar vazio', 'error'); return }
  if (action === 'scheduled' && !scheduled_at) { toast('Defina a data/hora de agendamento', 'error'); return }

  const payload = {
    account_id, platform, content_text,
    hashtags: hashtags || null,
    image_url: image_url || null,
    link_url: link_url || null,
    status: action,
  }
  if (action === 'scheduled' || scheduled_at) payload.scheduled_at = scheduled_at || null

  const res = await api('POST', '/admin/api/social-posts', payload)
  if (!res) return

  if (action === 'publish_now') {
    if (res.ok) {
      toast('Post publicado com sucesso! ✓', 'success')
      if (res.url) {
        setTimeout(() => {
          if (confirm(`Post publicado! Abrir no ${platform}?`)) window.open(res.url, '_blank')
        }, 500)
      }
    } else {
      toast(`Erro ao publicar: ${res.error || 'Falha desconhecida'}`, 'error')
    }
  } else if (action === 'scheduled') {
    toast('Post agendado ✓', 'success')
    setTimeout(() => switchSocialTab('schedule'), 1000)
  } else {
    toast('Rascunho salvo ✓', 'info')
    setTimeout(() => switchSocialTab('history'), 1000)
  }
}

// ── ABA: Agenda ───────────────────────────────────────────
async function renderSocialSchedule(area) {
  const data = await api('GET', '/admin/api/social-posts?status=scheduled')
  const posts = data?.posts || []

  area.innerHTML = `
    <div class="flex items-center justify-between mb-4">
      <div class="text-sm text-slate-500">${posts.length} post(s) agendado(s)</div>
      <div class="flex gap-2">
        <button onclick="runSocialCron(this)" class="btn-secondary text-sm">⚡ Publicar Agendados Agora</button>
        <button onclick="switchSocialTab('create')" class="btn-primary text-sm">+ Criar Post</button>
      </div>
    </div>

    ${!posts.length ? `
      <div class="text-center py-16 bg-white rounded-2xl border border-dashed border-slate-200">
        <div class="text-4xl mb-3">📅</div>
        <div class="text-slate-600 font-medium mb-1">Nenhum post agendado</div>
        <div class="text-slate-400 text-sm mb-4">Posts agendados aparecerão aqui</div>
        <button onclick="switchSocialTab('create')" class="btn-primary text-sm">+ Criar Post Agendado</button>
      </div>
    ` : `
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <table class="w-full">
          <thead>
            <tr class="bg-slate-50 border-b border-slate-100">
              <th class="text-left text-xs text-slate-500 font-semibold px-5 py-3">Conta</th>
              <th class="text-left text-xs text-slate-500 font-semibold px-5 py-3">Conteúdo</th>
              <th class="text-left text-xs text-slate-500 font-semibold px-5 py-3">Agendado Para</th>
              <th class="text-right text-xs text-slate-500 font-semibold px-5 py-3">Ações</th>
            </tr>
          </thead>
          <tbody>
            ${posts.map(post => `
              <tr class="border-b border-slate-50 hover:bg-slate-50">
                <td class="px-5 py-3">
                  <div class="flex items-center gap-2">
                    <span class="text-lg">${(PLATFORM_META[post.platform]||{icon:'🌐'}).icon}</span>
                    <div>
                      <div class="text-sm font-medium text-slate-700">${post.account_name || '—'}</div>
                      <div class="text-xs text-slate-400">${(PLATFORM_META[post.platform]||{label:post.platform}).label}</div>
                    </div>
                  </div>
                </td>
                <td class="px-5 py-3 max-w-[300px]">
                  <div class="text-sm text-slate-700 truncate">${post.content_text}</div>
                  ${post.hashtags ? `<div class="text-xs text-blue-500 truncate">${post.hashtags}</div>` : ''}
                  ${post.ai_generated ? `<span class="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded font-medium">[IA] IA</span>` : ''}
                </td>
                <td class="px-5 py-3">
                  <div class="text-sm font-semibold text-slate-700">${fDateTime(post.scheduled_at)}</div>
                  ${new Date(post.scheduled_at) < new Date() ? `<div class="text-xs text-orange-500 font-medium">⏰ Atrasado</div>` : ''}
                </td>
                <td class="px-5 py-3 text-right">
                  <div class="flex items-center justify-end gap-1">
                    <button onclick="editScheduledPost(${post.id})" class="text-xs text-blue-500 hover:bg-blue-50 px-2 py-1 rounded-lg transition-colors">Editar</button>
                    <button onclick="cancelScheduledPost(${post.id})" class="text-xs text-orange-500 hover:bg-orange-50 px-2 py-1 rounded-lg transition-colors">Cancelar</button>
                    <button onclick="deleteScheduledPost(${post.id})" class="text-xs text-red-400 hover:bg-red-50 px-2 py-1 rounded-lg transition-colors">Excluir</button>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `}
  `
}

async function runSocialCron(btn) {
  btn.textContent = '⏳ Processando...'
  btn.disabled = true
  const res = await api('POST', '/admin/api/social/cron')
  btn.textContent = '⚡ Publicar Agendados Agora'
  btn.disabled = false
  if (!res) return
  toast(` ${res.published} publicado(s), ${res.failed || 0} falha(s)`, res.failed ? 'error' : 'success')
  await loadSocialTab('schedule')
}

async function cancelScheduledPost(id) {
  if (!confirm('Cancelar este post agendado?')) return
  await api('PATCH', `/admin/api/social-posts/${id}`, { status: 'cancelled' })
  toast('Post cancelado', 'info')
  await loadSocialTab('schedule')
}

async function deleteScheduledPost(id) {
  if (!confirm('Excluir este post? Esta ação não pode ser desfeita.')) return
  await api('DELETE', `/admin/api/social-posts/${id}`)
  toast('Post excluído', 'info')
  await loadSocialTab('schedule')
}

function editScheduledPost(id) {
  // Abre modal de edição
  api('GET', `/admin/api/social-posts?status=scheduled`).then(data => {
    const post = (data?.posts || []).find(p => p.id === id)
    if (!post) return

    document.getElementById('modal-container').innerHTML = `
      <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm" id="edit-post-modal">
        <div class="bg-white rounded-2xl shadow-2xl w-full max-w-md">
          <div class="flex items-center justify-between p-5 border-b border-slate-100">
            <h3 class="font-bold text-slate-800">Editar Post Agendado</h3>
            <button onclick="document.getElementById('edit-post-modal').remove()" class="text-slate-400 hover:text-slate-600 text-xl">&times;</button>
          </div>
          <div class="p-5 space-y-4">
            <div>
              <label class="label">Texto</label>
              <textarea id="edit-text" class="input min-h-[120px]">${post.content_text}</textarea>
            </div>
            <div>
              <label class="label">Hashtags</label>
              <input id="edit-hashtags" class="input" value="${post.hashtags || ''}">
            </div>
            <div>
              <label class="label">Nova data/hora</label>
              <input type="datetime-local" id="edit-schedule" class="input" value="${post.scheduled_at?.slice(0,16) || ''}">
            </div>
          </div>
          <div class="flex gap-3 p-5 border-t border-slate-100">
            <button onclick="document.getElementById('edit-post-modal').remove()" class="btn-secondary flex-1">Cancelar</button>
            <button onclick="saveEditPost(${id})" class="btn-primary flex-1">Salvar</button>
          </div>
        </div>
      </div>
    `
  })
}

async function saveEditPost(id) {
  const content_text = document.getElementById('edit-text')?.value?.trim() || ''
  const hashtags = document.getElementById('edit-hashtags')?.value?.trim() || ''
  const scheduled_at = document.getElementById('edit-schedule')?.value || ''
  if (!content_text) { toast('Texto não pode ficar vazio', 'error'); return }
  await api('PATCH', `/admin/api/social-posts/${id}`, { content_text, hashtags, scheduled_at: scheduled_at || null })
  document.getElementById('edit-post-modal')?.remove()
  toast('Post atualizado ✓', 'success')
  await loadSocialTab('schedule')
}

// ── ABA: Histórico ────────────────────────────────────────
async function renderSocialHistory(area) {
  const statusFilter = area._statusFilter || ''
  const platformFilter = area._platFilter || ''

  const params = new URLSearchParams()
  if (statusFilter) params.set('status', statusFilter)
  if (platformFilter) params.set('platform', platformFilter)
  params.set('page', area._page || '1')

  const data = await api('GET', `/admin/api/social-posts?${params}`)
  const posts = data?.posts || []
  const total = data?.total || 0

  const statusBadge = (s) => {
    const map = {
      draft:      'bg-slate-100 text-slate-600',
      scheduled:  'bg-blue-100 text-blue-700',
      publishing: 'bg-yellow-100 text-yellow-700',
      published:  'bg-green-100 text-green-700',
      failed:     'bg-red-100 text-red-600',
      cancelled:  'bg-slate-100 text-slate-500 line-through',
    }
    const labels = { draft:'Rascunho', scheduled:'Agendado', publishing:'Publicando', published:'Publicado', failed:'Falhou', cancelled:'Cancelado' }
    return `<span class="text-xs font-semibold px-2 py-0.5 rounded-full ${map[s]||'bg-slate-100 text-slate-600'}">${labels[s]||s}</span>`
  }

  area.innerHTML = `
    <!-- Filtros -->
    <div class="flex flex-wrap items-center gap-2 mb-4">
      <select onchange="setHistoryFilter('status', this.value, arguments[0].target.closest('[id=social-tab-content]'))" class="input py-1.5 text-sm w-auto">
        <option value="" ${!statusFilter?'selected':''}>Todos os status</option>
        ${['draft','scheduled','published','failed','cancelled'].map(s => `<option value="${s}" ${statusFilter===s?'selected':''}>${s}</option>`).join('')}
      </select>
      <select onchange="setHistoryFilter('platform', this.value, arguments[0].target.closest('[id=social-tab-content]'))" class="input py-1.5 text-sm w-auto">
        <option value="" ${!platformFilter?'selected':''}>Todas as plataformas</option>
        ${Object.entries(PLATFORM_META).map(([k,v]) => `<option value="${k}" ${platformFilter===k?'selected':''}>${v.icon} ${v.label}</option>`).join('')}
      </select>
      <span class="text-sm text-slate-400 ml-auto">${total} post(s) encontrado(s)</span>
    </div>

    ${!posts.length ? `
      <div class="text-center py-16 bg-white rounded-2xl border border-dashed border-slate-200">
        <div class="text-4xl mb-3">📋</div>
        <div class="text-slate-600 font-medium">Nenhum post encontrado</div>
      </div>
    ` : `
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <table class="w-full">
          <thead>
            <tr class="bg-slate-50 border-b border-slate-100">
              <th class="text-left text-xs text-slate-500 font-semibold px-5 py-3">Plataforma</th>
              <th class="text-left text-xs text-slate-500 font-semibold px-5 py-3">Conteúdo</th>
              <th class="text-left text-xs text-slate-500 font-semibold px-5 py-3">Status</th>
              <th class="text-left text-xs text-slate-500 font-semibold px-5 py-3">Data</th>
              <th class="text-right text-xs text-slate-500 font-semibold px-5 py-3">Ações</th>
            </tr>
          </thead>
          <tbody>
            ${posts.map(post => `
              <tr class="border-b border-slate-50 hover:bg-slate-50">
                <td class="px-5 py-3">
                  <div class="flex items-center gap-2">
                    <span class="text-lg">${(PLATFORM_META[post.platform]||{icon:'🌐'}).icon}</span>
                    <div class="text-xs text-slate-500">${post.account_name || '—'}</div>
                  </div>
                </td>
                <td class="px-5 py-3 max-w-[280px]">
                  <div class="text-sm text-slate-700 truncate">${post.content_text}</div>
                  ${post.error_message ? `<div class="text-xs text-red-500 truncate" title="${post.error_message}">${post.error_message}</div>` : ''}
                  ${post.ai_generated ? `<span class="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">[IA] IA</span>` : ''}
                </td>
                <td class="px-5 py-3">${statusBadge(post.status)}</td>
                <td class="px-5 py-3 text-xs text-slate-500">
                  ${post.published_at ? fDateTime(post.published_at) : (post.scheduled_at ? '📅 ' + fDateTime(post.scheduled_at) : fDate(post.created_at))}
                </td>
                <td class="px-5 py-3 text-right">
                  <div class="flex items-center justify-end gap-1">
                    ${post.platform_post_url ? `<a href="${post.platform_post_url}" target="_blank" class="text-xs text-blue-500 hover:bg-blue-50 px-2 py-1 rounded-lg transition-colors">↗ Ver</a>` : ''}
                    ${post.status === 'failed' ? `<button onclick="retryPost(${post.id})" class="text-xs text-orange-500 hover:bg-orange-50 px-2 py-1 rounded-lg transition-colors">↺ Retry</button>` : ''}
                    <button onclick="deleteHistoryPost(${post.id})" class="text-xs text-red-400 hover:bg-red-50 px-2 py-1 rounded-lg transition-colors">✕</button>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        ${total > 20 ? `<div class="px-5 py-3 text-xs text-slate-400 border-t border-slate-100">Mostrando 20 de ${total}. Use os filtros para refinar.</div>` : ''}
      </div>
    `}
  `
}

function setHistoryFilter(type, value, container) {
  if (!container) container = document.getElementById('social-tab-content')
  if (type === 'status') container._statusFilter = value
  if (type === 'platform') container._platFilter = value
  renderSocialHistory(container)
}

async function retryPost(id) {
  // Recoloca o post como agendado para agora
  await api('PATCH', `/admin/api/social-posts/${id}`, { status: 'scheduled', scheduled_at: new Date().toISOString() })
  const res = await api('POST', '/admin/api/social/cron')
  toast(res?.published ? 'Post reenviado ✓' : 'Erro ao reenviar', res?.published ? 'success' : 'error')
  await loadSocialTab('history')
}

async function deleteHistoryPost(id) {
  if (!confirm('Excluir este registro?')) return
  await api('DELETE', `/admin/api/social-posts/${id}`)
  toast('Registro excluído', 'info')
  await loadSocialTab('history')
}

// ── BOT AFILIADOS ML ──────────────────────────────────────
async function renderAffiliateBot(area) {
  const status = await api('GET', '/admin/api/affiliate-bot/status')
  if (!status) return

  const pct = status.total > 0 ? Math.round((status.with_affiliate / status.total) * 100) : 0

  area.innerHTML = `
    <div class="section space-y-6">

      <!-- Stats -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
        ${statCard('📦', 'Total Produtos', status.total, 'ativos no catálogo', 'blue')}
        ${statCard('🤝', 'Com Link ML', status.with_affiliate, 'links gerados', 'green')}
        ${statCard('⏳', 'Pendentes', status.pending, 'sem link afiliado', 'orange')}
        ${statCard('📊', 'Cobertura', pct + '%', 'do catálogo linkado', 'purple')}
      </div>

      <!-- Barra de progresso -->
      <div class="stat-card">
        <div class="flex items-center justify-between mb-2">
          <h3 class="font-bold text-slate-800">📈 Progresso Geral</h3>
          <span class="text-sm font-semibold text-slate-600">${status.with_affiliate} / ${status.total}</span>
        </div>
        <div class="w-full bg-slate-100 rounded-full h-4 overflow-hidden">
          <div class="h-4 rounded-full transition-all duration-500" style="width:${pct}%;background:linear-gradient(90deg,#22c55e,#16a34a)"></div>
        </div>
        <p class="text-xs text-slate-500 mt-2">Publisher ID: <code class="bg-slate-100 px-1.5 py-0.5 rounded font-mono">cfegdhabc31955</code> · Comissão 5-12%</p>
      </div>

      <!-- Ações rápidas -->
      <div class="stat-card">
        <h3 class="font-bold text-slate-800 mb-4">🤖 Automação</h3>
        <div class="flex flex-wrap gap-3">
          <button onclick="runBotAll()" id="btn-run-all"
            class="btn-primary flex items-center gap-2">
            <span>▶</span> Rodar Bot (próximos 30 pendentes)
          </button>
          <button onclick="loadAffiliateTable('missing')"
            class="btn-secondary">📋 Ver Pendentes</button>
          <button onclick="loadAffiliateTable('done')"
            class="btn-secondary">✅ Ver Concluídos</button>
          <button onclick="loadAffiliateTable('all')"
            class="btn-secondary">🔍 Ver Todos</button>
          <button onclick="importOffers()" id="btn-import-offers"
            class="btn-primary flex items-center gap-2" style="background:linear-gradient(135deg,#f59e0b,#d97706)">
            <span>🛒</span> Importar Ofertas ML
          </button>
        </div>
        <div id="bot-log" class="mt-4 hidden">
          <div class="bg-slate-900 text-green-400 rounded-xl p-4 font-mono text-sm min-h-[80px]" id="bot-log-text">
            Aguardando...
          </div>
        </div>
      </div>

      <!-- Busca manual -->
      <div class="stat-card">
        <h3 class="font-bold text-slate-800 mb-4">🔍 Busca Manual por Produto</h3>
        <div class="flex gap-3 mb-4">
          <input id="aff-search-input" type="text" placeholder="Ex: iPhone 15 128GB Apple"
            class="input flex-1" onkeydown="if(event.key==='Enter') searchML()"/>
          <input id="aff-product-id" type="number" placeholder="ID produto"
            class="input w-32"/>
          <button onclick="searchML()" class="btn-primary">Buscar no ML</button>
        </div>
        <div id="aff-results" class="space-y-2"></div>
      </div>

      <!-- Tabela de produtos -->
      <div class="stat-card" id="aff-table-wrap" style="display:none">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-bold text-slate-800" id="aff-table-title">Produtos</h3>
        </div>
        <div id="aff-table-content"></div>
      </div>

    </div>
  `
}

async function importOffers() {
  const btn = document.getElementById('btn-import-offers')
  const log = document.getElementById('bot-log')
  const logText = document.getElementById('bot-log-text')
  if (!btn || !log || !logText) return

  btn.disabled = true
  btn.innerHTML = '<span>⏳</span> Importando...'
  log.classList.remove('hidden')
  logText.textContent = '🛒 Buscando ofertas em mercadolivre.com.br/ofertas...'

  const res = await api('POST', '/admin/api/affiliate-bot/import-offers', { limit: 20 })

  if (!res) {
    logText.textContent = '❌ Erro ao chamar import-offers'
    btn.disabled = false
    btn.innerHTML = '<span>🛒</span> Importar Ofertas ML'
    return
  }

  if (!res.ok) {
    const reason = res.error || res.message || 'Erro desconhecido'
    logText.textContent = '❌ ' + reason
    btn.disabled = false
    btn.innerHTML = '<span>🛒</span> Importar Ofertas ML'
    toast('Falha: ' + reason, 'error')
    return
  }

  const sc = res.scrape || {}
  const sm = res.summary || {}

  const lines = [
    '✅ Import finalizado!',
    '--- Scrape /ofertas ---',
    'Status HTTP : ' + (sc.status || '-'),
    'HTML        : ' + (sc.bytes ? (sc.bytes / 1024).toFixed(1) + ' KB' : '-'),
    'Itens no JSON : ' + (sc.total_found || 0),
    'Processados   : ' + (sc.processed  || 0),
    '--- Resultado ---',
    '✅ Importados  : ' + (sm.imported || 0),
    '🔄 Atualizados : ' + (sm.updated  || 0),
    '⏭  Skipped     : ' + (sm.skipped  || 0),
    sm.errors ? '⚠ Erros: ' + sm.errors : '',
    res.tip ? '💡 ' + res.tip : '',
  ].filter(Boolean)

  if (res.dry_run) lines.splice(1, 0, '🧪 DRY RUN — nada foi salvo')

  logText.textContent = lines.join(String.fromCharCode(10))
  btn.disabled = false
  btn.innerHTML = '<span>🛒</span> Importar Ofertas ML'

  const total = (sm.imported || 0) + (sm.updated || 0)
  toast('Ofertas ML: ' + total + ' importados/atualizados', total > 0 ? 'success' : 'warning')
  if (total > 0) setTimeout(() => loadSection('affiliate-bot'), 2500)
}

async function runBotAll() {
  const btn = document.getElementById('btn-run-all')
  const log = document.getElementById('bot-log')
  const logText = document.getElementById('bot-log-text')
  if (!btn || !log || !logText) return

  btn.disabled = true
  btn.textContent = '⏳ Rodando...'
  log.classList.remove('hidden')
  logText.textContent = '🤖 Iniciando bot...'

  const res = await api('POST', '/admin/api/affiliate-bot/run-all')
  if (!res) {
    logText.textContent = '❌ Erro ao rodar bot'
    btn.disabled = false
    btn.innerHTML = '<span>▶</span> Rodar Bot (próximos 30 pendentes)'
    return
  }

  const _total = (res.refreshed || 0) + (res.linked || 0) + (res.fallback || 0)
  // token_source: 'client_credentials' | 'cache' | 'oauth_kv' | 'none'
  const _tokenLabel = {
    client_credentials: '🔑 Token: client_credentials (ML_SECRET)',
    cache:              '📦 Token: cache KV (client_credentials)',
    oauth_kv:           '🔑 Token: OAuth usuario (KV)',
    none:               '⚠️ Sem token -- configure ML_SECRET no Cloudflare',
  }[res.token_source || 'none'] || ''
  logText.textContent = [
    '✅ Bot finalizado!',
    _tokenLabel,
    '📦 Total processados : ' + _total,
    '🔄 Preços atualizados: ' + (res.refreshed || 0) + '  (COM ml_item_id → /items/{id})',
    '🔗 Novos links       : ' + (res.linked   || 0) + '   (SEM id → search ML)',
    '🔍 Link de busca     : ' + (res.fallback  || 0) + '  (fallback — search bloqueou)',
    res.errors && res.errors.length ? '⚠ Erros: ' + res.errors.join(' | ') : '',
    res.message || '',
  ].filter(Boolean).join(String.fromCharCode(10))

  btn.disabled = false
  btn.innerHTML = '<span>▶</span> Rodar Bot (próximos 30 pendentes)'

  // Recarrega stats
  const _toastType = res.no_token ? 'warning' : 'success'
  toast('Bot: ' + _total + ' processados (' + (res.token_source || 'sem token') + ')', _toastType)
  setTimeout(() => loadSection('affiliate-bot'), 2000)
}

async function searchML() {
  const q = document.getElementById('aff-search-input')?.value?.trim()
  const pid = document.getElementById('aff-product-id')?.value?.trim()
  const resultsEl = document.getElementById('aff-results')
  if (!q || !resultsEl) return

  resultsEl.innerHTML = `<p class="text-sm text-slate-500 animate-pulse">[Busca] Buscando no Mercado Livre...</p>`

  const res = await api('POST', '/admin/api/affiliate-bot/search', { query: q, product_id: pid ? parseInt(pid) : null })
  if (res && res.source === 'fallback') {
    const su = res.search_url || ''
    resultsEl.innerHTML = '<div class="p-3 bg-orange-50 border border-orange-200 rounded-xl text-sm">'
      + '<p class="font-semibold text-orange-700 mb-1">⚠️ API de busca bloqueada</p>'
      + '<p class="text-orange-600 text-xs mb-2">' + (res.message || 'API retornou 403.') + '</p>'
      + '<p class="text-slate-700 text-xs mb-2">Use <b>Importar ML → Importar por URL</b>.</p>'
      + (su ? '<a href="' + su + '" target="_blank" class="inline-flex items-center gap-1 text-xs text-orange-700 font-medium underline">🔗 Busca afiliada para &ldquo;' + q + '&rdquo;</a>' : '')
      + '</div>'
    return
  }
  if (!res || !res.items?.length) {
    resultsEl.innerHTML = `<p class="text-sm text-red-500">[ERRO] Nenhum resultado encontrado para "<b>${q}</b>"</p>`
    return
  }

  resultsEl.innerHTML = res.items.map((item, i) => `
    <div class="flex items-start gap-3 p-3 border border-slate-200 rounded-xl hover:border-yellow-400 transition-all">
      <img src="${item.thumbnail}" class="w-14 h-14 object-contain rounded-lg border border-slate-100 bg-white flex-shrink-0" onerror="this.src='https://via.placeholder.com/56'"/>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium text-slate-800 truncate">${item.title}</p>
        <p class="text-sm font-bold text-green-600">R$ ${item.price?.toLocaleString('pt-BR', {minimumFractionDigits:2})}</p>
        <p class="text-xs text-slate-500 font-mono truncate">ID: ${item.ml_id}</p>
        <a href="${item.affiliate_url}" target="_blank" class="text-xs text-blue-500 hover:underline truncate block">🔗 ${item.affiliate_url.substring(0,70)}...</a>
      </div>
      ${pid ? `
        <button onclick="applyAffiliate(${pid}, '${item.ml_id}', '${item.affiliate_url.replace(/'/g, '&#39;')}')"
          class="btn-primary text-xs px-3 py-1.5 flex-shrink-0">✓ Aplicar</button>
      ` : `<span class="text-xs text-slate-400 flex-shrink-0">Informe ID</span>`}
    </div>
  `).join('')
}

async function applyAffiliate(product_id, ml_item_id, affiliate_url) {
  const res = await api('POST', '/admin/api/affiliate-bot/apply', { product_id, ml_item_id, affiliate_url })
  if (res?.ok) {
    toast('✅ Link de afiliado salvo!', 'success')
    document.getElementById('aff-results').innerHTML = ''
    document.getElementById('aff-search-input').value = ''
    document.getElementById('aff-product-id').value = ''
  } else {
    toast('❌ Erro ao salvar link', 'error')
  }
}

async function loadAffiliateTable(filter) {
  const wrap = document.getElementById('aff-table-wrap')
  const content = document.getElementById('aff-table-content')
  const title = document.getElementById('aff-table-title')
  if (!wrap || !content) return

  wrap.style.display = ''
  content.innerHTML = `<p class="text-sm text-slate-500 animate-pulse">Carregando...</p>`

  const labels = { all: 'Todos os Produtos', missing: '⏳ Pendentes (sem link)', done: '✅ Com Link de Afiliado' }
  if (title) title.textContent = labels[filter] || 'Produtos'

  const res = await api('GET', `/admin/api/affiliate-bot/products?filter=${filter}`)
  if (!res || !res.results?.length) {
    content.innerHTML = `<p class="text-sm text-slate-500">Nenhum produto encontrado.</p>`
    return
  }

  content.innerHTML = `
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-slate-200 text-left">
            <th class="py-2 pr-3 font-semibold text-slate-600">ID</th>
            <th class="py-2 pr-3 font-semibold text-slate-600">Produto</th>
            <th class="py-2 pr-3 font-semibold text-slate-600">Preço</th>
            <th class="py-2 pr-3 font-semibold text-slate-600">ML ID</th>
            <th class="py-2 pr-3 font-semibold text-slate-600">Link Afiliado</th>
            <th class="py-2 font-semibold text-slate-600">Ações</th>
          </tr>
        </thead>
        <tbody>
          ${res.results.map(p => `
            <tr class="border-b border-slate-100 hover:bg-slate-50">
              <td class="py-2 pr-3 text-slate-500">${p.id}</td>
              <td class="py-2 pr-3">
                <p class="font-medium text-slate-800 truncate max-w-[180px]">${p.name}</p>
                <p class="text-xs text-slate-400">${p.brand || ''} · ${p.category || ''}</p>
              </td>
              <td class="py-2 pr-3 font-bold text-green-600">R$ ${(p.best_price || 0).toLocaleString('pt-BR', {minimumFractionDigits:2})}</td>
              <td class="py-2 pr-3 font-mono text-xs text-slate-500">${p.ml_item_id || '<span class="text-red-400">—</span>'}</td>
              <td class="py-2 pr-3">
                ${p.affiliate_url
                  ? `<a href="${p.affiliate_url}" target="_blank" class="text-blue-500 hover:underline text-xs">[Link] Ver link</a>`
                  : `<span class="text-xs text-red-400">Não gerado</span>`
                }
              </td>
              <td class="py-2 whitespace-nowrap">
                <button onclick="quickSearch(${p.id}, '${(p.name + ' ' + (p.brand || '')).replace(/'/g, '')}', ${p.id})"
                  class="text-xs px-2 py-1 bg-yellow-100 text-yellow-700 rounded-lg hover:bg-yellow-200 mr-1">🔍 Buscar</button>
                ${p.affiliate_url
                  ? `<button onclick="clearAffiliate(${p.id})" class="text-xs px-2 py-1 bg-red-100 text-red-600 rounded-lg hover:bg-red-200"></button>`
                  : ''}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <p class="text-xs text-slate-400 mt-3">Total: ${res.total} produtos</p>
    </div>
  `
}

function quickSearch(product_id, name, pid) {
  // Preenche os campos de busca manual e faz scroll
  const input = document.getElementById('aff-search-input')
  const pidInput = document.getElementById('aff-product-id')
  if (input) input.value = name
  if (pidInput) pidInput.value = pid
  window.scrollTo({ top: 0, behavior: 'smooth' })
  searchML()
}

async function clearAffiliate(id) {
  if (!confirm('Remover link de afiliado deste produto?')) return
  const res = await api('DELETE', `/admin/api/affiliate-bot/clear/${id}`)
  if (res?.ok) {
    toast('Link removido', 'info')
    loadAffiliateTable('done')
  }
}

// ── CÓDIGOS AFILIADOS ─────────────────────────────────────
async function renderAffiliateCodes(area) {
  area.innerHTML = spin

  const [data, stats] = await Promise.all([
    api('GET', '/admin/api/affiliate-rules'),
    api('GET', '/admin/api/affiliate-rules/stats'),
  ])
  if (!data || !stats) return

  const rules = data.rules || []
  const pct = stats.total > 0 ? Math.round((stats.with_affiliate / stats.total) * 100) : 0

  const networkColor = {
    'meli-api':      '#ffe600',
    'lomadee':       '#e85d04',
    'amazon-pa-api': '#ff9900',
    'shein-api':     '#e91e8c',
    'hotmart-api':   '#ff4f00',
    'eduzz-api':     '#7c3aed',
    'monetizze-api': '#059669',
  }
  const networkIcon = {
    'meli-api':      '🛒',
    'lomadee':       '🏪',
    'amazon-pa-api': '📦',
    'shein-api':     '👗',
    'hotmart-api':   '🔥',
    'eduzz-api':     '⚡',
    'monetizze-api': '💰',
  }

  area.innerHTML = `
    <div class="section space-y-6">

      <!-- Stats globais -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
        ${statCard('📦', 'Total Produtos', stats.total, 'no catálogo', 'blue')}
        ${statCard('🔗', 'Com Link Afiliado', stats.with_affiliate, 'links gerados', 'green')}
        ${statCard('⏳', 'Sem Link', stats.pending, 'aguardando código', 'orange')}
        ${statCard('📊', 'Cobertura', pct + '%', 'do catálogo linkado', 'purple')}
      </div>

      <!-- Barra de progresso -->
      <div class="stat-card">
        <div class="flex items-center justify-between mb-2">
          <h3 class="font-bold text-slate-800">📈 Cobertura de Links</h3>
          <span class="text-sm font-semibold text-slate-600">${stats.with_affiliate} / ${stats.total} produtos</span>
        </div>
        <div class="w-full bg-slate-100 rounded-full h-4 overflow-hidden">
          <div class="h-4 rounded-full transition-all duration-500"
               style="width:${pct}%;background:linear-gradient(90deg,#22c55e,#16a34a)"></div>
        </div>
        <p class="text-xs text-slate-500 mt-2">
          Produtos do ML: <strong>${stats.with_ml_id}</strong> com ml_item_id
        </p>
      </div>

      <!-- Ações globais -->
      <div class="stat-card">
        <h3 class="font-bold text-slate-800 mb-4">🤖 Bot Automático ML</h3>
        <div class="flex flex-wrap gap-3 items-center">
          <button onclick="runAutoSync()" id="btn-auto-sync"
            class="btn-primary flex items-center gap-2 text-base px-5 py-2.5"
            style="background:linear-gradient(135deg,#16a34a,#15803d)">
            <span>🚀</span> Rodar Bot Completo
          </button>
          <button onclick="runAutoSync({steps:['import']})" id="btn-only-import"
            class="btn-primary flex items-center gap-2"
            style="background:linear-gradient(135deg,#f59e0b,#d97706)">
            <span>🛒</span> Só Importar (54 ofertas)
          </button>
          <button onclick="runAutoSync({steps:['search']})" id="btn-only-search"
            class="btn-primary flex items-center gap-2"
            style="background:linear-gradient(135deg,#0ea5e9,#0284c7)">
            <span>🔍</span> Só Buscar por Nome
          </button>
          <button onclick="runAutoSync({steps:['prices']})" id="btn-only-prices"
            class="btn-primary flex items-center gap-2"
            style="background:linear-gradient(135deg,#8b5cf6,#7c3aed)">
            <span>💰</span> Só Atualizar Preços
          </button>
          <button onclick="renderAffiliateCodes(document.getElementById('content-area'))"
            class="btn-secondary">↻ Atualizar</button>
        </div>

        <!-- Terminal de log -->
        <div id="aff-codes-log" class="mt-4 hidden">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-semibold text-slate-500 uppercase tracking-wide">📟 Log do Bot</span>
            <span id="sync-timer" class="text-xs text-slate-400 font-mono"></span>
          </div>
          <div class="bg-slate-950 text-green-400 rounded-xl p-4 font-mono text-xs leading-relaxed min-h-[140px] max-h-80 overflow-y-auto whitespace-pre-wrap border border-slate-800"
               id="aff-codes-log-text">Aguardando...</div>
        </div>

      </div>

      <!-- Cards por rede -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4" id="rules-grid">
        ${rules.map(r => renderRuleCard(r, networkIcon, networkColor)).join('')}
      </div>

    </div>
  `
}

function renderRuleCard(r, icons, colors) {
  const hasPub  = r.publisher_id && r.publisher_id.trim() !== ''
  const icon    = icons[r.network]  || '🔌'
  const color   = colors[r.network] || '#6366f1'
  const statusBadge = hasPub
    ? `<span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-700">✅ Configurado</span>`
    : `<span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">⚠ Sem código</span>`

  return `
    <div class="stat-card border-l-4" style="border-left-color:${color}" id="rule-card-${r.network}">
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-2">
          <span class="text-2xl">${icon}</span>
          <div>
            <h4 class="font-bold text-slate-800">${r.label}</h4>
            <p class="text-xs text-slate-500 font-mono">${r.network}</p>
          </div>
        </div>
        ${statusBadge}
      </div>

      <div class="text-sm text-slate-600 mb-3 flex gap-4">
        <span>🏪 <strong>${r.store_count || 0}</strong> lojas</span>
        <span>🔗 <strong>${r.linked_products || 0}</strong> / <strong>${r.total_products || 0}</strong> links</span>
      </div>

      <!-- Campos editáveis -->
      <div class="space-y-2">
        <div>
          <label class="text-xs font-semibold text-slate-600 block mb-1">
            Publisher ID / Código de Afiliado
          </label>
          <div class="flex gap-2">
            <input type="text" id="pub-${r.network}"
              class="input flex-1 font-mono text-sm"
              placeholder="Ex: cfegdhabc31955"
              value="${hasPub ? r.publisher_id : ''}"/>
          </div>
        </div>

        ${r.extra_param !== undefined ? `
        <div>
          <label class="text-xs font-semibold text-slate-600 block mb-1">
            Parâmetro Extra (opcional)
          </label>
          <input type="text" id="extra-${r.network}"
            class="input w-full font-mono text-sm"
            placeholder="Ex: matt_tool=38524122"
            value="${r.extra_param || ''}"/>
        </div>` : ''}

        <div>
          <label class="text-xs font-semibold text-slate-600 block mb-1">
            Template do Link
          </label>
          <input type="text" id="tpl-${r.network}"
            class="input w-full font-mono text-xs text-slate-600"
            placeholder="{url}?param={pub}"
            value="${r.link_template || ''}"/>
          <p class="text-xs text-slate-400 mt-1">
            Variáveis: <code>{url}</code> = URL do produto, <code>{pub}</code> = publisher_id, <code>{extra}</code> = parâmetro extra
          </p>
        </div>
      </div>

      <!-- Ações do card -->
      <div class="flex gap-2 mt-4">
        <button onclick="saveAffRule('${r.network}')"
          class="btn-primary text-sm flex-1">
          💾 Salvar
        </button>
        ${hasPub ? `
        <button onclick="generateLinks('${r.network}', '${r.label}')"
          class="btn-secondary text-sm flex-1">
          🔗 Gerar Links
        </button>` : `
        <button disabled class="btn-secondary text-sm flex-1 opacity-40 cursor-not-allowed">
          🔗 Gerar Links
        </button>`}
      </div>
    </div>
  `
}

async function saveAffRule(network) {
  const pub   = document.getElementById('pub-' + network)?.value?.trim() || ''
  const extra = document.getElementById('extra-' + network)?.value?.trim() || null
  const tpl   = document.getElementById('tpl-' + network)?.value?.trim() || ''

  if (!pub) {
    toast('Digite o Publisher ID antes de salvar', 'warning')
    return
  }

  const res = await api('PUT', '/admin/api/affiliate-rules/' + encodeURIComponent(network), {
    publisher_id: pub,
    extra_param: extra,
    link_template: tpl || undefined,
  })

  if (!res || !res.ok) {
    toast('Erro ao salvar regra: ' + (res?.error || 'desconhecido'), 'error')
    return
  }

  toast('✅ Código salvo para ' + network, 'success')
  // Recarrega a seção para atualizar os badges
  setTimeout(() => renderAffiliateCodes(document.getElementById('content-area')), 800)
}

async function generateLinks(network, label) {
  const log     = document.getElementById('aff-codes-log')
  const logText = document.getElementById('aff-codes-log-text')
  log.classList.remove('hidden')
  logText.textContent = '🔗 Gerando links para ' + label + '...'

  const res = await api('POST', '/admin/api/affiliate-rules/generate', { network })

  if (!res || !res.ok) {
    logText.textContent = '❌ Erro: ' + (res?.error || 'desconhecido')
    toast('Erro ao gerar links', 'error')
    return
  }

  const lines = [
    '✅ Links gerados!',
    '────────────────────',
    'Rede      : ' + (network || 'todas'),
    'Atualizados: ' + res.total_updated,
    res.tip || '',
  ]
  if (res.summary) {
    Object.values(res.summary).forEach(s => {
      lines.push('  ' + s.label + ': ' + s.updated + ' links')
    })
  }

  logText.textContent = lines.filter(Boolean).join(String.fromCharCode(10))
  toast('🔗 ' + res.total_updated + ' links gerados!', res.total_updated > 0 ? 'success' : 'warning')

  // Atualiza stats após 1.5s
  if (res.total_updated > 0) {
    setTimeout(() => renderAffiliateCodes(document.getElementById('content-area')), 1500)
  }
}

async function runAutoSync(opts) {
  const steps   = (opts && opts.steps) ? opts.steps : ['import', 'search', 'prices']
  const dryRun  = !!(opts && opts.dry_run)
  const log     = document.getElementById('aff-codes-log')
  const logText = document.getElementById('aff-codes-log-text')
  const timer   = document.getElementById('sync-timer')

  // Desabilita todos os botões do bot
  const btns = ['btn-auto-sync','btn-only-import','btn-only-search','btn-only-prices']
  btns.forEach(id => { const b = document.getElementById(id); if (b) b.disabled = true })
  document.getElementById('btn-auto-sync').innerHTML = '<span>⏳</span> Rodando...'

  log.classList.remove('hidden')

  const LF = String.fromCharCode(10)
  const t0 = Date.now()

  // Cronômetro global
  const timerInt = setInterval(() => {
    const s = ((Date.now() - t0) / 1000).toFixed(1)
    if (timer) timer.textContent = s + 's'
  }, 200)

  // ── Acumuladores globais para o loop ─────────────────────
  let grandTotalActions  = 0
  let grandImported      = 0
  let grandUpdatedImp    = 0
  let grandSearchFound   = 0
  let grandPricesUpdated = 0
  let grandPricesUnchanged = 0
  let loopCount          = 0
  let lastError          = null
  const allSearchProducts = []

  const appendLog = (txt) => {
    logText.textContent += txt + LF
    logText.scrollTop = logText.scrollHeight
  }

  logText.textContent = '🚀 Iniciando Bot Automático ML...' + LF +
    '────────────────────────────────' + LF +
    '📌 Etapas: ' + steps.join(', ') + LF +
    '⚡ Limit=1 por chamada · loop automático com has_more' + LF + LF

  // ── Loop principal ────────────────────────────────────────
  // Continua chamando o backend enquanto has_more = true
  // Limite de segurança: 60 iterações (~60 produtos por sessão)
  const MAX_LOOPS = 60
  let hasMore = true

  while (hasMore && loopCount < MAX_LOOPS) {
    loopCount++
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    appendLog(`⏳ Rodada ${loopCount} (${elapsed}s)...`)

    const res = await api('POST', '/admin/api/affiliate-bot/auto-sync', {
      steps,
      dry_run:       dryRun,
      search_limit:  1,
      prices_limit:  1,
    })

    if (!res) {
      lastError = 'Erro de rede'
      appendLog('❌ Erro de rede — abortando loop')
      break
    }
    if (!res.ok && !res.report) {
      lastError = res.error || 'Erro desconhecido'
      appendLog('❌ ' + lastError)
      break
    }

    // Acumula métricas
    const r = res.report || {}
    if (r.import) {
      grandImported   += (r.import.imported || 0)
      grandUpdatedImp += (r.import.updated  || 0)
      if (r.import.status === 'blocked') appendLog('  ⛔ import: bot challenge detectado')
      else if (r.import.status === 'error') appendLog('  ❌ import: ' + (r.import.error || 'erro'))
    }
    if (r.search) {
      grandSearchFound += (r.search.found || 0)
      if (r.search.products) allSearchProducts.push(...r.search.products)
      const pending = r.search.total_pending ?? '?'
      if (r.search.status === 'no_credits') {
        appendLog('  🪙 search: créditos GeckoAPI esgotados — recarregue em geckoapi.com.br')
        lastError = r.search.error || 'Créditos esgotados'
      } else {
        appendLog(`  🔍 search: +${r.search.found||0} encontrado(s) | ${r.search.skipped||0} skip | pendentes: ${pending}`)
      }
    }
    if (r.prices) {
      grandPricesUpdated   += (r.prices.updated   || 0)
      grandPricesUnchanged += (r.prices.unchanged || 0)
      const stale = r.prices.total_stale ?? '?'
      if (r.prices.status === 'no_credits') {
        appendLog('  🪙 prices: créditos GeckoAPI esgotados — recarregue em geckoapi.com.br')
        lastError = r.prices.error || 'Créditos esgotados'
      } else {
        appendLog(`  💰 prices: +${r.prices.updated||0} atualizado(s) | ${r.prices.skipped||0} skip | desatualiz.: ${stale}`)
      }
    }

    grandTotalActions += (res.total_actions || 0)
    hasMore = !!res.has_more

    // Créditos esgotados → para o loop (não adianta continuar)
    const noCredits = (r.search?.status === 'no_credits') || (r.prices?.status === 'no_credits')
    if (noCredits) {
      appendLog('  🛑 Loop interrompido — sem créditos GeckoAPI')
      break
    }

    if (!hasMore) {
      appendLog('  ✅ has_more=false — todos os produtos processados!')
    }
  }

  // ── Finaliza ─────────────────────────────────────────────
  clearInterval(timerInt)
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  if (timer) timer.textContent = elapsed + 's'

  btns.forEach(id => { const b = document.getElementById(id); if (b) b.disabled = false })
  document.getElementById('btn-auto-sync').innerHTML = '<span>🚀</span> Rodar Bot Completo'

  // Resumo final
  appendLog('')
  appendLog('════════════════════════════════')
  appendLog('🏁 RESUMO FINAL — ' + elapsed + 's · ' + loopCount + ' rodada(s)')
  appendLog('────────────────────────────────')
  if (steps.includes('import'))  appendLog('  🛒 Importados  : ' + grandImported + '  |  Atualizados: ' + grandUpdatedImp)
  if (steps.includes('search'))  appendLog('  🔍 Vinculados  : ' + grandSearchFound)
  if (steps.includes('prices')) {
    appendLog('  💹 Preços alt. : ' + grandPricesUpdated)
    appendLog('  ═  Preços igua.: ' + grandPricesUnchanged)
  }
  appendLog('  🎯 Total ações : ' + grandTotalActions)
  if (dryRun)    appendLog('  🧪 DRY RUN — nada foi salvo')
  if (lastError) appendLog('  ❌ Último erro : ' + lastError)
  if (loopCount >= MAX_LOOPS) appendLog('  ⚠  Limite de ' + MAX_LOOPS + ' rodadas atingido')

  if (allSearchProducts.length > 0) {
    appendLog('')
    appendLog('  🔗 Produtos vinculados nesta sessão:')
    allSearchProducts.slice(0, 10).forEach(p => {
      appendLog('    • ' + p.name + ' → ' + p.ml_id + (p.price ? '  R$' + p.price : ''))
    })
    if (allSearchProducts.length > 10) appendLog('    ... e mais ' + (allSearchProducts.length - 10))
  }

  logText.scrollTop = logText.scrollHeight
  toast('🤖 Bot: ' + grandTotalActions + ' ações em ' + loopCount + ' rodadas (' + elapsed + 's)',
        grandTotalActions > 0 ? 'success' : 'info')

  if (grandTotalActions > 0) {
    setTimeout(() => renderAffiliateCodes(document.getElementById('content-area')), 2000)
  }
}

async function generateAllLinks() {
  const log     = document.getElementById('aff-codes-log')
  const logText = document.getElementById('aff-codes-log-text')
  log.classList.remove('hidden')
  logText.textContent = '🔗 Regenerando TODOS os links afiliados...'

  const res = await api('POST', '/admin/api/affiliate-rules/generate', {})
  if (!res || !res.ok) {
    logText.textContent = '❌ Erro: ' + (res?.error || 'desconhecido')
    toast('Erro ao gerar links', 'error')
    return
  }
  const LF = String.fromCharCode(10)
  const lines = ['✅ Links gerados!', '────────────────────', 'Total: ' + res.total_updated, '']
  if (res.summary) {
    Object.values(res.summary).forEach(s => {
      lines.push('  ' + (s.updated > 0 ? '✅' : '⏭') + ' ' + s.label + ': ' + s.updated)
    })
  }
  if (res.tip) lines.push('', '💡 ' + res.tip)
  logText.textContent = lines.join(LF)
  toast('🔗 ' + res.total_updated + ' links gerados!', res.total_updated > 0 ? 'success' : 'warning')
  if (res.total_updated > 0) setTimeout(() => renderAffiliateCodes(document.getElementById('content-area')), 1500)
}

async function importAllOffers() {
  runAutoSync({ steps: ['import'] })
}

// ══════════════════════════════════════════════════════════
// IMPORTAR DO BUSCAPÉ — scraping JSON-LD + links afiliados
// ══════════════════════════════════════════════════════════
async function renderBuscapeImport(area) {
  // Busca produtos já importados do Buscapé
  const products = await api('GET', '/admin/api/products?source=buscape&limit=50') || {}
  const buscapeProds = (products.results || []).filter(p => p.buscape_url)

  area.innerHTML = `
    <div class="section space-y-6">

      <!-- Cabeçalho hero -->
      <div class="stat-card" style="background:linear-gradient(135deg,#f97316 0%,#ea580c 100%);color:#fff;border:none">
        <div class="flex items-center gap-4">
          <div class="text-5xl">🛒</div>
          <div>
            <h2 class="text-2xl font-bold">Importar do Buscapé</h2>
            <p class="text-orange-100 text-sm mt-1">
              Cole a URL de qualquer produto do Buscapé — o sistema importa automaticamente
              os preços de <strong>todas as lojas</strong> (Casas Bahia, Magalu, Americanas, Ponto, Extra, Fast Shop…)
              e gera <strong>links de afiliado</strong> para cada uma.
            </p>
          </div>
        </div>
      </div>

      <!-- Como funciona -->
      <div class="stat-card">
        <h3 class="font-bold text-slate-800 mb-3">💡 Como funciona</h3>
        <div class="grid grid-cols-1 md:grid-cols-4 gap-3 text-center text-sm">
          <div class="bg-orange-50 rounded-xl p-3">
            <div class="text-2xl mb-1">1️⃣</div>
            <div class="font-semibold text-slate-700">Cole a URL</div>
            <div class="text-slate-500 text-xs">Qualquer página de produto do buscape.com.br</div>
          </div>
          <div class="bg-orange-50 rounded-xl p-3">
            <div class="text-2xl mb-1">2️⃣</div>
            <div class="font-semibold text-slate-700">Scrapia JSON-LD</div>
            <div class="text-slate-500 text-xs">Extrai nome, marca, imagem e todas as ofertas por loja</div>
          </div>
          <div class="bg-orange-50 rounded-xl p-3">
            <div class="text-2xl mb-1">3️⃣</div>
            <div class="font-semibold text-slate-700">Salva no Banco</div>
            <div class="text-slate-500 text-xs">Cria produto + ofertas com preço de cada loja</div>
          </div>
          <div class="bg-orange-50 rounded-xl p-3">
            <div class="text-2xl mb-1">4️⃣</div>
            <div class="font-semibold text-slate-700">Gera Afiliados</div>
            <div class="text-slate-500 text-xs">Link de afiliado automático por rede (Lomadee…)</div>
          </div>
        </div>
      </div>

      <!-- Formulário de importação -->
      <div class="stat-card">
        <h3 class="font-bold text-slate-800 mb-4">🔗 Importar novo produto</h3>
        <div class="flex gap-2">
          <input type="url" id="buscape-url-input"
            placeholder="https://www.buscape.com.br/aspirador-de-po/modelo-xpto-123abc"
            class="input flex-1 font-mono text-sm"
            onkeydown="if(event.key==='Enter') importBuscape()">
          <button onclick="importBuscape()" id="btn-import-buscape"
            class="btn-primary px-6 flex items-center gap-2 whitespace-nowrap"
            style="background:linear-gradient(135deg,#f97316,#ea580c)">
            <span id="buscape-btn-icon">🛒</span>
            <span id="buscape-btn-text">Importar</span>
          </button>
        </div>
        <p class="text-xs text-slate-400 mt-2">
          Exemplo: <code class="bg-slate-100 px-1.5 py-0.5 rounded">https://www.buscape.com.br/ar-condicionado/lg-dual-inverter-9000-btus-s4-q09ja31a-1234abc</code>
        </p>

        <!-- Terminal de resultado -->
        <div id="buscape-log-wrap" class="mt-4 hidden">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-semibold text-slate-500 uppercase tracking-wide">📟 Log de Importação</span>
            <button onclick="document.getElementById('buscape-log-wrap').classList.add('hidden')"
              class="text-xs text-slate-400 hover:text-slate-600">✕ Fechar</button>
          </div>
          <div id="buscape-log"
            class="bg-slate-950 text-green-400 rounded-xl p-4 font-mono text-xs leading-relaxed min-h-[120px] max-h-72 overflow-y-auto whitespace-pre-wrap border border-slate-800">
            Aguardando…
          </div>
        </div>
      </div>

      <!-- Atualização em lote -->
      <div class="stat-card">
        <div class="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <h3 class="font-bold text-slate-800">🔄 Atualizar preços do Buscapé</h3>
            <p class="text-sm text-slate-500">Reprocessa os produtos já cadastrados — ideal para rodar diariamente</p>
          </div>
          <div class="flex gap-2">
            <button onclick="refreshBuscape(5)" class="btn-secondary text-sm">↻ Atualizar 5</button>
            <button onclick="refreshBuscape(20)" class="btn-primary text-sm"
              style="background:linear-gradient(135deg,#f97316,#ea580c)">↻ Atualizar 20</button>
          </div>
        </div>
        <div id="buscape-refresh-log" class="hidden">
          <div class="bg-slate-950 text-green-400 rounded-xl p-3 font-mono text-xs leading-relaxed max-h-48 overflow-y-auto whitespace-pre-wrap border border-slate-800"
               id="buscape-refresh-log-text">Aguardando…</div>
        </div>
      </div>

      <!-- Produtos já importados -->
      <div class="stat-card">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-bold text-slate-800">📦 Produtos importados do Buscapé
            <span class="ml-2 text-sm font-normal text-slate-500">(${buscapeProds.length} encontrado(s))</span>
          </h3>
          <button onclick="renderBuscapeImport(document.getElementById('content-area'))"
            class="btn-secondary text-sm">↻ Atualizar lista</button>
        </div>
        ${buscapeProds.length === 0
          ? `<div class="text-center py-8 text-slate-400">
               <div class="text-4xl mb-2">📭</div>
               <p>Nenhum produto importado do Buscapé ainda.</p>
               <p class="text-sm mt-1">Cole uma URL acima para começar!</p>
             </div>`
          : `<div class="space-y-2" id="buscape-prods-list">
               ${buscapeProds.map(p => `
                 <div class="flex items-center gap-3 p-3 bg-slate-50 rounded-xl hover:bg-orange-50 transition-colors">
                   <img src="${p.image_url || 'https://placehold.co/48x48/f97316/fff?text=B'}"
                     class="w-12 h-12 object-contain rounded-lg bg-white border border-slate-200 flex-shrink-0"
                     onerror="this.src='https://placehold.co/48x48/f97316/fff?text=B'">
                   <div class="flex-1 min-w-0">
                     <div class="font-semibold text-slate-800 text-sm truncate">${p.name}</div>
                     <div class="text-xs text-slate-500">
                       ${p.brand ? `<span class="mr-2">${p.brand}</span>` : ''}
                       ${p.offer_count ? `<span class="text-orange-600 font-semibold">${p.offer_count} oferta(s)</span>` : ''}
                       ${p.best_price ? ` · Melhor: <strong>R$ ${Number(p.best_price).toFixed(2).replace('.',',')}</strong>` : ''}
                     </div>
                     <div class="text-xs text-slate-400 truncate mt-0.5">${p.buscape_url || ''}</div>
                   </div>
                   <div class="flex gap-2 flex-shrink-0">
                     <button onclick="refreshOneBuscape('${(p.buscape_url||'').replace(/'/g,'')}','${p.name.replace(/'/g,'').slice(0,30)}')"
                       title="Atualizar preços desta URL" class="btn-secondary text-xs px-2 py-1">↻</button>
                     <a href="/produto/${p.slug}" target="_blank"
                       class="btn-secondary text-xs px-2 py-1">👁 Ver</a>
                   </div>
                 </div>
               `).join('')}
             </div>`
        }
      </div>

      <!-- Dica de afiliados por loja -->
      <div class="stat-card border border-orange-100 bg-orange-50">
        <h3 class="font-bold text-orange-800 mb-3">💰 Redes de afiliado por loja</h3>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          ${[
            ['Casas Bahia','manual','#22c55e'],['Ponto','manual','#22c55e'],['Extra','manual','#22c55e'],
            ['Americanas','manual','#22c55e'],['Fast Shop','manual','#22c55e'],
            ['Magazine Luiza','lomadee','#3b82f6'],['Centauro','lomadee','#3b82f6'],
            ['Amazon','amazon-pa-api','#f59e0b'],['Mercado Livre','meli-api','#eab308'],
            ['Shopee','shopee-api','#f97316'],
          ].map(([name, net, color]) =>
            `<div class="bg-white rounded-lg p-2 flex items-center gap-2">
               <span class="w-2 h-2 rounded-full flex-shrink-0" style="background:${color}"></span>
               <span class="font-semibold text-slate-700">${name}</span>
               <span class="text-slate-400 ml-auto">${net}</span>
             </div>`
          ).join('')}
        </div>
        <p class="text-xs text-orange-700 mt-3">
          ⚙️ Configure os publisher IDs em <button onclick="showSection('affiliate-codes')"
            class="underline font-semibold hover:text-orange-900">Códigos Afiliados</button>
          para ativar a geração automática dos links.
        </p>
      </div>

    </div>
  `
}

// ── Importar uma URL do Buscapé ───────────────────────────
async function importBuscape() {
  const input = document.getElementById('buscape-url-input')
  const url   = (input?.value || '').trim()
  if (!url) { toast('Cole uma URL do Buscapé primeiro', 'warning'); return }

  const btn     = document.getElementById('btn-import-buscape')
  const btnIcon = document.getElementById('buscape-btn-icon')
  const btnText = document.getElementById('buscape-btn-text')
  const logWrap = document.getElementById('buscape-log-wrap')
  const log     = document.getElementById('buscape-log')

  if (btn) btn.disabled = true
  if (btnIcon) btnIcon.textContent = '⏳'
  if (btnText) btnText.textContent = 'Importando…'
  logWrap?.classList.remove('hidden')
  if (log) log.textContent = '⏳ Buscando página em buscape.com.br…\n'

  const LF = '\n'
  const t0  = Date.now()

  const res = await api('POST', '/admin/api/affiliate-bot/import-buscape', { url })

  if (btn) btn.disabled = false
  if (btnIcon) btnIcon.textContent = '🛒'
  if (btnText) btnText.textContent = 'Importar'

  if (!res || !res.ok) {
    if (log) log.textContent += `❌ Erro: ${res?.error || 'Falha desconhecida'}` + LF
    toast(res?.error || 'Erro na importação', 'error')
    return
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  let lines = []
  lines.push(`✅ ${res.is_new ? 'Produto CRIADO' : 'Produto ATUALIZADO'} em ${elapsed}s`)
  lines.push(`   📦 ${res.product_name}${res.product_brand ? ' — ' + res.product_brand : ''}`)
  lines.push(`   ID banco: #${res.product_id}  |  Buscapé ID: ${res.buscape_product_id || '—'}`)
  lines.push(`   Preço mínimo: R$ ${res.best_price ? Number(res.best_price).toFixed(2).replace('.',',') : '—'}`)
  lines.push('')
  lines.push(`📊 ${res.total} oferta(s) processada(s): ${res.imported} nova(s) · ${res.updated} atualizada(s)`)
  lines.push('')

  if (res.offers && res.offers.length > 0) {
    lines.push('Lojas importadas:')
    res.offers.forEach(o => {
      const statusIcon = o.status === 'imported' ? '🆕' : o.status === 'updated' ? '🔄' : '⚠️'
      const price = o.price ? `R$ ${Number(o.price).toFixed(2).replace('.',',')}` : '—'
      const oid   = o.oid  ? `OID:${o.oid}` : ''
      lines.push(`  ${statusIcon} ${o.store.padEnd(18)} ${price.padStart(12)}  ${oid}`)
      if (o.affiliate_url) {
        lines.push(`     🔗 ${o.affiliate_url.slice(0, 80)}${o.affiliate_url.length > 80 ? '…' : ''}`)
      }
      if (o.status === 'store_not_found') {
        lines.push(`     ⚠️  Loja não encontrada no banco (slug tentado: ${o.slug_tried})`)
      }
    })
  }

  if (res.tip) lines.push('', '💡 ' + res.tip)

  if (log) log.textContent = lines.join(LF)
  toast(`🛒 ${res.imported} importada(s) · ${res.updated} atualizada(s)`, res.total > 0 ? 'success' : 'warning')

  // Limpa o input e recarrega a lista após 2s
  if (input) input.value = ''
  if (res.total > 0) setTimeout(() => renderBuscapeImport(document.getElementById('content-area')), 2000)
}

// ── Atualizar preços em lote (refresh-buscape) ────────────
async function refreshBuscape(limit) {
  const logEl = document.getElementById('buscape-refresh-log')
  const logText = document.getElementById('buscape-refresh-log-text')
  logEl?.classList.remove('hidden')
  if (logText) logText.textContent = `⏳ Atualizando até ${limit} produto(s)…\n`

  const LF = '\n'
  const t0 = Date.now()
  const res = await api('POST', '/admin/api/affiliate-bot/refresh-buscape', { limit })

  if (!res || !res.ok) {
    if (logText) logText.textContent += `❌ ${res?.error || 'Erro desconhecido'}` + LF
    toast('Erro no refresh do Buscapé', 'error')
    return
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  let lines = []
  lines.push(`✅ ${res.processed} produto(s) processado(s) em ${elapsed}s`)
  lines.push(`   ${res.imported} nova(s) · ${res.updated} atualizada(s) · ${res.errors} erro(s)`)
  if (res.has_more) lines.push('   ⚠️  Ainda há mais produtos — rode novamente para continuar')
  lines.push('')
  if (res.results && res.results.length > 0) {
    res.results.forEach(r => {
      const icon = r.ok ? (r.imported + r.updated > 0 ? '✅' : '⏭') : '❌'
      lines.push(`  ${icon} ${r.product}`)
      if (!r.ok && r.error) lines.push(`     ❌ ${r.error}`)
    })
  }
  if (logText) logText.textContent = lines.join(LF)
  toast(`↻ Buscapé: ${res.updated} preços atualizados`, res.updated > 0 ? 'success' : 'info')
  if (res.updated > 0) setTimeout(() => renderBuscapeImport(document.getElementById('content-area')), 1500)
}

// ── Atualizar um produto individual ──────────────────────
async function refreshOneBuscape(url, name) {
  if (!url) return
  toast(`⏳ Atualizando ${name}…`, 'info')
  const res = await api('POST', '/admin/api/affiliate-bot/import-buscape', { url })
  if (res?.ok) {
    toast(`✅ ${name}: ${res.updated} atualizado(s)`, 'success')
    setTimeout(() => renderBuscapeImport(document.getElementById('content-area')), 800)
  } else {
    toast(`❌ ${res?.error || 'Erro'}`, 'error')
  }
}

// ══════════════════════════════════════════════════════════
// LOMADEE — API oficial (136 lojas, link afiliado automático)
// ══════════════════════════════════════════════════════════
async function renderLomadeeImport(area) {
  const status = await api('GET', '/admin/api/lomadee/status') || {}

  area.innerHTML = `
    <div class="section space-y-6">

      <!-- Hero -->
      <div class="stat-card" style="background:linear-gradient(135deg,#e85d04 0%,#9c2a00 100%);color:#fff;border:none">
        <div class="flex items-center gap-4 flex-wrap">
          <div class="text-5xl">🟠</div>
          <div class="flex-1">
            <h2 class="text-2xl font-bold">Lomadee / Social Soul</h2>
            <p class="text-orange-100 text-sm mt-1">
              API oficial de afiliados — <strong>${status.api_total_brands || '136'}+ lojas parceiras</strong>
              com link rastreado gerado automaticamente.
              Cada clique gera comissão diretamente na sua conta Lomadee.
            </p>
          </div>
          <div class="text-right flex-shrink-0">
            ${status.configured
              ? `<span class="bg-green-400 text-green-900 font-bold px-3 py-1.5 rounded-lg text-sm">✅ API Conectada</span>
                 <p class="text-orange-200 text-xs mt-1">${status.db_stores_synced || 0} lojas · ${status.db_offers_imported || 0} ofertas</p>`
              : `<span class="bg-red-400 text-red-900 font-bold px-3 py-1.5 rounded-lg text-sm">⚠️ API Key Faltando</span>`
            }
          </div>
        </div>
        ${!status.configured ? `
          <div class="mt-3 bg-black/20 rounded-xl p-3 text-sm text-orange-100">
            <strong>Configure:</strong> No painel Cloudflare Pages → Settings → Environment Variables → adicione
            <code class="bg-black/30 px-1.5 py-0.5 rounded font-mono">LOMADEE_API_KEY</code>
            com o seu Token da Lomadee.
          </div>` : ''}
      </div>

      ${!status.configured ? '' : `
      <!-- Sincronizar lojas -->
      <div class="stat-card">
        <div class="flex items-center justify-between flex-wrap gap-3 mb-3">
          <div>
            <h3 class="font-bold text-slate-800">🏪 1. Sincronizar Lojas Parceiras</h3>
            <p class="text-sm text-slate-500">Importa todas as marcas da Lomadee para a tabela <code>stores</code> com a rede <code>lomadee-api</code></p>
          </div>
          <div class="flex gap-2">
            <button onclick="lomadeeSyncBrands()" id="btn-lom-sync"
              class="btn-primary flex items-center gap-2"
              style="background:linear-gradient(135deg,#e85d04,#9c2a00)">
              🏪 Sincronizar ${status.api_total_brands || '136'} lojas
            </button>
            <button onclick="lomadeeLoadBrands()" class="btn-secondary text-sm">👁 Ver lista</button>
          </div>
        </div>
        <div id="lom-brands-log" class="hidden">
          <div class="bg-slate-950 text-green-400 rounded-xl p-3 font-mono text-xs leading-relaxed max-h-48 overflow-y-auto whitespace-pre-wrap border border-slate-800"
               id="lom-brands-log-text">Aguardando…</div>
        </div>
        <div id="lom-brands-list" class="hidden mt-3"></div>
      </div>

      <!-- Buscar e importar produtos -->
      <div class="stat-card">
        <h3 class="font-bold text-slate-800 mb-3">🔍 2. Buscar e Importar Produtos</h3>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
          <div class="md:col-span-2">
            <label class="label">Termo de busca</label>
            <input type="text" id="lom-search"
              placeholder="ex: air fryer, notebook, smartphone..."
              class="input"
              onkeydown="if(event.key==='Enter') lomadeeSearch(false)">
          </div>
          <div>
            <label class="label">Loja (opcional)</label>
            <select id="lom-org-select" class="input text-sm">
              <option value="">Todas as lojas</option>
            </select>
          </div>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <div>
            <label class="label">Preço mín (R$)</label>
            <input type="number" id="lom-price-min" placeholder="0" class="input text-sm">
          </div>
          <div>
            <label class="label">Preço máx (R$)</label>
            <input type="number" id="lom-price-max" placeholder="9999" class="input text-sm">
          </div>
          <div>
            <label class="label">Qtd por busca</label>
            <select id="lom-limit" class="input text-sm">
              <option value="10">10 produtos</option>
              <option value="20" selected>20 produtos</option>
              <option value="50">50 produtos</option>
              <option value="100">100 produtos</option>
            </select>
          </div>
          <div class="flex flex-col justify-end gap-2">
            <button onclick="lomadeeSearch(true)" class="btn-secondary text-sm">🔍 Simular</button>
            <button onclick="lomadeeSearch(false)" id="btn-lom-import"
              class="btn-primary text-sm"
              style="background:linear-gradient(135deg,#e85d04,#9c2a00)">
              ⬇️ Importar
            </button>
          </div>
        </div>

        <!-- Terminal de resultado -->
        <div id="lom-import-log" class="hidden">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-semibold text-slate-500 uppercase tracking-wide">📟 Log de Importação</span>
            <button onclick="document.getElementById('lom-import-log').classList.add('hidden')"
              class="text-xs text-slate-400 hover:text-slate-600">✕</button>
          </div>
          <div id="lom-import-log-text"
            class="bg-slate-950 text-green-400 rounded-xl p-4 font-mono text-xs leading-relaxed min-h-[120px] max-h-80 overflow-y-auto whitespace-pre-wrap border border-slate-800">
            Aguardando…
          </div>
        </div>
      </div>

      <!-- Como funciona -->
      <div class="stat-card border border-orange-100 bg-orange-50">
        <h3 class="font-bold text-orange-800 mb-3">💡 Como funciona o link afiliado</h3>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
          <div class="bg-white rounded-xl p-3">
            <div class="font-semibold text-slate-700 mb-1">1️⃣ Produto encontrado</div>
            <div class="text-slate-500 text-xs">A API retorna nome, preço, imagem, EAN e URL da loja</div>
          </div>
          <div class="bg-white rounded-xl p-3">
            <div class="font-semibold text-slate-700 mb-1">2️⃣ Shortlink gerado</div>
            <div class="text-slate-500 text-xs">
              <code class="bg-slate-100 px-1 rounded">POST /affiliate/shortener/url</code>
              cria um link rastreado automaticamente com seu ID de afiliado
            </div>
          </div>
          <div class="bg-white rounded-xl p-3">
            <div class="font-semibold text-slate-700 mb-1">3️⃣ Comissão automática</div>
            <div class="text-slate-500 text-xs">
              Quando o usuário clica e compra, a Lomadee registra e paga a comissão na sua conta
            </div>
          </div>
        </div>
        <p class="text-xs text-orange-700 mt-3">
          ⚠️ O link só gera comissão se sua conta Lomadee estiver aprovada pela loja. Verifique em
          <a href="https://app.lomadee.com" target="_blank" class="underline font-semibold">app.lomadee.com</a>.
        </p>
      </div>
      `}

    </div>
  `

  // Popula o select de lojas com as que já foram sincronizadas
  if (status.configured && status.db_stores_synced > 0) {
    const storesData = await api('GET', '/admin/api/lomadee/brands?limit=100') || {}
    const sel = document.getElementById('lom-org-select')
    if (sel && storesData.brands) {
      storesData.brands.forEach(b => {
        const opt = document.createElement('option')
        opt.value = b.id
        opt.textContent = `${b.name} (${b.commission}%)`
        sel.appendChild(opt)
      })
    }
  }
}

// ── Sincronizar todas as lojas Lomadee → banco ────────────
async function lomadeeSyncBrands() {
  const btn = document.getElementById('btn-lom-sync')
  const logEl  = document.getElementById('lom-brands-log')
  const logText = document.getElementById('lom-brands-log-text')
  if (btn) btn.disabled = true
  logEl?.classList.remove('hidden')
  if (logText) logText.textContent = '⏳ Sincronizando lojas da Lomadee…\n'

  const t0 = Date.now()
  const res = await api('POST', '/admin/api/lomadee/sync-brands')
  const elapsed = ((Date.now()-t0)/1000).toFixed(1)

  if (btn) btn.disabled = false

  if (!res?.ok) {
    if (logText) logText.textContent += `❌ ${res?.error || 'Erro desconhecido'}`
    toast('Erro ao sincronizar lojas', 'error')
    return
  }

  if (logText) logText.textContent = `✅ ${res.synced} loja(s) sincronizada(s) em ${elapsed}s\nRecarregando página…`
  toast(`🏪 ${res.synced} lojas importadas!`, 'success')
  setTimeout(() => renderLomadeeImport(document.getElementById('content-area')), 1200)
}

// ── Listar lojas (sem sincronizar) ────────────────────────
async function lomadeeLoadBrands() {
  const listEl = document.getElementById('lom-brands-list')
  if (!listEl) return
  listEl.classList.remove('hidden')
  listEl.innerHTML = '<div class="text-slate-500 text-sm">Carregando…</div>'

  const data = await api('GET', '/admin/api/lomadee/brands?limit=100') || {}
  const brands = data.brands || []

  listEl.innerHTML = `
    <h4 class="font-semibold text-slate-700 mb-2 text-sm">${data.total || brands.length} lojas disponíveis na Lomadee:</h4>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-2 max-h-64 overflow-y-auto pr-1">
      ${brands.map(b => `
        <div class="flex items-center gap-2 p-2 rounded-lg text-xs ${b.in_db ? 'bg-green-50 border border-green-200' : 'bg-slate-50 border border-slate-200'}">
          ${b.logo ? `<img src="${b.logo}" class="w-6 h-6 object-contain rounded flex-shrink-0" onerror="this.style.display='none'">` : '<span class="w-6 h-6 bg-orange-100 rounded flex-shrink-0 flex items-center justify-center text-xs">🏪</span>'}
          <div class="min-w-0">
            <div class="font-semibold text-slate-700 truncate">${b.name}</div>
            <div class="text-slate-400">${b.commission}% · ${b.in_db ? '✅ no banco' : '➕ não sync'}</div>
          </div>
        </div>
      `).join('')}
    </div>
  `
}

// ── Buscar/importar produtos da Lomadee ───────────────────
async function lomadeeSearch(dryRun) {
  const search   = (document.getElementById('lom-search')?.value || '').trim()
  const orgId    = document.getElementById('lom-org-select')?.value || ''
  const priceMin = parseFloat(document.getElementById('lom-price-min')?.value || '0') || null
  const priceMax = parseFloat(document.getElementById('lom-price-max')?.value || '0') || null
  const limit    = parseInt(document.getElementById('lom-limit')?.value || '20')

  if (!search && !orgId) { toast('Digite um termo de busca ou selecione uma loja', 'warning'); return }

  const btn    = document.getElementById('btn-lom-import')
  const logEl  = document.getElementById('lom-import-log')
  const logText = document.getElementById('lom-import-log-text')

  if (!dryRun && btn) btn.disabled = true
  logEl?.classList.remove('hidden')
  if (logText) logText.textContent = `⏳ ${dryRun ? 'Simulando' : 'Importando'} produtos Lomadee…\n`

  const LF = '\n'
  const t0 = Date.now()

  const res = await api('POST', '/admin/api/lomadee/import', {
    search: search || undefined,
    org_id: orgId || undefined,
    price_min: priceMin,
    price_max: priceMax,
    limit,
    dry_run: dryRun,
  })

  const elapsed = ((Date.now()-t0)/1000).toFixed(1)
  if (!dryRun && btn) btn.disabled = false

  if (!res?.ok) {
    if (logText) logText.textContent += `❌ ${res?.error || 'Erro desconhecido'}`
    toast(res?.error || 'Erro na importação Lomadee', 'error')
    return
  }

  const lines = []
  lines.push(`${dryRun ? '🔍 SIMULAÇÃO' : '✅ IMPORTADO'} em ${elapsed}s`)
  lines.push(`   ${res.imported || 0} novo(s) · ${res.updated || 0} atualizado(s) · Total API: ${res.api_total || '?'}`)
  lines.push('')

  const icons = { new_product:'🆕', new_offer:'➕', updated:'🔄', dry_run:'🔍', store_not_synced:'⚠️', no_option:'📭', price_zero:'💀' }
  ;(res.products || []).forEach(p => {
    const icon  = icons[p.status] || '❓'
    const price = p.price ? `R$ ${Number(p.price).toFixed(2).replace('.',',')}` : '—'
    const store = (p.store || '').slice(0,18).padEnd(18)
    lines.push(`  ${icon} ${store} ${price.padStart(12)}  ${(p.name || '').slice(0,45)}`)
    if (p.affiliate_url && dryRun) {
      lines.push(`     🔗 ${p.affiliate_url.slice(0,80)}`)
    }
    if (p.status === 'store_not_synced') {
      lines.push(`     ⚠️  Loja não sincronizada — clique em "Sincronizar lojas" primeiro`)
    }
  })

  if (res.tip) lines.push('', '💡 ' + res.tip)
  if (logText) logText.textContent = lines.join(LF)

  if (!dryRun) {
    toast(`🟠 Lomadee: ${res.imported} importado(s) · ${res.updated} atualizado(s)`,
      res.total > 0 ? 'success' : 'warning')
  } else {
    toast(`🔍 Simulação: ${(res.products||[]).length} produto(s) encontrado(s)`, 'info')
  }
}

// ── IMPORTAR DO MERCADO LIVRE ─────────────────────────────
async function renderMLImport(area) {
  const status = await api('GET', '/admin/api/ml/status')
  const connected = status?.connected === true

  area.innerHTML = `
    <div class="section space-y-6">

      <!-- Status da conexão ML -->
      <div class="stat-card">
        <div class="flex items-center gap-4 flex-wrap">
          <div class="w-14 h-14 bg-yellow-400 rounded-2xl flex items-center justify-center text-2xl shadow-md flex-shrink-0">🟡</div>
          <div class="flex-1 min-w-0">
            <h3 class="font-bold text-slate-800 text-lg">Mercado Livre API</h3>
            <p class="text-sm text-slate-500">APP ID: <code class="bg-slate-100 px-1.5 py-0.5 rounded font-mono text-xs">3098423019766450</code></p>
            <p class="text-sm text-slate-500">Publisher ID: <code class="bg-slate-100 px-1.5 py-0.5 rounded font-mono text-xs">cfegdhabc31955</code></p>
          </div>
          <div class="text-right flex-shrink-0">
            ${connected
              ? `<span class="badge-green text-sm px-3 py-1.5">[OK] Conectado</span>
                 <p class="text-xs text-slate-400 mt-1">User ID: ${status?.user_id || '—'}</p>`
              : `<a href="/api/ml/auth" target="_blank"
                   class="inline-flex items-center gap-2 bg-yellow-400 hover:bg-yellow-500 text-slate-900 font-bold px-4 py-2.5 rounded-xl transition-colors shadow text-sm">
                   🔗 Conectar ao ML
                 </a>
                 <p class="text-xs text-red-500 mt-1.5 font-semibold"> Autorização necessária</p>`
            }
          </div>
        </div>

        ${!connected ? `
        <div class="mt-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">
          <p class="font-bold mb-1">🔐 Como conectar:</p>
          <ol class="list-decimal ml-4 space-y-1">
            <li>Clique em <strong>"Conectar ao ML"</strong> acima</li>
            <li>Faça login na sua conta Mercado Livre</li>
            <li>Autorize o app <strong>KainowRadar</strong></li>
            <li>Volte aqui — o status ficará verde ✅</li>
          </ol>
        </div>
        ` : `
        <div class="mt-3 bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-800">
          ✅ Conectado! Você pode importar produtos diretamente via URL abaixo.
        </div>
        `}
      </div>

      <!-- ══════════════════════════════════════════
           IMPORTAR POR IDs EM LOTE (substitui busca por keyword)
      ══════════════════════════════════════════ -->
      <div class="stat-card">
        <div class="flex items-center gap-3 mb-3">
          <span class="text-2xl">📋</span>
          <div>
            <h3 class="font-bold text-slate-800 text-base">Importar Produtos por ID em Lote</h3>
            <p class="text-xs text-slate-500">Cole IDs ou URLs do ML — o sistema busca preço, gera link de afiliado e salva automaticamente.</p>
          </div>
        </div>

        <!-- Aviso sobre busca por keyword -->
        <div class="mb-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-800">
          <p class="font-bold text-sm mb-1">⚠️ Por que não tem busca por keyword?</p>
          <p>A API de busca do ML (<code class="bg-amber-100 px-1 rounded">/sites/MLB/search</code>) bloqueia IPs de datacenter (Cloudflare). Em vez disso: <strong>pesquise no site do ML pelo browser → copie os IDs/URLs → cole aqui</strong>.</p>
          <a href="https://www.mercadolivre.com.br" target="_blank" class="mt-1.5 inline-flex items-center gap-1 text-amber-700 font-semibold hover:underline">🔗 Abrir Mercado Livre →</a>
        </div>

        <!-- Como pegar os IDs -->
        <div class="mb-4 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-xs text-blue-900">
          <p class="font-bold mb-1.5">📌 Como encontrar IDs no ML:</p>
          <div class="space-y-1.5">
            <p>• <strong>URL de catálogo</strong> (recomendado): <code class="bg-blue-100 px-1 rounded">mercadolivre.com.br/produto/p/<strong>MLB28965210</strong></code></p>
            <p>• <strong>URL de anúncio</strong>: <code class="bg-blue-100 px-1 rounded">produto.mercadolivre.com.br/<strong>MLB-3456789012</strong>-titulo</code></p>
            <p>• <strong>ID direto</strong>: <code class="bg-blue-100 px-1 rounded">MLB28965210</code> ou <code class="bg-blue-100 px-1 rounded">MLB3456789012</code></p>
          </div>
        </div>

        <div class="space-y-3">
          <div>
            <label class="block text-xs font-semibold text-slate-500 mb-1.5">
              IDs ou URLs do ML <span class="font-normal text-slate-400">(um por linha ou separados por vírgula)</span>
            </label>
            <textarea id="ml-kw-input" rows="5"
              class="input font-mono text-xs resize-y"
              placeholder="MLB28965210
MLB3456789012
https://www.mercadolivre.com.br/produto/p/MLB28765432
https://produto.mercadolivre.com.br/MLB-3456789012-titulo
..."></textarea>
          </div>

          <div class="flex gap-3 flex-wrap">
            <select id="ml-kw-category" class="input w-48">
              <option value="outros">🔠 Auto-detectar categoria</option>
              <option value="smartphones">📱 Smartphones</option>
              <option value="notebooks">💻 Notebooks</option>
              <option value="tv">📺 TVs & Smart TVs</option>
              <option value="games">🎮 Games & Consoles</option>
              <option value="audio">🎧 Áudio & Fones</option>
              <option value="cameras">📷 Câmeras & Drones</option>
              <option value="eletrodomesticos">🏠 Eletrodomésticos</option>
              <option value="tablets">📟 Tablets & iPads</option>
              <option value="perfumes">🌸 Perfumes</option>
              <option value="moda-calcados">👟 Moda & Calçados</option>
            </select>
            <button onclick="importMLByIds()" id="btn-ml-kw" class="btn-primary flex items-center gap-2 px-5">
              <span>📥</span> Importar IDs
            </button>
          </div>
        </div>

        <!-- Log importação -->
        <div id="ml-kw-log" class="hidden mt-4">
          <div class="bg-slate-900 text-green-400 rounded-xl p-4 font-mono text-xs min-h-[80px] whitespace-pre-wrap overflow-auto max-h-[300px]" id="ml-kw-log-text">Aguardando...</div>
        </div>

        <!-- Resultados -->
        <div id="ml-kw-results" class="hidden mt-4 space-y-2">
          <p class="text-sm font-semibold text-slate-700" id="ml-kw-found"></p>
          <div id="ml-kw-list" class="space-y-2"></div>
        </div>
      </div>

      <!-- ══════════════════════════════════════════
           IMPORTAR POR URL (método principal)
      ══════════════════════════════════════════ -->
      <div class="stat-card ${!connected ? 'opacity-60 pointer-events-none' : ''}">
        <div class="flex items-center gap-3 mb-1">
          <span class="text-2xl">🔗</span>
          <div>
            <h3 class="font-bold text-slate-800 text-base">Importar por URL do Produto</h3>
            <p class="text-xs text-slate-500">Cole URLs do ML (uma por linha). Funciona com qualquer link: produto, anúncio, afiliado.</p>
          </div>
        </div>

        <!-- Instrução de uso -->
        <div class="mt-3 mb-4 space-y-3 text-xs">

          <!-- Método recomendado -->
          <div class="bg-green-50 border border-green-300 rounded-xl px-4 py-3 text-green-900">
            <p class="font-bold text-sm mb-2">✅ Método mais fácil — URL direta do ML</p>
            <ol class="list-decimal ml-4 space-y-1">
              <li>Abra <a href="https://www.mercadolivre.com.br" target="_blank" class="underline font-semibold">mercadolivre.com.br</a> e encontre o produto que quer importar</li>
              <li>Copie a URL da <strong>barra de endereços</strong> do browser</li>
              <li>Cole aqui abaixo e clique em Importar</li>
            </ol>
            <div class="mt-2 bg-green-100 rounded-lg px-3 py-2 font-mono text-green-800 break-all">
              Ex: https://www.mercadolivre.com.br/samsung-galaxy-s24/p/MLB28765432
            </div>
            <p class="mt-1.5 text-green-700">💡 O sistema adiciona seu affiliate ID (<code class="bg-green-100 px-1 rounded">cfegdhabc31955</code>) automaticamente.</p>
          </div>

          <!-- Linkbuilder — fluxo correto -->
          <div class="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-blue-900">
            <p class="font-bold mb-2">📋 Via Linkbuilder (gera link com tracking)</p>
            <ol class="list-decimal ml-4 space-y-1">
              <li>Acesse <a href="https://www.mercadolivre.com.br/afiliados/linkbuilder" target="_blank" class="underline font-semibold">mercadolivre.com.br/afiliados/linkbuilder</a></li>
              <li>Cole a URL de <strong>um produto</strong> no campo do gerador</li>
              <li>Clique em <strong>"Gerar"</strong> — será gerado um link <code class="bg-blue-100 px-1 rounded">meli.la/xxxxx</code></li>
              <li>Copie o link gerado e cole aqui abaixo</li>
            </ol>
            <div class="mt-2 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2 text-amber-800">
              ⚠️ <strong>Não copie</strong> o link do botão "Compartilhar" do seu perfil
              (<code class="bg-amber-100 px-1 rounded">/social/cfegdhabc31955</code>) — isso é a
              sua página, não um produto.
            </div>
          </div>

        </div>

        <div class="space-y-3">
          <div>
            <label class="block text-xs font-semibold text-slate-500 mb-1.5">
              URLs / IDs dos produtos <span class="font-normal text-slate-400">(uma por linha ou separados por vírgula)</span>
            </label>
            <textarea id="ml-url-input" rows="6"
              class="input font-mono text-xs resize-y"
              placeholder="https://www.mercadolivre.com.br/produto/p/MLB28965210
https://produto.mercadolivre.com.br/MLB-1234567890-titulo
MLB1234567890
..."></textarea>
          </div>

          <div class="flex items-center gap-3 flex-wrap">
            <div class="flex-1 min-w-[140px]">
              <label class="block text-xs font-semibold text-slate-500 mb-1.5">Categoria padrão</label>
              <select id="ml-url-category" class="input text-sm">
                <option value="outros">🔠 Detectar automaticamente</option>
                <option value="smartphones">📱 Smartphones</option>
                <option value="notebooks">💻 Notebooks</option>
                <option value="tv">📺 TVs & Smart TVs</option>
                <option value="games">🎮 Games & Consoles</option>
                <option value="audio">🎧 Áudio & Fones</option>
                <option value="cameras">📷 Câmeras & Drones</option>
                <option value="eletrodomesticos">🏠 Eletrodomésticos</option>
                <option value="tablets">📟 Tablets & iPads</option>
                <option value="informatica">🖥️ Informática</option>
                <option value="moda-calcados">👟 Moda & Calçados</option>
              </select>
            </div>
            <div class="flex items-end">
              <button onclick="importMLByUrl()" id="btn-ml-url"
                class="btn-primary flex items-center gap-2 px-6 py-2.5" ${!connected ? 'disabled' : ''}>
                <span>📥</span> Importar URLs
              </button>
            </div>
          </div>
        </div>

        <!-- Log resultado URL -->
        <div id="ml-url-log" class="hidden mt-4">
          <div class="bg-slate-900 text-green-400 rounded-xl p-4 font-mono text-xs min-h-[100px] whitespace-pre-wrap overflow-auto max-h-[300px]" id="ml-url-log-text">
            Aguardando...
          </div>
        </div>
      </div>

      <!-- ══════════════════════════════════════════
           IMPORTAR ITEM POR ID ÚNICO
      ══════════════════════════════════════════ -->
      <div class="stat-card ${!connected ? 'opacity-60 pointer-events-none' : ''}">
        <h3 class="font-bold text-slate-800 mb-1">🔍 Importar Item por ID único</h3>
        <p class="text-xs text-slate-500 mb-3">Cole um único ID ou URL para importar imediatamente e ver o resultado.</p>
        <div class="flex gap-3">
          <input id="ml-item-id" type="text"
            placeholder="MLB1234567890 ou https://www.mercadolivre.com.br/..."
            class="input flex-1 font-mono text-sm"
            onkeydown="if(event.key==='Enter') importMLItem()"/>
          <button onclick="importMLItem()" class="btn-primary whitespace-nowrap" ${!connected ? 'disabled' : ''}>
            📥 Importar
          </button>
        </div>
        <div id="ml-item-result" class="mt-3"></div>
      </div>

    </div>
  `
}

// ── Busca ML por keyword ──────────────────────────────────
// ── Importar por IDs em lote (substitui busca por keyword) ──
async function importMLByIds() {
  const textarea = document.getElementById('ml-kw-input')
  const cat      = document.getElementById('ml-kw-category')?.value || 'outros'
  const btn      = document.getElementById('btn-ml-kw')
  const log      = document.getElementById('ml-kw-log')
  const logTxt   = document.getElementById('ml-kw-log-text')
  const res_el   = document.getElementById('ml-kw-results')
  const list     = document.getElementById('ml-kw-list')
  const found    = document.getElementById('ml-kw-found')
  if (!textarea) return

  const raw = textarea.value.trim()
  if (!raw) { toast('Cole pelo menos um ID ou URL do ML.', 'error'); return }

  // Extrai IDs de URLs ou IDs diretos
  const lines = raw.split(new RegExp('[\\n,]+'))
    .map(s => s.trim()).filter(Boolean)

  function extractMLId(s) {
    // /p/MLB12345  →  catalog_product_id
    let m = s.match(new RegExp('[/]p[/](MLB[0-9]+)', 'i'))
    if (m) return m[1]
    // MLB-12345678-titulo ou MLB-1234567  (item_id com hifens)
    m = s.match(new RegExp('MLB[-_]([0-9]+)', 'i'))
    if (m) return 'MLB' + m[1]
    // MLB12345 direto
    m = s.match(new RegExp('(MLB[0-9]+)', 'i'))
    if (m) return m[1].toUpperCase()
    return null
  }

  const ids = lines.map(extractMLId).filter(Boolean)
  if (ids.length === 0) {
    toast('Nenhum ID do ML encontrado nas linhas coladas.', 'error')
    return
  }

  btn.disabled = true
  btn.innerHTML = '⏳ Importando...'
  log.classList.remove('hidden')
  res_el.classList.add('hidden')
  logTxt.textContent = 'Processando ' + ids.length + ' ID(s): ' + ids.join(', ') + String.fromCharCode(10) + 'Buscando precos e gerando links de afiliado...';

  const res = await api('POST', '/admin/api/affiliate-bot/import-ids', { ids, category: cat })

  btn.disabled = false
  btn.innerHTML = '<span>📥</span> Importar IDs'

  if (!res) { logTxt.textContent = '❌ Erro ao conectar com a API.'; return }

  const imp = res.summary?.imported || 0
  const skp = res.summary?.skipped  || 0
  const err = res.summary?.errors   || 0

  var logLines = [
    'IDs processados: ' + (res.summary && res.summary.found || ids.length),
    'Importados: ' + imp,
    skp > 0 ? 'Ja existiam / atualizados: ' + skp : '',
    err > 0 ? 'Erros: ' + err : '',
    '---',
  ].concat(
    (res.skipped || []).map(function(s){ return '- ' + ((s.title||s.ml_id||'')+'').slice(0,60) + ' -- ' + s.reason })
  ).concat(
    (res.errors  || []).map(function(e){ return 'ERR ' + (e.ml_id||'?') + ': ' + e.error })
  ).filter(Boolean)
  logTxt.textContent = logLines.join('\n')

  if (imp > 0) {
    found.textContent = imp + ' produto(s) importado(s) com sucesso'
    list.innerHTML = (res.imported || []).map(function(item) {
      var thumb = item.thumbnail
        ? '<img src="' + item.thumbnail + '" class="w-12 h-12 object-contain rounded-lg border border-slate-100 bg-white flex-shrink-0"/>'
        : '<div class="w-12 h-12 bg-slate-100 rounded-lg flex-shrink-0"></div>'
      var priceStr = (item.price||0).toLocaleString('pt-BR',{minimumFractionDigits:2})
      return '<div class="flex items-center gap-3 p-3 border border-green-200 rounded-xl bg-green-50/40">'
        + thumb
        + '<div class="flex-1 min-w-0">'
        + '<p class="text-sm font-semibold text-slate-800 truncate">' + (item.title||'') + '</p>'
        + '<div class="flex items-center gap-3 mt-0.5 flex-wrap">'
        + '<span class="text-sm font-bold text-green-600">R$ ' + priceStr + '</span>'
        + '<span class="text-xs text-slate-400 font-mono">' + (item.ml_id||'') + '</span>'
        + '<span class="text-xs px-1.5 py-0.5 bg-blue-50 text-blue-600 rounded-full">' + (item.category||'') + '</span>'
        + '<span class="text-xs px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded-full">' + (item.strategy||'-') + '</span>'
        + '</div>'
        + '<a href="' + (item.affiliate_url||'#') + '" target="_blank" class="text-xs text-blue-500 hover:underline truncate block mt-0.5">'
        + (item.affiliate_url||'').substring(0,90) + '...</a>'
        + '</div>'
        + '<span class="flex-shrink-0 text-xs font-bold text-green-600 bg-green-100 px-2 py-1 rounded-full">Salvo</span>'
        + '</div>'
    }).join('')
    res_el.classList.remove('hidden')
    toast('[OK] ' + imp + ' produto(s) importado(s) do ML!', 'success')
    setTimeout(() => loadSection('affiliate-bot'), 3000)
  } else if (skp > 0) {
    toast('[Skip] ' + skp + ' produto(s) ja existiam - preco atualizado.', 'info')
  } else {
    toast('⚠️ Nenhum produto importado — verifique os IDs ou o token ML.', 'warn')
  }
}

async function importMLByUrl() {
  const textarea = document.getElementById('ml-url-input')
  const category = document.getElementById('ml-url-category')?.value || 'outros'
  const btn      = document.getElementById('btn-ml-url')
  const log      = document.getElementById('ml-url-log')
  const logText  = document.getElementById('ml-url-log-text')
  if (!textarea || !btn || !log || !logText) return

  const raw = textarea.value.trim()
  if (!raw) {
    toast('Cole pelo menos uma URL ou ID antes de importar.', 'error')
    return
  }

  // Divide por quebra de linha ou vírgula, filtra vazios
  const urls = raw.split(new RegExp('[\\n,]+')).map(s => s.trim()).filter(Boolean)

  btn.disabled = true
  btn.innerHTML = '⏳ Importando...'
  log.classList.remove('hidden')
  logText.textContent = `[...] Processando ${urls.length} URL(s)...\\nExtraindo IDs e buscando na API do ML.`

  const res = await api('POST', '/admin/api/ml/import-url', { urls, category })

  btn.disabled = false
  btn.innerHTML = '<span>📥</span> Importar URLs'

  if (!res) {
    logText.textContent = '❌ Erro ao conectar com a API.'
    return
  }

  if (res.error) {
    // Erro específico: colou URL de perfil de afiliado
    if (res.hint === 'profile_url') {
      log.classList.add('hidden')
      document.getElementById('ml-profile-warn')?.classList.remove('hidden')
      btn.disabled = false
      btn.innerHTML = '<span>📥</span> Importar URLs'
      return
    }
    log.classList.remove('hidden')
    document.getElementById('ml-profile-warn')?.classList.add('hidden')
    logText.textContent = `[ERRO] Erro: ${res.error}${res.parse_errors?.length ? '\\n\\nDetalhes:\\n' + res.parse_errors.join('\\n') : ''}`
    return
  }

  // Sucesso — esconde aviso de perfil se estava visível
  document.getElementById('ml-profile-warn')?.classList.add('hidden')

  let output = `[OK] Importação concluída!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
→ Novos produtos criados : ${res.created}
→ Produtos atualizados   : ${res.updated}
→ Ignorados (duplicados) : ${res.skipped}
${res.not_found?.length ? '→ IDs não encontrados   : ' + res.not_found.length + '\\n   ' + res.not_found.join(', ') : ''}`

  if (res.parse_errors?.length) {
    output += `\\n\\n Erros de parse (URLs inválidas):\\n` + res.parse_errors.join('\\n')
  }

  if (res.items?.length) {
    output += `\\n\\n[Itens] Produtos importados:`
    for (const item of res.items) {
      const price = item.price ? `R$ ${item.price.toLocaleString('pt-BR',{minimumFractionDigits:2})}` : 'sem preço'
      const icon  = item.action === 'created' ? '✚' : item.action === 'updated' ? '↻' : '—'
      output += `\\n ${icon} [${item.ml_id}] ${item.name?.substring(0, 55) || '?'}... (${price}) → ${item.category}`
    }
  }

  logText.textContent = output

  if (res.created > 0 || res.updated > 0) {
    toast(`[OK] ${res.created} criados, ${res.updated} atualizados!`, 'success')
  } else {
    toast('Nenhum produto novo — verifique os IDs fornecidos.', 'info')
  }
}

async function runMLImport() {
  // Mantido para compatibilidade — redireciona para importação por URL
  toast('Use "Importar por URL" — cole as URLs do painel de afiliados do ML.', 'info')
}

async function importMLItem() {
  const raw    = document.getElementById('ml-item-id')?.value?.trim()
  const result = document.getElementById('ml-item-result')
  if (!raw || !result) return

  result.innerHTML = `<p class="text-sm text-slate-500 animate-pulse">[Busca] Buscando no ML...</p>`

  // Tenta extrair ID da URL se o usuário colou uma URL completa
  let mlId = raw
  if (raw.startsWith('http')) {
    // Extrai o ID via import-url (server-side)
    const urlRes = await api('POST', '/admin/api/ml/import-url', { urls: [raw], category: 'outros' })
    if (!urlRes || urlRes.error) {
      result.innerHTML = `<p class="text-sm text-red-500">[ERRO] ${urlRes?.error || 'Não foi possível extrair o ID da URL'}</p>`
      return
    }
    if (urlRes.items?.length) {
      const item = urlRes.items[0]
      const price = (item.price || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })
      result.innerHTML = `
        <div class="flex items-center gap-3 p-3 bg-green-50 border border-green-200 rounded-xl">
          <span class="text-2xl">✅</span>
          <div>
            <p class="font-semibold text-green-800">${item.action === 'created' ? 'Produto criado!' : 'Produto atualizado!'}</p>
            <p class="text-sm text-green-700">${item.name}</p>
            <p class="text-sm text-green-600 font-bold">R$ ${price}</p>
            <p class="text-xs text-slate-500">ID: ${item.ml_id} · Categoria: ${item.category}</p>
          </div>
        </div>`
      document.getElementById('ml-item-id').value = ''
    } else {
      result.innerHTML = `<p class="text-sm text-red-500">[ERRO] Nenhum produto encontrado para esta URL. Verifique se é um link válido do ML.</p>`
    }
    return
  }

  // ID direto (MLB...)
  const res = await api('POST', '/admin/api/ml/import-item', { ml_id: mlId })

  if (!res || res.error) {
    result.innerHTML = `<p class="text-sm text-red-500">[ERRO] ${res?.error || 'Erro ao importar'}</p>`
    return
  }

  const price = (res.price || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })
  result.innerHTML = `
    <div class="flex items-center gap-3 p-3 bg-green-50 border border-green-200 rounded-xl">
      <span class="text-2xl">✅</span>
      <div>
        <p class="font-semibold text-green-800">${res.action === 'created' ? 'Produto criado!' : 'Produto atualizado!'}</p>
        <p class="text-sm text-green-700">${res.name}</p>
        <p class="text-sm text-green-600 font-bold">R$ ${price}</p>
        <p class="text-xs text-slate-500">ID: ${res.ml_id} · Categoria: ${res.category}</p>
        <a href="${res.affiliate_url}" target="_blank" class="text-xs text-blue-500 hover:underline">🔗 Ver link afiliado</a>
      </div>
    </div>
  `
  document.getElementById('ml-item-id').value = ''
}
// ══════════════════════════════════════════════════════════════════════
// Helper: copia texto para clipboard
function copyText(text) {
  navigator.clipboard.writeText(text).then(() => showToast('Copiado! ✓', 'success'))
}

// ══════════════════════════════════════════════════════════
// ML LINKBUILDER — OAuth server-side + geração automática
// Login via /api/ml/auth (PKCE), token no KV, geração server-side
// ══════════════════════════════════════════════════════════

async function renderMLLinkBuilder(area) {
  // Mostra loading enquanto verifica conexão
  area.innerHTML = '<div class="section"><div class="stat-card text-center py-10 text-slate-400 text-sm">🔄 Verificando conexão com o Mercado Livre...</div></div>'

  const status = await api('GET', '/admin/api/ml-linkbuilder/status')
  const oauth  = status?.oauth    || {}
  const prods  = status?.products || {}

  const isConnected    = !!oauth.connected
  const isAuto         = !!oauth.auto_connected
  const tokenSrc       = oauth.token_source || 'none'
  const pending        = prods.pending || 0

  // Badge de conexão dinâmico
  let connectionBadge = ''
  let connectionDetail = ''
  if (!isConnected) {
    connectionBadge  = '<span class="inline-flex items-center gap-1.5 bg-red-100 text-red-700 text-xs font-bold px-3 py-1.5 rounded-full">❌ Desconectado</span>'
    connectionDetail = '<p class="text-xs text-red-500 mt-1 font-semibold">⚠ Sem token — configure ML_SECRET</p>'
  } else if (isAuto) {
    connectionBadge  = '<span class="inline-flex items-center gap-1.5 bg-green-100 text-green-700 text-xs font-bold px-3 py-1.5 rounded-full">🤖 Conectado automaticamente</span>'
    connectionDetail = '<p class="text-xs text-slate-400 mt-1">via <code class="font-mono">client_credentials</code> — sem OAuth necessário</p>'
  } else if (tokenSrc === 'oauth' || tokenSrc === 'oauth_kv') {
    connectionBadge  = '<span class="inline-flex items-center gap-1.5 bg-blue-100 text-blue-700 text-xs font-bold px-3 py-1.5 rounded-full">✅ Conectado via OAuth</span>'
    connectionDetail = '<p class="text-xs text-slate-400 mt-1">User ID: ' + (oauth.user_id || '—') + '</p>'
  } else {
    connectionBadge  = '<span class="inline-flex items-center gap-1.5 bg-green-100 text-green-700 text-xs font-bold px-3 py-1.5 rounded-full">✅ ML Conectado</span>'
    connectionDetail = '<p class="text-xs text-slate-400 mt-1">Token ativo</p>'
  }

  // Banner de status da conexão (abaixo do header)
  let connectionBanner = ''
  if (!isConnected) {
    connectionBanner = `
      <div class="mt-4 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-800">
        <p class="font-bold mb-1">❌ Sem conexão com o ML</p>
        <p class="text-xs">Verifique se <code class="font-mono bg-red-100 px-1 rounded">ML_SECRET</code> está configurado no Cloudflare. O login automático usa <code class="font-mono bg-red-100 px-1 rounded">client_credentials</code> — sem OAuth manual.</p>
        <a href="/api/ml/auth" target="_blank" class="inline-flex items-center gap-2 mt-2 bg-yellow-400 hover:bg-yellow-500 text-slate-900 font-bold px-4 py-2 rounded-lg text-xs transition-colors">
          🔑 Tentar Login OAuth manual
        </a>
      </div>`
  } else if (isAuto) {
    connectionBanner = `
      <div class="mt-3 bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-800 flex items-center justify-between flex-wrap gap-2">
        <span>🤖 <strong>Login automático ativo</strong> — token gerado via <code class="font-mono bg-green-100 px-1 rounded text-xs">client_credentials</code>. Nenhuma ação necessária.</span>
        <a href="/api/ml/auth" target="_blank" class="text-xs text-green-700 underline hover:text-green-900 whitespace-nowrap">Vincular conta OAuth →</a>
      </div>`
  } else {
    connectionBanner = `
      <div class="mt-3 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-800 flex items-center justify-between flex-wrap gap-2">
        <span>✅ Token OAuth ativo — pronto para gerar links.</span>
        <a href="/api/ml/auth" target="_blank" class="text-xs text-blue-700 underline hover:text-blue-900">Renovar / trocar conta →</a>
      </div>`
  }

  // Auto-start: se conectado e há pendentes, inicia automaticamente
  const shouldAutoStart = isConnected && pending > 0 && !LbState.running

  area.innerHTML = `
  <div class="section space-y-5">

    <!-- ── Card OAuth / Status ── -->
    <div class="stat-card">
      <div class="flex items-center gap-4 flex-wrap">
        <div class="w-14 h-14 bg-yellow-400 rounded-2xl flex items-center justify-center text-2xl shadow-md flex-shrink-0">🔗</div>
        <div class="flex-1 min-w-0">
          <h3 class="font-bold text-slate-800 text-lg">ML LinkBuilder</h3>
          <p class="text-sm text-slate-500">Gera links de afiliado rastreáveis (<code class="bg-slate-100 px-1.5 py-0.5 rounded font-mono text-xs">?matt_word=cfegdhabc31955</code>) para todos os produtos com <code class="bg-slate-100 px-1 rounded font-mono text-xs">ml_item_id</code>.</p>
        </div>
        <div class="text-right flex-shrink-0">
          ` + connectionBadge + `
          ` + connectionDetail + `
        </div>
      </div>
      ` + connectionBanner + `
    </div>

    <!-- ── Contadores ── -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <div class="stat-card py-3 text-center">
        <div class="text-2xl font-bold text-slate-800" id="lb-total">` + (prods.total || 0) + `</div>
        <div class="text-xs text-slate-500 mt-0.5">Produtos ativos</div>
      </div>
      <div class="stat-card py-3 text-center">
        <div class="text-2xl font-bold text-blue-700" id="lb-with-mlid">` + (prods.with_ml_id || 0) + `</div>
        <div class="text-xs text-slate-500 mt-0.5">Com ml_item_id</div>
      </div>
      <div class="stat-card py-3 text-center">
        <div class="text-2xl font-bold text-green-700" id="lb-done">` + (prods.with_tracking || 0) + `</div>
        <div class="text-xs text-slate-500 mt-0.5">Com link afiliado ✅</div>
      </div>
      <div class="stat-card py-3 text-center">
        <div class="text-2xl font-bold text-orange-600" id="lb-pending">` + pending + `</div>
        <div class="text-xs text-slate-500 mt-0.5">Pendentes ⏳</div>
      </div>
    </div>

    <!-- ── Bot em Lote ── -->
    <div class="stat-card` + (!isConnected ? ' opacity-60 pointer-events-none' : '') + `">
      <div class="flex items-center gap-3 mb-4">
        <span class="text-2xl">🤖</span>
        <div class="flex-1">
          <h3 class="font-bold text-slate-800">Gerar Links em Lote (Server-side)</h3>
          <p class="text-xs text-slate-500">O Worker busca o permalink de cada produto via API ML e salva o link de afiliado no banco automaticamente.</p>
        </div>
        ` + (shouldAutoStart ? '<span class="text-xs bg-yellow-100 text-yellow-800 font-bold px-2 py-1 rounded-lg animate-pulse">▶ Iniciando automaticamente...</span>' : '') + `
      </div>

      <div class="flex items-center gap-3 flex-wrap mb-4">
        <div>
          <label class="block text-xs font-semibold text-slate-500 mb-1">Produtos por lote</label>
          <select id="lb-batch-size" class="input w-24 text-sm">
            <option value="10">10</option>
            <option value="20" selected>20</option>
            <option value="30">30</option>
          </select>
        </div>
        <div class="flex-1"></div>
        <button onclick="mlLbRunBatch()" id="lb-run-btn"
                class="bg-yellow-400 hover:bg-yellow-500 text-slate-900 font-bold px-6 py-2.5 rounded-xl transition-all shadow text-sm flex items-center gap-2">
          ▶ Iniciar Bot
        </button>
        <button onclick="mlLbStop()" id="lb-stop-btn"
                class="hidden bg-red-50 hover:bg-red-100 text-red-600 font-bold px-5 py-2.5 rounded-xl transition-all text-sm">
          ⏹ Parar
        </button>
      </div>

      <!-- Barra de progresso -->
      <div id="lb-progress-wrap" class="hidden mb-4">
        <div class="flex items-center justify-between text-xs text-slate-500 mb-1.5">
          <span id="lb-progress-label">Aguardando...</span>
          <span id="lb-progress-pct">0%</span>
        </div>
        <div class="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden">
          <div id="lb-progress-bar" class="h-2.5 bg-yellow-400 rounded-full transition-all duration-500" style="width:0%"></div>
        </div>
        <div class="flex gap-4 mt-2 text-xs flex-wrap">
          <span class="text-green-600 font-semibold">✅ <span id="lb-count-ok">0</span> gerados</span>
          <span class="text-red-500">❌ <span id="lb-count-err">0</span> erros</span>
          <span class="text-slate-400">⏳ <span id="lb-count-rem">0</span> restantes</span>
        </div>
      </div>

      <!-- Log em tempo real -->
      <div id="lb-log" class="hidden bg-slate-900 rounded-xl p-3 font-mono text-xs text-green-400 max-h-48 overflow-y-auto space-y-0.5"></div>
    </div>

    <!-- ── Tabela de produtos ── -->
    <div class="stat-card">
      <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div class="flex items-center gap-3">
          <span class="text-xl">📋</span>
          <h3 class="font-bold text-slate-800 text-sm">Produtos</h3>
          <span id="lb-table-count" class="badge-blue"></span>
        </div>
        <div class="flex gap-2">
          <select id="lb-filter" onchange="mlLbLoadProducts(1)" class="input w-36 text-xs">
            <option value="missing">Sem link afiliado</option>
            <option value="done">Com link afiliado</option>
            <option value="all">Todos</option>
          </select>
          <button onclick="mlLbLoadProducts(1)" class="btn-secondary text-xs">↻</button>
        </div>
      </div>
      <div id="lb-table-wrap">
        <div class="text-center py-8 text-slate-400 text-sm">Carregando...</div>
      </div>
      <div id="lb-pagination" class="flex items-center justify-between mt-3 hidden pt-3 border-t border-slate-100">
        <button onclick="mlLbPrevPage()" id="lb-prev-btn" class="btn-secondary text-xs">← Anterior</button>
        <span id="lb-page-info" class="text-xs text-slate-500"></span>
        <button onclick="mlLbNextPage()" id="lb-next-btn" class="btn-secondary text-xs">Próxima →</button>
      </div>
    </div>

  </div>`

  // Carrega tabela de produtos
  mlLbLoadProducts(1)

  // Auto-start: se conectado e há pendentes, inicia o bot automaticamente
  if (shouldAutoStart) {
    setTimeout(() => {
      if (!LbState.running) mlLbRunBatch()
    }, 1200)
  }
}

// ─── Estado global ─────────────────────────────────────────
const LbState = { running: false, stop: false, page: 1 }

// ─── Carregar tabela de produtos ──────────────────────────
async function mlLbLoadProducts(page) {
  page = page || LbState.page
  LbState.page = page
  const filter = document.getElementById('lb-filter')?.value || 'missing'
  const wrap   = document.getElementById('lb-table-wrap')
  if (!wrap) return
  wrap.innerHTML = '<div class="text-center py-6 text-slate-400 text-sm">Carregando...</div>'

  const data = await api('GET', `/admin/api/ml-linkbuilder/products?filter=${filter}&page=${page}`)
  if (!data) { wrap.innerHTML = '<div class="text-center py-6 text-red-400 text-sm">Erro ao carregar.</div>'; return }

  const countEl = document.getElementById('lb-table-count')
  if (countEl) countEl.textContent = data.total + ' produtos'

  if (!data.results?.length) {
    wrap.innerHTML = `<div class="text-center py-10 text-slate-400 text-sm">
      ${filter === 'missing' ? '🎉 Todos os produtos já têm link afiliado!' : 'Nenhum produto encontrado.'}
    </div>`
    document.getElementById('lb-pagination')?.classList.add('hidden')
    return
  }

  wrap.innerHTML = `
    <div class="overflow-x-auto">
    <table class="w-full text-sm">
      <thead>
        <tr>
          <th class="table-th w-12">ID</th>
          <th class="table-th">Produto</th>
          <th class="table-th w-32">ml_item_id</th>
          <th class="table-th">Link Afiliado</th>
          <th class="table-th w-20">Ação</th>
        </tr>
      </thead>
      <tbody>
        ${data.results.map(p => {
          const affCell = p.affiliate_url
            ? '<a href="' + p.affiliate_url + '" target="_blank" class="text-green-600 hover:underline break-all">' + p.affiliate_url.substring(0, 70) + (p.affiliate_url.length > 70 ? '…' : '') + '</a>'
            : '<span class="text-slate-300">—</span>'
          return `
          <tr class='hover:bg-slate-50' id='lb-row-${p.id}'>
            <td class='table-td text-slate-400 font-mono text-xs'>${p.id}</td>
            <td class='table-td'>
              <div class='font-medium text-slate-800 text-xs leading-snug max-w-xs truncate'>${p.name}</div>
              <div class='text-xs text-slate-400'>${p.category || '—'}</div>
            </td>
            <td class='table-td'>
              <a href='${p.ml_url}' target='_blank' class='font-mono text-xs text-blue-600 hover:underline'>${p.ml_item_id}</a>
            </td>
            <td class='table-td font-mono text-xs' id='lb-aff-${p.id}'>
              ${affCell}
            </td>
            <td class='table-td'>
              <button onclick='mlLbGenSingle(` + p.id + `, "` + p.ml_item_id + `")' id='lb-btn-${p.id}'
                      class='btn-success text-xs'>Gerar</button>
            </td>
          </tr>`
        }).join('')}
      </tbody>
    </table>
    </div>`

  // Paginação
  const totalPages = Math.ceil(data.total / 30)
  const pag = document.getElementById('lb-pagination')
  if (data.total > 30) {
    pag?.classList.remove('hidden')
    const pi = document.getElementById('lb-page-info')
    if (pi) pi.textContent = `Pág. ${page}/${totalPages} · ${data.total} produtos`
    const prev = document.getElementById('lb-prev-btn')
    const next  = document.getElementById('lb-next-btn')
    if (prev) prev.disabled = page <= 1
    if (next) next.disabled = page >= totalPages
  } else {
    pag?.classList.add('hidden')
  }
}

function mlLbPrevPage() { if (LbState.page > 1) mlLbLoadProducts(LbState.page - 1) }
function mlLbNextPage() { mlLbLoadProducts(LbState.page + 1) }

// ─── Gerar link para produto único (via server-side) ──────
async function mlLbGenSingle(productId, mlItemId) {
  const btn   = document.getElementById(`lb-btn-${productId}`)
  const affEl = document.getElementById(`lb-aff-${productId}`)
  if (btn) { btn.disabled = true; btn.textContent = '⏳' }

  const res = await api('POST', '/admin/api/ml-linkbuilder/generate-all', {
    limit: 1,
    // Passa offset 0 mas o endpoint busca o próximo pendente — aqui vamos usar um workaround:
    // chamamos generate-all com limit=1 mas o endpoint filtra por missing, então pode
    // pegar o próximo, não necessariamente este. Para gerar produto específico
    // usamos o fallback: monta o link diretamente com o ml_item_id
  })

  // Alternativa direta: monta o link afiliado localmente sem precisar de API
  // permalink = https://produto.mercadolivre.com.br/MLB-XXXXXXXX
  const mlUrl    = `https://produto.mercadolivre.com.br/${mlItemId.replace('MLB', 'MLB-')}`
  const affUrl   = `${mlUrl}?matt_word=cfegdhabc31955&matt_tool=38524122&forceInApp=true`
  const saveRes  = await api('PUT', `/admin/api/ml-linkbuilder/products/${productId}`, { affiliate_url: affUrl })

  if (saveRes?.ok) {
    if (affEl) affEl.innerHTML = `<a href="${affUrl}" target="_blank" class="text-green-600 hover:underline font-mono text-xs break-all">${affUrl.substring(0, 70)}…</a>`
    if (btn) { btn.className = 'text-xs text-green-600 font-semibold'; btn.textContent = '✅' }
    mlLbRefreshCounters()
  } else {
    if (btn) { btn.disabled = false; btn.textContent = 'Gerar' }
    showToast('Erro ao salvar')
  }
}

// ─── Atualiza contadores no topo ──────────────────────────
async function mlLbRefreshCounters() {
  const s = await api('GET', '/admin/api/ml-linkbuilder/status')
  if (!s) return
  const p = s.products || {}
  ;[['lb-total', p.total], ['lb-with-mlid', p.with_ml_id],
    ['lb-done', p.with_tracking], ['lb-pending', p.pending]
  ].forEach(([id, val]) => {
    const el = document.getElementById(id)
    if (el) el.textContent = val ?? 0
  })
}

// ─── Bot em Lote (server-side: Worker faz as chamadas ML) ─
async function mlLbRunBatch() {
  if (LbState.running) return
  LbState.running = true; LbState.stop = false

  const runBtn   = document.getElementById('lb-run-btn')
  const stopBtn  = document.getElementById('lb-stop-btn')
  const progWrap = document.getElementById('lb-progress-wrap')
  const logEl    = document.getElementById('lb-log')

  runBtn?.classList.add('hidden')
  stopBtn?.classList.remove('hidden')
  progWrap?.classList.remove('hidden')
  logEl?.classList.remove('hidden')
  if (logEl) logEl.innerHTML = ''

  const batchSize = parseInt(document.getElementById('lb-batch-size')?.value || '20')

  function log(msg, color = 'text-green-400') {
    if (!logEl) return
    const line = document.createElement('div')
    line.className = color
    line.textContent = `[${new Date().toLocaleTimeString('pt-BR')}] ${msg}`
    logEl.appendChild(line)
    logEl.scrollTop = logEl.scrollHeight
  }

  function setProgress(done, total, ok, err, rem) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0
    const bar = document.getElementById('lb-progress-bar')
    if (bar) bar.style.width = pct + '%'
    const pEl = document.getElementById('lb-progress-pct'); if (pEl) pEl.textContent = pct + '%'
    const lEl = document.getElementById('lb-progress-label'); if (lEl) lEl.textContent = `Lote ${done}/${total}...`
    const oEl = document.getElementById('lb-count-ok'); if (oEl) oEl.textContent = ok
    const eEl = document.getElementById('lb-count-err'); if (eEl) eEl.textContent = err
    const rEl = document.getElementById('lb-count-rem'); if (rEl) rEl.textContent = rem
  }

  log('🚀 Iniciando geração server-side...', 'text-yellow-300')

  let offset = 0, totalOk = 0, totalErr = 0, totalDone = 0, remaining = 999

  // Primeira chamada para descobrir quantos pendentes existem
  const firstStatus = await api('GET', '/admin/api/ml-linkbuilder/status')
  const totalPending = firstStatus?.products?.pending || 0
  log(`📦 ${totalPending} produtos pendentes encontrados`, 'text-blue-300')

  if (totalPending === 0) {
    log('🎉 Nenhum produto pendente! Todos já têm link afiliado.', 'text-green-300')
    LbState.running = false
    runBtn?.classList.remove('hidden')
    stopBtn?.classList.add('hidden')
    return
  }

  while (!LbState.stop && remaining > 0) {
    const res = await api('POST', '/admin/api/ml-linkbuilder/generate-all', {
      limit: batchSize,
      offset,
    })

    if (!res) {
      log('❌ Erro na chamada ao servidor — abortando', 'text-red-400')
      break
    }

    totalDone += res.processed || 0
    totalOk   += res.saved    || 0
    totalErr  += res.errors   || 0
    remaining  = res.remaining ?? 0
    offset     = res.next_offset || (offset + batchSize)

    setProgress(totalDone, totalPending, totalOk, totalErr, remaining)

    // Exibe log do servidor
    if (res.log?.length) {
      res.log.forEach(line => log(line, line.startsWith('✅') ? 'text-green-300' : line.startsWith('❌') ? 'text-red-400' : 'text-slate-400'))
    } else {
      log(`  → Lote: ${res.saved} gerados · ${res.errors} erros · ${remaining} restantes`, 'text-slate-300')
    }

    if (res.done || remaining === 0) {
      log(`✅ Todos os produtos processados!`, 'text-yellow-300')
      break
    }

    // Pausa entre lotes para não sobrecarregar o Worker
    if (!LbState.stop) await new Promise(r => setTimeout(r, 500))
  }

  if (LbState.stop) log('⏹ Bot parado pelo usuário.', 'text-orange-400')

  log(`\n📊 Resultado: ${totalOk} gerados · ${totalErr} erros · ${remaining} ainda pendentes`, 'text-yellow-300')

  LbState.running = false
  runBtn?.classList.remove('hidden')
  stopBtn?.classList.add('hidden')

  await mlLbRefreshCounters()
  await mlLbLoadProducts(1)
}

function mlLbStop() { LbState.stop = true }


(function init() {
  // Verifica se já tem token salvo
  if (App.token) {
    // Tenta validar
    fetch('/admin/api/dashboard', { headers: { 'Authorization': 'Bearer ' + App.token } })
      .then(r => {
        if (r.ok) {
          document.getElementById('login-screen').classList.add('hidden')
          document.getElementById('admin-app').classList.remove('hidden')
          loadSection('dashboard')
        } else {
          localStorage.removeItem('admin_token')
          App.token = ''
        }
      }).catch(() => {})
  }

  // Enter no campo de senha
  document.getElementById('login-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin()
  })
})()
// ══════════════════════════════════════════════════════════
// 🗂️ ML CATEGORIES — Sincroniza categorias do ML com D1
// ══════════════════════════════════════════════════════════
async function renderMLCategories(area) {
  area.innerHTML = '<div class="section"><div class="stat-card text-center py-10 text-slate-400 text-sm">🔄 Carregando categorias...</div></div>'

  const status = await api('GET', '/admin/api/ml/sync-categories')

  area.innerHTML = `
    <div class="section space-y-6">

      <!-- Header -->
      <div class="stat-card">
        <div class="flex items-center gap-4 flex-wrap">
          <div class="w-14 h-14 bg-orange-400 rounded-2xl flex items-center justify-center text-2xl shadow-md flex-shrink-0">🗂️</div>
          <div class="flex-1 min-w-0">
            <h3 class="font-bold text-slate-800 text-lg">Categorias do Mercado Livre</h3>
            <p class="text-sm text-slate-500">Sincroniza a árvore real de departamentos via <code class="bg-slate-100 px-1 rounded font-mono text-xs">/sites/MLB/categories</code></p>
          </div>
          <div class="flex gap-2 flex-shrink-0">
            <button onclick="mlSyncCategories()" class="btn-primary flex items-center gap-2">
              🔄 Sincronizar Agora
            </button>
            <button onclick="renderMLCategories(document.getElementById('content-area'))" class="btn-secondary">↻ Atualizar</button>
          </div>
        </div>

        <!-- Stats -->
        <div class="grid grid-cols-3 gap-4 mt-5">
          <div class="bg-slate-50 rounded-xl p-3 text-center">
            <div class="text-2xl font-bold text-slate-800">${status?.total || 0}</div>
            <div class="text-xs text-slate-500 mt-0.5">Total no D1</div>
          </div>
          <div class="bg-orange-50 rounded-xl p-3 text-center">
            <div class="text-2xl font-bold text-orange-600">${status?.with_ml_id || 0}</div>
            <div class="text-xs text-slate-500 mt-0.5">Com ID ML</div>
          </div>
          <div class="bg-green-50 rounded-xl p-3 text-center">
            <div class="text-2xl font-bold text-green-600">${status?.with_products || 0}</div>
            <div class="text-xs text-slate-500 mt-0.5">Com Produtos</div>
          </div>
        </div>
      </div>

      <!-- Como funciona -->
      <div class="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-800">
        <p class="font-bold mb-1">📖 Como funciona:</p>
        <ol class="list-decimal ml-4 space-y-0.5 text-xs">
          <li>Clique em <strong>Sincronizar Agora</strong> — busca todas as categorias do ML Brasil</li>
          <li>As categorias são salvas/atualizadas na tabela <code class="font-mono bg-blue-100 px-1 rounded">categories</code> do D1</li>
          <li>Após sincronizar, use <strong>Busca ML API</strong> para importar produtos por categoria</li>
        </ol>
      </div>

      <!-- Resultado da sync -->
      <div id="cat-sync-result"></div>

      <!-- Tabela de categorias -->
      ${status?.categories?.length > 0 ? `
      <div class="stat-card">
        <h4 class="font-semibold text-slate-800 mb-3">Categorias no D1 (${status.total})</h4>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr>
                <th class="table-th">Nome</th>
                <th class="table-th">Slug</th>
                <th class="table-th">ID ML</th>
                <th class="table-th">Produtos</th>
                <th class="table-th">Status</th>
              </tr>
            </thead>
            <tbody>
              ${(status.categories || []).map(cat => `
                <tr class="hover:bg-slate-50">
                  <td class="table-td font-medium">${cat.icon || '🛍️'} ${cat.name}</td>
                  <td class="table-td font-mono text-xs text-slate-500">${cat.slug}</td>
                  <td class="table-td font-mono text-xs">${cat.ml_category_id || '<span class="text-slate-400">—</span>'}</td>
                  <td class="table-td text-center">${cat.product_count || 0}</td>
                  <td class="table-td">
                    ${cat.is_active
                      ? '<span class="badge-green">Ativa</span>'
                      : '<span class="badge-red">Inativa</span>'}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
      ` : `
      <div class="stat-card text-center py-8 text-slate-400">
        <div class="text-4xl mb-2">🗂️</div>
        <p class="text-sm font-medium">Nenhuma categoria no D1 ainda</p>
        <p class="text-xs mt-1">Clique em <strong>Sincronizar Agora</strong> para importar as categorias do ML</p>
      </div>
      `}

    </div>
  `
}

async function mlSyncCategories() {
  const btn = document.querySelector('[onclick="mlSyncCategories()"]')
  if (btn) { btn.disabled = true; btn.textContent = '🔄 Sincronizando...' }
  const res = document.getElementById('cat-sync-result')
  if (res) res.innerHTML = '<div class="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-700">🔄 Buscando categorias do ML...</div>'

  const result = await api('POST', '/admin/api/ml/sync-categories')
  if (btn) { btn.disabled = false; btn.textContent = '🔄 Sincronizar Agora' }

  if (res) {
    if (result?.ok) {
      res.innerHTML = `
        <div class="bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-800">
          <p class="font-bold mb-1">✅ ${result.message}</p>
          <p class="text-xs mt-1">Total: ${result.total} categorias do ML | Salvas no D1: ${result.upserted}</p>
          <div class="mt-2 flex flex-wrap gap-1">
            ${(result.categories || []).slice(0, 20).map(c =>
              `<span class="bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded-full">${c.name}</span>`
            ).join('')}
            ${result.categories?.length > 20 ? `<span class="text-xs text-green-600">+${result.categories.length - 20} mais</span>` : ''}
          </div>
        </div>
      `
      setTimeout(() => renderMLCategories(document.getElementById('content-area')), 1500)
    } else {
      res.innerHTML = `<div class="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">❌ Erro: ${result?.error || 'Falha desconhecida'}</div>`
    }
  }
}

// ══════════════════════════════════════════════════════════
// 🔍 ML SEARCH — Busca e importa produtos por categoria/termo
// ══════════════════════════════════════════════════════════
const MlSearchState = { loading: false, results: [], lastQuery: '', lastCategory: '' }

async function renderMLSearch(area) {
  // Carrega categorias disponíveis para o select
  const catStatus = await api('GET', '/admin/api/ml/sync-categories').catch(() => null)
  const categories = catStatus?.categories || []

  area.innerHTML = `
    <div class="section space-y-6">

      <!-- Header -->
      <div class="stat-card">
        <div class="flex items-center gap-4 flex-wrap">
          <div class="w-14 h-14 bg-yellow-400 rounded-2xl flex items-center justify-center text-2xl shadow-md flex-shrink-0">🔍</div>
          <div class="flex-1">
            <h3 class="font-bold text-slate-800 text-lg">Busca & Importação via API ML</h3>
            <p class="text-sm text-slate-500">Busca produtos reais no ML por categoria ou termo — com links afiliados automáticos e cache KV (6h)</p>
          </div>
        </div>
      </div>

      <!-- Filtros de busca -->
      <div class="stat-card">
        <h4 class="font-semibold text-slate-800 mb-3">🔎 Parâmetros de Busca</h4>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">

          <!-- Busca por termo -->
          <div>
            <label class="text-xs font-semibold text-slate-600 mb-1 block">Termo de busca</label>
            <input id="ml-search-q" type="text" placeholder="Ex: Samsung Galaxy S24, Nike Air Max..."
              class="input" onkeydown="if(event.key==='Enter') mlSearchRun()">
          </div>

          <!-- Categoria -->
          <div>
            <label class="text-xs font-semibold text-slate-600 mb-1 block">Categoria ML</label>
            <select id="ml-search-cat" class="input">
              <option value="">Todas as categorias</option>
              ${categories.filter(c => c.ml_category_id).map(c =>
                `<option value="${c.ml_category_id}">${c.icon || '🛍️'} ${c.name}</option>`
              ).join('')}
            </select>
          </div>

          <!-- Limit -->
          <div>
            <label class="text-xs font-semibold text-slate-600 mb-1 block">Itens por busca</label>
            <select id="ml-search-limit" class="input">
              <option value="20">20 itens</option>
              <option value="50" selected>50 itens</option>
            </select>
          </div>

          <!-- Sort -->
          <div>
            <label class="text-xs font-semibold text-slate-600 mb-1 block">Ordenação</label>
            <select id="ml-search-sort" class="input">
              <option value="relevance">Relevância</option>
              <option value="price_asc">Menor preço</option>
              <option value="price_desc">Maior preço</option>
              <option value="sales_high">Mais vendidos</option>
            </select>
          </div>
        </div>

        <div class="flex gap-3 mt-4">
          <button onclick="mlSearchRun()" class="btn-primary flex items-center gap-2">
            🔍 Buscar no ML
          </button>
          <button onclick="mlSearchDeals()" class="btn-secondary flex items-center gap-2">
            🔥 Ofertas do Dia
          </button>
          <button onclick="mlSearchImportAll()" id="ml-import-all-btn"
            class="hidden bg-green-600 hover:bg-green-700 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-all flex items-center gap-2">
            💾 Importar Todos para D1
          </button>
        </div>
      </div>

      <!-- Resultado -->
      <div id="ml-search-result"></div>
      <div id="ml-search-grid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"></div>

    </div>
  `
}

async function mlSearchRun(offset = 0) {
  const q      = document.getElementById('ml-search-q')?.value?.trim() || ''
  const catId  = document.getElementById('ml-search-cat')?.value || ''
  const limit  = document.getElementById('ml-search-limit')?.value || '50'
  const sort   = document.getElementById('ml-search-sort')?.value  || 'relevance'

  if (!q && !catId) {
    toast('Informe um termo de busca ou selecione uma categoria', 'error')
    return
  }

  const res    = document.getElementById('ml-search-result')
  const grid   = document.getElementById('ml-search-grid')
  const impBtn = document.getElementById('ml-import-all-btn')

  if (res)  res.innerHTML  = '<div class="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-700">🔄 Buscando na API do Mercado Livre...</div>'
  if (grid) grid.innerHTML = ''
  if (impBtn) impBtn.classList.add('hidden')

  MlSearchState.loading    = true
  MlSearchState.lastQuery  = q
  MlSearchState.lastCategory = catId

  const params = new URLSearchParams({ limit, sort, offset: String(offset) })
  if (q)     params.set('q', q)
  if (catId) params.set('category', catId)

  const data = await api('GET', `/api/ml/browse?${params}`)
  MlSearchState.loading  = false

  if (!data || data.error) {
    if (res) res.innerHTML = `<div class="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">❌ ${data?.error || 'Erro ao buscar'}</div>`
    return
  }

  MlSearchState.results = data.results || []
  const results = data.results || []
  const total   = data.total   || 0

  if (res) res.innerHTML = `
    <div class="flex items-center justify-between bg-green-50 border border-green-200 rounded-xl px-4 py-3">
      <div class="text-sm text-green-800">
        ✅ <strong>${results.length}</strong> itens encontrados de <strong>${total.toLocaleString()}</strong> total
        ${data.query ? ` para <em>"${data.query}"</em>` : ''}
        — Links afiliados <span class="badge-green ml-1">auto-injetados</span>
      </div>
      <div class="flex gap-2">
        ${total > results.length && offset + results.length < total ? `
          <button onclick="mlSearchRun(${offset + results.length})"
            class="btn-secondary text-xs">Próximos ${limit} →</button>
        ` : ''}
      </div>
    </div>
  `

  if (impBtn) impBtn.classList.toggle('hidden', results.length === 0)

  if (grid) {
    grid.innerHTML = results.map((item, i) => `
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden hover:shadow-md transition-shadow">
        <div class="relative">
          <img src="${item.thumbnail || ''}" alt="${item.title?.slice(0,40)}"
            class="w-full h-40 object-contain bg-slate-50 p-2"
            onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>📦</text></svg>'">
          ${item.discount_pct > 0 ? `
            <span class="absolute top-2 right-2 bg-red-500 text-white text-xs font-bold px-2 py-0.5 rounded-full">
              -${item.discount_pct}%
            </span>
          ` : ''}
          ${item.free_shipping ? `
            <span class="absolute top-2 left-2 bg-green-500 text-white text-xs font-bold px-2 py-0.5 rounded-full">
              Frete Grátis
            </span>
          ` : ''}
        </div>
        <div class="p-3">
          <p class="text-xs font-semibold text-slate-700 line-clamp-2 mb-2 leading-tight">${item.title}</p>
          <div class="flex items-end justify-between mb-3">
            <div>
              <p class="text-lg font-bold text-slate-900">R$ ${(item.price||0).toLocaleString('pt-BR',{minimumFractionDigits:2})}</p>
              ${item.original_price ? `
                <p class="text-xs text-slate-400 line-through">R$ ${item.original_price.toLocaleString('pt-BR',{minimumFractionDigits:2})}</p>
              ` : ''}
            </div>
            <div class="text-xs text-slate-400">${item.sold_quantity > 0 ? `${item.sold_quantity.toLocaleString()} vendidos` : ''}</div>
          </div>
          <div class="flex gap-1.5">
            <button onclick="mlSaveItem(${i})"
              class="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold py-1.5 rounded-lg transition-colors">
              💾 Salvar
            </button>
            <a href="${item.affiliate_url || item.permalink}" target="_blank"
              class="flex-1 bg-yellow-400 hover:bg-yellow-500 text-slate-900 text-xs font-semibold py-1.5 rounded-lg text-center transition-colors">
              🛒 Ver
            </a>
          </div>
        </div>
      </div>
    `).join('')
  }
}

async function mlSearchDeals() {
  const catId = document.getElementById('ml-search-cat')?.value || ''
  const limit = document.getElementById('ml-search-limit')?.value || '20'

  const res  = document.getElementById('ml-search-result')
  const grid = document.getElementById('ml-search-grid')
  const impBtn = document.getElementById('ml-import-all-btn')

  if (res)  res.innerHTML  = '<div class="bg-orange-50 border border-orange-200 rounded-xl px-4 py-3 text-sm text-orange-700">🔥 Buscando Ofertas do Dia com maior desconto...</div>'
  if (grid) grid.innerHTML = ''
  if (impBtn) impBtn.classList.add('hidden')

  const params = new URLSearchParams({ limit })
  if (catId) params.set('category', catId)

  const data = await api('GET', `/api/ml/deals?${params}`)

  if (!data || data.error) {
    if (res) res.innerHTML = `<div class="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">❌ ${data?.error || 'Erro ao buscar'}</div>`
    return
  }

  MlSearchState.results = data.results || []
  const results = data.results || []

  if (res) res.innerHTML = `
    <div class="bg-orange-50 border border-orange-200 rounded-xl px-4 py-3 text-sm text-orange-800">
      🔥 <strong>${results.length}</strong> ofertas com desconto encontradas
      — Ordenadas por maior desconto
      ${data.note ? `<p class="text-xs mt-1 text-orange-600">${data.note}</p>` : ''}
    </div>
  `

  if (impBtn) impBtn.classList.toggle('hidden', results.length === 0)

  if (grid) {
    grid.innerHTML = results.map((item, i) => `
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden hover:shadow-md transition-shadow">
        <div class="relative">
          <img src="${item.thumbnail || ''}" alt="${item.title?.slice(0,40)}"
            class="w-full h-40 object-contain bg-slate-50 p-2"
            onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>📦</text></svg>'">
          <span class="absolute top-2 right-2 bg-red-500 text-white text-xs font-bold px-2 py-0.5 rounded-full">
            -${item.discount_pct}%
          </span>
          ${item.free_shipping ? `
            <span class="absolute top-2 left-2 bg-green-500 text-white text-xs font-bold px-2 py-0.5 rounded-full">Frete Grátis</span>
          ` : ''}
        </div>
        <div class="p-3">
          <p class="text-xs font-semibold text-slate-700 line-clamp-2 mb-2 leading-tight">${item.title}</p>
          <div class="flex items-end justify-between mb-3">
            <div>
              <p class="text-lg font-bold text-green-700">R$ ${(item.price||0).toLocaleString('pt-BR',{minimumFractionDigits:2})}</p>
              <p class="text-xs text-slate-400 line-through">R$ ${(item.original_price||0).toLocaleString('pt-BR',{minimumFractionDigits:2})}</p>
            </div>
            <div class="text-xs text-slate-400">${item.sold_quantity > 0 ? `${item.sold_quantity.toLocaleString()} vendidos` : ''}</div>
          </div>
          <div class="flex gap-1.5">
            <button onclick="mlSaveItem(${i})"
              class="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold py-1.5 rounded-lg transition-colors">
              💾 Salvar
            </button>
            <a href="${item.affiliate_url || item.permalink}" target="_blank"
              class="flex-1 bg-yellow-400 hover:bg-yellow-500 text-slate-900 text-xs font-semibold py-1.5 rounded-lg text-center transition-colors">
              🛒 Ver
            </a>
          </div>
        </div>
      </div>
    `).join('')
  }
}

async function mlSaveItem(index) {
  const item = MlSearchState.results[index]
  if (!item) return

  const catId  = document.getElementById('ml-search-cat')?.value || ''
  const result = await api('POST', '/admin/api/ml/import-by-category', {
    category_id: catId || 'MLB1051',
    slug: 'importado-ml',
    limit: 1,
    offset: 0,
    save: true,
    // Passa apenas o item em si via import-url
  })

  // Usa import-url para item único
  const res = await api('POST', '/admin/api/ml/import-url', {
    urls:     [item.permalink || `https://www.mercadolivre.com.br/p/${item.id}`],
    names:    [item.title],
    category: 'outros',
  })

  if (res?.ok) {
    toast(`✅ "${item.title?.slice(0,40)}" salvo! (${res.message})`, 'success')
    // Desabilita botão do card
    const cards = document.querySelectorAll('#ml-search-grid > div')
    const btn = cards[index]?.querySelector('button')
    if (btn) { btn.disabled = true; btn.textContent = '✅ Salvo'; btn.className = btn.className.replace('bg-blue-600', 'bg-slate-300') }
  } else {
    toast(`❌ Erro: ${res?.message || res?.error || 'falha ao salvar'}`, 'error')
  }
}

async function mlSearchImportAll() {
  const results = MlSearchState.results
  if (!results.length) return

  const catId   = document.getElementById('ml-search-cat')?.value || ''
  const catSlug = catId ? (document.getElementById('ml-search-cat')?.selectedOptions[0]?.text?.replace(/^[^a-z]+ /i, '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-') || 'outros') : 'outros'

  const impBtn = document.getElementById('ml-import-all-btn')
  if (impBtn) { impBtn.disabled = true; impBtn.textContent = '🔄 Importando...' }

  const urls  = results.map(r => r.permalink || `https://www.mercadolivre.com.br/p/${r.id}`)
  const names = results.map(r => r.title || '')

  const res = await api('POST', '/admin/api/ml/import-url', { urls, names, category: catSlug })

  if (impBtn) { impBtn.disabled = false; impBtn.textContent = '💾 Importar Todos para D1' }

  if (res?.ok) {
    toast(`✅ ${res.message}`, 'success')
    const resEl = document.getElementById('ml-search-result')
    if (resEl) {
      const old = resEl.innerHTML
      resEl.innerHTML = `
        <div class="bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-800 mb-2">
          ✅ <strong>${res.message}</strong>
          ${res.parse_errors?.length > 0 ? `<p class="text-xs mt-1 text-green-600">⚠ ${res.parse_errors.length} avisos</p>` : ''}
        </div>
      ` + old
    }
  } else {
    toast(`❌ Erro: ${res?.error || 'falha'}`, 'error')
  }
}

// ════════════════════════════════════════════════════════════
// SEÇÃO: Crawl em Massa (paginação automática por categoria)
// ════════════════════════════════════════════════════════════

const CrawlState = {
  running: false,
  log: [],
  lastResult: null,
}

function renderMLCrawl(area) {
  area.innerHTML = `
    <div class="space-y-6">

      <!-- Configurações do Crawl -->
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-6">
        <h3 class="font-bold text-slate-800 mb-4 flex items-center gap-2">
          <span class="text-xl">⚙️</span> Configurações do Crawl
        </h3>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">

          <!-- Categoria ML -->
          <div>
            <label class="block text-xs font-semibold text-slate-500 mb-1.5">Categoria ML (ID)</label>
            <select id="crawl-cat-id" class="input">
              <option value="">⏳ Carregando categorias...</option>
            </select>
          </div>

          <!-- Slug -->
          <div>
            <label class="block text-xs font-semibold text-slate-500 mb-1.5">Slug (para D1)</label>
            <input id="crawl-slug" type="text" class="input" placeholder="ex: smartphones" value="">
          </div>

          <!-- Máximo de itens -->
          <div>
            <label class="block text-xs font-semibold text-slate-500 mb-1.5">Máximo de Itens (1–1000)</label>
            <input id="crawl-max" type="number" min="1" max="1000" value="200" class="input">
          </div>

          <!-- Ordenação -->
          <div>
            <label class="block text-xs font-semibold text-slate-500 mb-1.5">Ordenação</label>
            <select id="crawl-sort" class="input">
              <option value="relevance">⭐ Relevância (padrão)</option>
              <option value="sales_high">🔥 Mais Vendidos</option>
              <option value="price_asc">💲 Menor Preço</option>
              <option value="price_desc">💎 Maior Preço</option>
            </select>
          </div>

          <!-- Modo -->
          <div>
            <label class="block text-xs font-semibold text-slate-500 mb-1.5">Modo</label>
            <select id="crawl-mode" class="input">
              <option value="save">💾 Salvar no D1</option>
              <option value="dry_run">👁️ Dry Run (só contar)</option>
            </select>
          </div>

        </div>

        <!-- Info rápida sobre paginação -->
        <div class="mt-4 bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 text-xs text-blue-700">
          <strong>Como funciona:</strong> O crawler faz chamadas de 50 itens em loop (offset=0, 50, 100…) até atingir o máximo configurado ou o total disponível na categoria. 
          A ML API limita a <strong>1.000 itens por busca</strong>. Itens já existentes são atualizados; novos são criados com offer placeholder.
        </div>
      </div>

      <!-- Botões de ação -->
      <div class="flex flex-wrap gap-3">
        <button id="crawl-run-btn" onclick="mlCrawlRun()"
          class="btn-primary flex items-center gap-2">
          <span>🕷️</span> Iniciar Crawl
        </button>
        <button onclick="mlCrawlPreview()"
          class="btn-secondary flex items-center gap-2">
          <span>👁️</span> Preview (dry run)
        </button>
        <button onclick="mlCrawlClear()"
          class="text-xs text-slate-400 hover:text-slate-600 px-3 py-2 rounded-lg transition-colors">
          🗑️ Limpar log
        </button>
      </div>

      <!-- Barra de progresso -->
      <div id="crawl-progress-wrap" class="hidden">
        <div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-5">
          <div class="flex items-center justify-between mb-3">
            <span class="text-sm font-semibold text-slate-700">Processando...</span>
            <span id="crawl-progress-pct" class="text-sm font-bold text-blue-600">0%</span>
          </div>
          <div class="w-full bg-slate-100 rounded-full h-2.5">
            <div id="crawl-progress-bar" class="bg-blue-500 h-2.5 rounded-full transition-all duration-500" style="width:0%"></div>
          </div>
          <p id="crawl-progress-msg" class="text-xs text-slate-500 mt-2">Aguardando...</p>
        </div>
      </div>

      <!-- Resultado -->
      <div id="crawl-result" class="hidden">
        <div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-4">
          <h3 class="font-bold text-slate-800 flex items-center gap-2">
            <span>📊</span> Resultado do Crawl
          </h3>
          <div id="crawl-result-content"></div>
        </div>
      </div>

      <!-- Log de execução -->
      <div id="crawl-log-wrap" class="hidden">
        <div class="bg-slate-900 rounded-2xl p-4">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-semibold text-slate-400 uppercase tracking-wide">Log de execução</span>
            <button onclick="mlCrawlClear()" class="text-xs text-slate-500 hover:text-slate-300">limpar</button>
          </div>
          <div id="crawl-log" class="font-mono text-xs text-green-400 space-y-0.5 max-h-64 overflow-y-auto"></div>
        </div>
      </div>

      <!-- Histórico de categorias crawleadas -->
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-6">
        <h3 class="font-bold text-slate-800 mb-4 flex items-center gap-2">
          <span class="text-xl">📋</span> Categorias Disponíveis
          <button onclick="mlCrawlLoadCats()" class="btn-secondary ml-auto text-xs">↻ Recarregar</button>
        </h3>
        <div id="crawl-cats-table">
          <p class="text-sm text-slate-400">Carregando...</p>
        </div>
      </div>

    </div>
  `

  // Carrega categorias no select e na tabela
  mlCrawlLoadCats()
}

async function mlCrawlLoadCats() {
  try {
    const data = await api('GET', '/admin/api/ml/sync-categories')
    const cats = data?.categories || []

    // Popula select
    const sel = document.getElementById('crawl-cat-id')
    if (sel) {
      if (!cats.length) {
        sel.innerHTML = '<option value="">— Nenhuma categoria no D1 — rode Sync primeiro —</option>'
      } else {
        sel.innerHTML = '<option value="">— Selecione uma categoria —</option>' +
          cats.filter(c => c.ml_category_id).map(c =>
            `<option value="${c.ml_category_id}" data-slug="${c.slug}">${c.icon || '🛍️'} ${c.name} (${c.ml_category_id})</option>`
          ).join('')
      }

      // Auto-preenche slug ao mudar categoria
      sel.onchange = () => {
        const opt = sel.selectedOptions[0]
        const slugEl = document.getElementById('crawl-slug')
        if (slugEl && opt?.dataset?.slug) slugEl.value = opt.dataset.slug
      }
    }

    // Tabela de categorias
    const tableEl = document.getElementById('crawl-cats-table')
    if (tableEl) {
      if (!cats.length) {
        tableEl.innerHTML = `
          <div class="text-center py-8 text-slate-400">
            <p class="text-2xl mb-2">🗂️</p>
            <p class="text-sm">Nenhuma categoria no D1.</p>
            <button onclick="showSection('ml-categories')" class="mt-2 btn-primary text-xs">
              Ir para Sync de Categorias →
            </button>
          </div>`
        return
      }

      tableEl.innerHTML = `
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr>
                <th class="table-th rounded-tl-lg">Ícone</th>
                <th class="table-th">Nome</th>
                <th class="table-th">ID ML</th>
                <th class="table-th">Slug</th>
                <th class="table-th text-right">Produtos</th>
                <th class="table-th rounded-tr-lg text-right">Ação</th>
              </tr>
            </thead>
            <tbody>
              ${cats.map(c => `
                <tr class="hover:bg-slate-50 transition-colors">
                  <td class="table-td text-xl">${c.icon || '🛍️'}</td>
                  <td class="table-td font-medium text-slate-800">${c.name}</td>
                  <td class="table-td font-mono text-xs text-slate-500">${c.ml_category_id || '—'}</td>
                  <td class="table-td font-mono text-xs text-slate-500">${c.slug}</td>
                  <td class="table-td text-right">
                    <span class="badge-blue">${c.product_count || 0}</span>
                  </td>
                  <td class="table-td text-right">
                    ${c.ml_category_id ? `
                      <button onclick="mlCrawlQuick('${c.ml_category_id}','${c.slug}')"
                        class="text-xs bg-blue-50 hover:bg-blue-100 text-blue-700 font-semibold px-3 py-1 rounded-lg transition-colors">
                        🕷️ Crawl
                      </button>` : '<span class="text-slate-300 text-xs">sem ID</span>'}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <p class="text-xs text-slate-400 mt-3">${data.total} categorias — ${data.with_ml_id} com ID ML — ${data.with_products} com produtos</p>
      `
    }
  } catch (e) {
    const tableEl = document.getElementById('crawl-cats-table')
    if (tableEl) tableEl.innerHTML = `<p class="text-sm text-red-500">Erro ao carregar: ${e.message}</p>`
  }
}

function mlCrawlQuick(catId, slug) {
  const sel = document.getElementById('crawl-cat-id')
  const slugEl = document.getElementById('crawl-slug')
  if (sel) sel.value = catId
  if (slugEl) slugEl.value = slug
  // Scroll para o topo da seção
  document.querySelector('#content-area')?.scrollTo({ top: 0, behavior: 'smooth' })
  toast(`✅ Categoria ${catId} selecionada — ajuste os parâmetros e clique em Iniciar Crawl`, 'info')
}

async function mlCrawlPreview() {
  const catId = document.getElementById('crawl-cat-id')?.value
  const slug  = document.getElementById('crawl-slug')?.value || 'outros'
  if (!catId) { toast('Selecione uma categoria ML', 'error'); return }

  _mlCrawlAddLog(`👁️ Dry run iniciado para ${catId}...`)
  mlCrawlShowProgress(true, 0, 'Contando itens disponíveis...')

  const res = await api('POST', '/admin/api/ml/crawl-category', {
    category_id: catId,
    slug,
    max_items: 50,
    sort: document.getElementById('crawl-sort')?.value || 'relevance',
    dry_run: true,
  })

  mlCrawlShowProgress(false)

  if (res?.ok) {
    _mlCrawlAddLog(`✅ Preview: ${res.total_available} itens disponíveis na categoria (${res.fetched} na 1ª página)`)
    toast(`👁️ ${res.message}`, 'success')
    _mlCrawlShowResult(res)
  } else {
    _mlCrawlAddLog(`❌ Erro: ${res?.error || 'falha'}`)
    toast(`❌ ${res?.error || 'Erro no dry run'}`, 'error')
  }
}

async function mlCrawlRun() {
  const catId   = document.getElementById('crawl-cat-id')?.value
  const slug    = (document.getElementById('crawl-slug')?.value || 'outros').trim()
  const maxItems = parseInt(document.getElementById('crawl-max')?.value || '200')
  const sort    = document.getElementById('crawl-sort')?.value || 'relevance'
  const mode    = document.getElementById('crawl-mode')?.value || 'save'
  const dryRun  = mode === 'dry_run'

  if (!catId) { toast('Selecione uma categoria ML', 'error'); return }
  if (!slug)  { toast('Informe o slug da categoria', 'error'); return }
  if (CrawlState.running) { toast('Crawl já em andamento...', 'error'); return }

  CrawlState.running = true
  CrawlState.log = []

  const btn = document.getElementById('crawl-run-btn')
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="animate-spin">🔄</span> Crawleando...' }

  const expectedPages = Math.ceil(maxItems / 50)
  _mlCrawlAddLog(`🕷️ Iniciando crawl: ${catId} → slug="${slug}" | max=${maxItems} | sort=${sort} | ${dryRun ? 'DRY RUN' : 'SALVANDO'}`)
  _mlCrawlAddLog(`📄 Estimativa: ~${expectedPages} página(s) × 50 itens`)
  mlCrawlShowProgress(true, 5, `Iniciando crawl de ${catId}...`)

  // Simula progresso enquanto aguarda (o endpoint é síncrono)
  let fakeProgress = 5
  const progressInterval = setInterval(() => {
    fakeProgress = Math.min(90, fakeProgress + (90 / expectedPages / 3))
    const pct = Math.round(fakeProgress)
    mlCrawlShowProgress(true, pct, `Processando páginas... (~${pct}%)`)
  }, 800)

  try {
    const startTs = Date.now()

    const res = await api('POST', '/admin/api/ml/crawl-category', {
      category_id: catId,
      slug,
      max_items:   maxItems,
      sort,
      dry_run:     dryRun,
    })

    clearInterval(progressInterval)
    mlCrawlShowProgress(true, 100, 'Concluído!')
    setTimeout(() => mlCrawlShowProgress(false), 1200)

    const elapsed = ((Date.now() - startTs) / 1000).toFixed(1)

    if (res?.ok || res?.fetched > 0) {
      _mlCrawlAddLog(`✅ Concluído em ${elapsed}s`)
      _mlCrawlAddLog(`   📦 Total disponível na categoria: ${res.total_available}`)
      _mlCrawlAddLog(`   📄 Páginas processadas: ${res.pages}`)
      _mlCrawlAddLog(`   📥 Itens buscados: ${res.fetched}`)
      if (!dryRun) {
        _mlCrawlAddLog(`   🆕 Criados: ${res.created}`)
        _mlCrawlAddLog(`   🔄 Atualizados: ${res.updated}`)
        _mlCrawlAddLog(`   ⏭️ Ignorados: ${res.skipped}`)
      }
      if (res.errors?.length) {
        res.errors.forEach(e => _mlCrawlAddLog(`   ⚠️ ${e}`))
      }
      toast(`✅ ${res.message}`, 'success')
      _mlCrawlShowResult(res)
    } else {
      _mlCrawlAddLog(`❌ Erro: ${res?.error || 'resposta inválida'}`)
      if (res?.errors?.length) res.errors.forEach(e => _mlCrawlAddLog(`   ⚠️ ${e}`))
      toast(`❌ ${res?.error || 'Erro no crawl'}`, 'error')
    }

    // Atualiza tabela de categorias
    mlCrawlLoadCats()

  } catch (e) {
    clearInterval(progressInterval)
    mlCrawlShowProgress(false)
    _mlCrawlAddLog(`❌ Exceção: ${e.message}`)
    toast(`❌ Erro: ${e.message}`, 'error')
  } finally {
    CrawlState.running = false
    if (btn) { btn.disabled = false; btn.innerHTML = '<span>🕷️</span> Iniciar Crawl' }
  }
}

function _mlCrawlAddLog(msg) {
  CrawlState.log.push(msg)
  const logEl = document.getElementById('crawl-log')
  const wrap  = document.getElementById('crawl-log-wrap')
  if (wrap) wrap.classList.remove('hidden')
  if (logEl) {
    const ts = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    logEl.innerHTML += `<div><span class="text-slate-500">[${ts}]</span> ${msg}</div>`
    logEl.scrollTop = logEl.scrollHeight
  }
}

function mlCrawlShowProgress(show, pct = 0, msg = '') {
  const wrap = document.getElementById('crawl-progress-wrap')
  const bar  = document.getElementById('crawl-progress-bar')
  const pctEl = document.getElementById('crawl-progress-pct')
  const msgEl = document.getElementById('crawl-progress-msg')
  if (!wrap) return
  if (!show) { wrap.classList.add('hidden'); return }
  wrap.classList.remove('hidden')
  if (bar)   bar.style.width   = `${pct}%`
  if (pctEl) pctEl.textContent = `${pct}%`
  if (msgEl) msgEl.textContent = msg
}

function _mlCrawlShowResult(res) {
  const el = document.getElementById('crawl-result')
  const content = document.getElementById('crawl-result-content')
  if (!el || !content) return
  el.classList.remove('hidden')

  const isOk = res.ok || res.fetched > 0
  const bgColor = isOk ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'
  const textColor = isOk ? 'text-green-800' : 'text-red-800'

  content.innerHTML = `
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
      <div class="bg-slate-50 rounded-xl p-4 text-center">
        <div class="text-2xl font-black text-slate-800">${res.total_available?.toLocaleString('pt-BR') || '—'}</div>
        <div class="text-xs text-slate-500 mt-1">Disponíveis na categoria</div>
      </div>
      <div class="bg-blue-50 rounded-xl p-4 text-center">
        <div class="text-2xl font-black text-blue-700">${res.fetched?.toLocaleString('pt-BR') || 0}</div>
        <div class="text-xs text-slate-500 mt-1">Itens buscados</div>
      </div>
      <div class="bg-green-50 rounded-xl p-4 text-center">
        <div class="text-2xl font-black text-green-700">${res.created?.toLocaleString('pt-BR') || 0}</div>
        <div class="text-xs text-slate-500 mt-1">Criados no D1</div>
      </div>
      <div class="bg-yellow-50 rounded-xl p-4 text-center">
        <div class="text-2xl font-black text-yellow-700">${res.updated?.toLocaleString('pt-BR') || 0}</div>
        <div class="text-xs text-slate-500 mt-1">Atualizados</div>
      </div>
    </div>

    <div class="${bgColor} border rounded-xl px-4 py-3 text-sm ${textColor} font-medium">
      ${isOk ? '✅' : '❌'} ${res.message || 'Sem mensagem'}
      ${res.duration_ms ? `<span class="ml-2 text-xs opacity-60">(${(res.duration_ms/1000).toFixed(1)}s — ${res.pages} página(s))</span>` : ''}
    </div>

    ${res.dry_run ? `
      <div class="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-800 mt-3">
        ⚠️ <strong>Dry Run ativo</strong> — nenhum item foi salvo no banco. 
        Altere o modo para "Salvar no D1" e rode novamente para importar.
      </div>` : ''}

    ${res.errors?.length ? `
      <div class="bg-red-50 border border-red-100 rounded-xl px-4 py-3 text-xs text-red-700 mt-3 space-y-1">
        <strong>⚠️ Avisos (${res.errors.length}):</strong>
        ${res.errors.map(e => `<div>• ${e}</div>`).join('')}
      </div>` : ''}

    ${res.errors?.some(e => e.includes('403')) ? `
      <div class="bg-orange-50 border border-orange-200 rounded-xl px-4 py-3 text-sm text-orange-800 mt-3">
        <strong>🔒 App em modo test:</strong> O endpoint <code>/sites/MLB/search</code> está bloqueado. 
        Para desbloquear, solicite aprovação da categoria no 
        <a href="https://developers.mercadolivre.com.br" target="_blank" class="underline">Painel ML Developers</a>.
      </div>` : ''}
  `
}

function mlCrawlClear() {
  CrawlState.log = []
  const logEl = document.getElementById('crawl-log')
  const wrap  = document.getElementById('crawl-log-wrap')
  const res   = document.getElementById('crawl-result')
  if (logEl) logEl.innerHTML = ''
  if (wrap)  wrap.classList.add('hidden')
  if (res)   res.classList.add('hidden')
}

// ════════════════════════════════════════════════════════════
// SEÇÃO: API Keys — Gerenciamento de chaves de acesso externo
// ════════════════════════════════════════════════════════════

function renderAPIKeys(area) {
  area.innerHTML = `
    <div class="space-y-6">

      <!-- Header cards -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div class="bg-gradient-to-br from-blue-600 to-blue-800 rounded-2xl p-5 text-white">
          <div class="text-3xl mb-1">🔑</div>
          <div class="text-2xl font-black" id="ak-total">—</div>
          <div class="text-blue-200 text-sm">Chaves ativas</div>
        </div>
        <div class="bg-gradient-to-br from-green-600 to-green-800 rounded-2xl p-5 text-white">
          <div class="text-3xl mb-1">📊</div>
          <div class="text-2xl font-black" id="ak-calls">—</div>
          <div class="text-green-200 text-sm">Total de chamadas</div>
        </div>
        <div class="bg-gradient-to-br from-purple-600 to-purple-800 rounded-2xl p-5 text-white">
          <div class="text-3xl mb-1">🌐</div>
          <div class="text-sm font-semibold text-purple-100 mt-2">Documentação pública</div>
          <a href="/api-docs" target="_blank"
            class="inline-block mt-2 bg-white/20 hover:bg-white/30 text-white text-xs font-bold px-3 py-1.5 rounded-lg transition-all">
            Ver /api-docs →
          </a>
        </div>
      </div>

      <!-- Criar nova chave -->
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-6">
        <h3 class="font-bold text-slate-800 mb-4 flex items-center gap-2">
          <span class="text-xl">➕</span> Criar Nova API Key
        </h3>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div>
            <label class="block text-xs font-semibold text-slate-500 mb-1.5">Nome do App/Parceiro *</label>
            <input id="ak-name" type="text" class="input" placeholder="Ex: App Mobile, Parceiro X">
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-500 mb-1.5">Email do Responsável</label>
            <input id="ak-email" type="email" class="input" placeholder="dev@parceiro.com">
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-500 mb-1.5">Plano</label>
            <select id="ak-plan" class="input">
              <option value="free">🆓 Free — 100 req/hora</option>
              <option value="pro">⚡ Pro — 1.000 req/hora</option>
              <option value="enterprise">🏢 Enterprise — 10.000 req/hora</option>
            </select>
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-500 mb-1.5">Limite por hora (req)</label>
            <input id="ak-rate" type="number" class="input" value="100" min="1" max="10000">
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-500 mb-1.5">Scopes</label>
            <select id="ak-scopes" class="input">
              <option value="read">📖 read — somente leitura</option>
              <option value="read,write">✏️ read, write</option>
            </select>
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-500 mb-1.5">Expira em (opcional)</label>
            <input id="ak-expires" type="date" class="input">
          </div>
          <div class="md:col-span-2 lg:col-span-3">
            <label class="block text-xs font-semibold text-slate-500 mb-1.5">Notas internas</label>
            <input id="ak-notes" type="text" class="input" placeholder="Obs sobre este parceiro...">
          </div>
        </div>
        <div class="mt-4 flex gap-3">
          <button onclick="akCreate()" class="btn-primary flex items-center gap-2">
            <span>🔑</span> Gerar API Key
          </button>
        </div>
        <!-- Exibe chave gerada (só uma vez) -->
        <div id="ak-new-key-box" class="hidden mt-4 bg-green-50 border-2 border-green-300 rounded-xl p-4">
          <p class="text-xs font-bold text-green-700 mb-2">✅ Chave gerada! Copie agora — não será exibida novamente:</p>
          <div class="flex items-center gap-2">
            <code id="ak-new-key-value" class="flex-1 bg-white border border-green-200 rounded-lg px-3 py-2 text-sm font-mono text-green-800 break-all"></code>
            <button onclick="akCopyKey()" class="btn-success shrink-0">📋 Copiar</button>
          </div>
        </div>
      </div>

      <!-- Lista de chaves -->
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-6">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-bold text-slate-800 flex items-center gap-2">
            <span class="text-xl">🗝️</span> Chaves Cadastradas
          </h3>
          <button onclick="akLoadList()" class="btn-secondary text-xs">↻ Atualizar</button>
        </div>
        <div id="ak-list">
          <div class="text-center py-8 text-slate-400">
            <p class="text-2xl mb-2">⏳</p>
            <p class="text-sm">Carregando...</p>
          </div>
        </div>
      </div>

      <!-- Documentação rápida dos endpoints -->
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-6">
        <h3 class="font-bold text-slate-800 mb-4 flex items-center gap-2">
          <span class="text-xl">📋</span> Endpoints Disponíveis
        </h3>
        <div class="space-y-2 text-sm font-mono">
          ${[
            ['GET', '/api/v1/status',         'Verifica autenticação e quota'],
            ['GET', '/api/v1/products',        'Lista produtos (filtros: category, brand, q, min_price, max_price, sort, page, limit)'],
            ['GET', '/api/v1/products/:id',    'Produto único com todas as ofertas'],
            ['GET', '/api/v1/search?q=',       'Busca por nome, marca ou EAN'],
            ['GET', '/api/v1/categories',      'Categorias com contagem de produtos'],
            ['GET', '/api/v1/deals',           'Melhores ofertas (filtro: category, min_discount)'],
            ['GET', '/api/v1/price/:ml_id',    'Preço atual de um item pelo ID ML (ex: MLB1234567890)'],
          ].map(([m,p,d]) => `
            <div class="flex items-start gap-3 py-2 border-b border-slate-50 last:border-0">
              <span class="shrink-0 badge-blue">${m}</span>
              <span class="text-blue-700 font-bold">${p}</span>
              <span class="text-slate-500 text-xs hidden md:block">${d}</span>
            </div>
          `).join('')}
        </div>
        <div class="mt-4 bg-slate-50 rounded-xl p-4 text-xs text-slate-600">
          <strong>Autenticação:</strong> Passe a chave no header <code class="bg-white px-1 rounded">X-API-Key: kr_live_...</code>
          ou como query param <code class="bg-white px-1 rounded">?api_key=kr_live_...</code>
        </div>
      </div>

    </div>
  `
  akLoadList()
}

async function akLoadList() {
  const listEl = document.getElementById('ak-list')
  if (!listEl) return

  const keys = await api('GET', '/admin/api/api-keys')
  if (!Array.isArray(keys) || !keys.length) {
    listEl.innerHTML = `
      <div class="text-center py-8 text-slate-400">
        <p class="text-3xl mb-2">🔑</p>
        <p class="text-sm">Nenhuma API Key cadastrada ainda.</p>
      </div>`
    document.getElementById('ak-total') && (document.getElementById('ak-total').textContent = '0')
    document.getElementById('ak-calls') && (document.getElementById('ak-calls').textContent = '0')
    return
  }

  const active = keys.filter(k => k.is_active)
  const totalCalls = keys.reduce((s, k) => s + (k.total_calls || 0), 0)
  if (document.getElementById('ak-total')) document.getElementById('ak-total').textContent = active.length
  if (document.getElementById('ak-calls')) document.getElementById('ak-calls').textContent = totalCalls.toLocaleString('pt-BR')

  listEl.innerHTML = `
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr>
            <th class="table-th rounded-tl-lg">Nome</th>
            <th class="table-th">Prefixo</th>
            <th class="table-th">Plano</th>
            <th class="table-th">Limite/h</th>
            <th class="table-th text-right">Chamadas</th>
            <th class="table-th">Último uso</th>
            <th class="table-th">Status</th>
            <th class="table-th rounded-tr-lg text-right">Ações</th>
          </tr>
        </thead>
        <tbody>
          ${keys.map(k => `
            <tr class="hover:bg-slate-50 transition-colors">
              <td class="table-td">
                <div class="font-semibold text-slate-800">${k.name}</div>
                ${k.owner_email ? `<div class="text-xs text-slate-400">${k.owner_email}</div>` : ''}
              </td>
              <td class="table-td font-mono text-xs text-slate-500">${k.key_prefix}…</td>
              <td class="table-td">
                <span class="badge-blue">${k.plan}</span>
              </td>
              <td class="table-td text-slate-600">${(k.rate_limit||100).toLocaleString('pt-BR')}</td>
              <td class="table-td text-right font-semibold">${(k.total_calls||0).toLocaleString('pt-BR')}</td>
              <td class="table-td text-xs text-slate-400">
                ${k.last_used_at ? new Date(k.last_used_at).toLocaleDateString('pt-BR') : '—'}
              </td>
              <td class="table-td">
                <label class="toggle-switch">
                  <input type="checkbox" ${k.is_active ? 'checked' : ''}
                    onchange="akToggle('${k.id}', this)">
                  <span class="toggle-slider"></span>
                </label>
              </td>
              <td class="table-td text-right">
                <div class="flex items-center justify-end gap-1">
                  <button onclick="akShowUsage('${k.id}','${k.name}')"
                    class="text-xs bg-blue-50 hover:bg-blue-100 text-blue-700 font-semibold px-2.5 py-1 rounded-lg transition-colors"
                    title="Ver uso">
                    📊
                  </button>
                  <button onclick="akRotate('${k.id}','${k.name}')"
                    class="text-xs bg-amber-50 hover:bg-amber-100 text-amber-700 font-semibold px-2.5 py-1 rounded-lg transition-colors"
                    title="Rotacionar chave">
                    🔄
                  </button>
                  <button onclick="akDelete('${k.id}','${k.name}')"
                    class="text-xs bg-red-50 hover:bg-red-100 text-red-600 font-semibold px-2.5 py-1 rounded-lg transition-colors"
                    title="Revogar">
                    🗑️
                  </button>
                </div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    <p class="text-xs text-slate-400 mt-3">${keys.length} chave(s) — ${active.length} ativa(s)</p>
  `
}

async function akCreate() {
  const name    = document.getElementById('ak-name')?.value?.trim()
  const email   = document.getElementById('ak-email')?.value?.trim()
  const plan    = document.getElementById('ak-plan')?.value || 'free'
  const rate    = parseInt(document.getElementById('ak-rate')?.value || '100')
  const scopes  = document.getElementById('ak-scopes')?.value || 'read'
  const expires = document.getElementById('ak-expires')?.value || null
  const notes   = document.getElementById('ak-notes')?.value?.trim()

  if (!name) { toast('Nome é obrigatório', 'error'); return }

  const planRateMap = { free: 100, pro: 1000, enterprise: 10000 }
  const finalRate   = rate || planRateMap[plan] || 100

  const res = await api('POST', '/admin/api/api-keys', {
    name, owner_email: email || null, plan, scopes,
    rate_limit: finalRate,
    expires_at: expires ? expires + 'T23:59:59Z' : null,
    notes: notes || null,
  })

  if (res?.ok && res.api_key) {
    // Exibe chave gerada
    const box = document.getElementById('ak-new-key-box')
    const val = document.getElementById('ak-new-key-value')
    if (box) box.classList.remove('hidden')
    if (val) val.textContent = res.api_key

    // Limpa form
    ;['ak-name','ak-email','ak-notes','ak-expires'].forEach(id => {
      const el = document.getElementById(id)
      if (el) el.value = ''
    })

    toast('✅ API Key criada! Copie agora.', 'success')
    akLoadList()
  } else {
    toast(`❌ ${res?.error || 'Erro ao criar chave'}`, 'error')
  }
}

function akCopyKey() {
  const val = document.getElementById('ak-new-key-value')?.textContent || ''
  if (!val) return
  navigator.clipboard.writeText(val).then(() => {
    toast('✅ Chave copiada!', 'success')
  }).catch(() => {
    // Fallback
    const ta = document.createElement('textarea')
    ta.value = val
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
    toast('✅ Chave copiada!', 'success')
  })
}

async function akToggle(id, checkbox) {
  const res = await api('PATCH', `/admin/api/api-keys/${id}/toggle`)
  if (res?.ok) {
    toast(res.is_active ? '✅ Chave ativada' : '⛔ Chave desativada', 'success')
    akLoadList()
  } else {
    checkbox.checked = !checkbox.checked
    toast('❌ Erro ao alterar status', 'error')
  }
}

async function akRotate(id, name) {
  if (!confirm(`Rotacionar a chave "${name}"?\n\nA chave antiga deixará de funcionar imediatamente.`)) return
  const res = await api('POST', `/admin/api/api-keys/${id}/rotate`)
  if (res?.ok && res.api_key) {
    const box = document.getElementById('ak-new-key-box')
    const val = document.getElementById('ak-new-key-value')
    if (box) box.classList.remove('hidden')
    if (val) val.textContent = res.api_key
    toast('🔄 Nova chave gerada! Copie agora.', 'success')
    akLoadList()
  } else {
    toast(`❌ ${res?.error || 'Erro'}`, 'error')
  }
}

async function akDelete(id, name) {
  if (!confirm(`Revogar a chave "${name}"?\n\nEsta ação é irreversível e todos os apps usando esta chave perderão acesso.`)) return
  const res = await api('DELETE', `/admin/api/api-keys/${id}`)
  if (res?.ok) {
    toast('🗑️ Chave revogada', 'success')
    akLoadList()
  } else {
    toast(`❌ ${res?.error || 'Erro'}`, 'error')
  }
}

async function akShowUsage(id, name) {
  const data = await api('GET', `/admin/api/api-keys/${id}/usage`)
  if (!data) return

  const s = data.summary || {}
  const modal = document.getElementById('modal-container')
  if (!modal) return

  modal.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this) this.innerHTML=''">
      <div class="modal max-w-2xl w-full mx-4">
        <div class="flex items-center justify-between mb-5">
          <h3 class="text-lg font-bold text-slate-800">📊 Uso — ${name}</h3>
          <button onclick="document.getElementById('modal-container').innerHTML=''"
            class="text-slate-400 hover:text-slate-600 text-xl leading-none">✕</button>
        </div>

        <!-- Métricas -->
        <div class="grid grid-cols-3 gap-3 mb-5">
          <div class="bg-blue-50 rounded-xl p-3 text-center">
            <div class="text-xl font-black text-blue-700">${(s.total_calls||0).toLocaleString('pt-BR')}</div>
            <div class="text-xs text-slate-500">Chamadas (30d)</div>
          </div>
          <div class="bg-green-50 rounded-xl p-3 text-center">
            <div class="text-xl font-black text-green-700">${(s.success_calls||0).toLocaleString('pt-BR')}</div>
            <div class="text-xs text-slate-500">Sucesso</div>
          </div>
          <div class="bg-red-50 rounded-xl p-3 text-center">
            <div class="text-xl font-black text-red-600">${(s.error_calls||0).toLocaleString('pt-BR')}</div>
            <div class="text-xs text-slate-500">Erros</div>
          </div>
        </div>

        <!-- Chamadas por dia -->
        ${data.by_day?.length ? `
          <div class="mb-4">
            <p class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Últimos 7 dias</p>
            <div class="flex items-end gap-1 h-16">
              ${(() => {
                const max = Math.max(...data.by_day.map(d => d.calls), 1)
                return data.by_day.map(d => `
                  <div class="flex-1 flex flex-col items-center gap-1" title="${d.day}: ${d.calls} chamadas">
                    <div class="w-full bg-blue-500 rounded-t"
                      style="height:${Math.max(4, Math.round((d.calls/max)*52))}px"></div>
                    <span class="text-xs text-slate-400">${d.calls}</span>
                  </div>
                `).join('')
              })()}
            </div>
          </div>` : ''}

        <!-- Últimas chamadas -->
        ${data.recent?.length ? `
          <div>
            <p class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Últimas chamadas</p>
            <div class="max-h-48 overflow-y-auto space-y-1">
              ${data.recent.slice(0,20).map(r => `
                <div class="flex items-center gap-2 text-xs py-1 border-b border-slate-50">
                  <span class="font-mono text-slate-400 shrink-0">${new Date(r.called_at).toLocaleTimeString('pt-BR')}</span>
                  <span class="${r.status_code < 400 ? 'text-green-600' : 'text-red-500'} font-bold shrink-0">${r.status_code}</span>
                  <span class="text-slate-600 truncate">${r.endpoint}</span>
                  <span class="text-slate-400 shrink-0">${r.duration_ms}ms</span>
                </div>
              `).join('')}
            </div>
          </div>` : '<p class="text-sm text-slate-400 text-center py-4">Sem histórico de uso ainda.</p>'}

        <div class="mt-5 flex justify-end">
          <button onclick="document.getElementById('modal-container').innerHTML=''"
            class="btn-secondary">Fechar</button>
        </div>
      </div>
    </div>
  `
}

// ── FEED INGESTION ────────────────────────────────────────
async function renderFeedIngestion(area) {
  // Carrega lista de lojas e lotes em paralelo
  const [storesRes, batchRes] = await Promise.all([
    api('GET', '/admin/api/stores?limit=100'),
    api('GET', '/admin/api/feed/batches?limit=10')
  ])
  const stores = storesRes?.stores || []
  const batches = batchRes?.batches || []
  const pendingLinks = batchRes?.pending_links || 0

  area.innerHTML = `
    <div class="section space-y-6">

      <!-- Header -->
      <div class="flex items-center justify-between">
        <div>
          <h3 class="text-xl font-bold text-slate-800">📥 Feed Ingestion</h3>
          <p class="text-sm text-slate-500 mt-0.5">Importe links de afiliados de qualquer rede — CSV, JSON ou colagem direta</p>
        </div>
        <div class="flex items-center gap-3">
          ${pendingLinks > 0 ? `
            <span class="inline-flex items-center gap-1.5 bg-amber-50 text-amber-700 border border-amber-200 text-sm font-medium px-3 py-1.5 rounded-lg">
              <span class="w-2 h-2 bg-amber-500 rounded-full animate-pulse"></span>
              ${pendingLinks} links pendentes
            </span>
          ` : ''}
          <button onclick="feedProcessPending()" class="btn-primary text-sm">
            ▶ Processar Pendentes
          </button>
        </div>
      </div>

      <!-- Upload / Ingestion Card -->
      <div class="stat-card">
        <h4 class="font-semibold text-slate-700 mb-4">➕ Novo Lote</h4>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">

          <!-- Loja -->
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Loja *</label>
            <select id="fi-store" class="input-field w-full">
              <option value="">— selecione —</option>
              ${stores.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}
            </select>
          </div>

          <!-- Rede -->
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Rede de Afiliados</label>
            <select id="fi-network" class="input-field w-full">
              <option value="manual">Manual</option>
              <option value="meli-api">Mercado Livre API</option>
              <option value="lomadee">Lomadee</option>
              <option value="hotmart">Hotmart</option>
              <option value="monetizze">Monetizze</option>
              <option value="amazon">Amazon Associates</option>
              <option value="magalu">Magalu Parceiros</option>
              <option value="shopee">Shopee Afiliados</option>
              <option value="csv">CSV / Feed Genérico</option>
            </select>
          </div>

          <!-- Notas -->
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Notas (opcional)</label>
            <input id="fi-notes" type="text" class="input-field w-full" placeholder="Ex: Importação semanal Lomadee">
          </div>
        </div>

        <!-- Tabs de formato -->
        <div class="border-b border-slate-200 mb-4">
          <div class="flex gap-0">
            <button onclick="feedSwitchTab('json')" id="fi-tab-json"
              class="fi-tab px-4 py-2 text-sm font-medium border-b-2 border-blue-500 text-blue-600">
              JSON Array
            </button>
            <button onclick="feedSwitchTab('csv')" id="fi-tab-csv"
              class="fi-tab px-4 py-2 text-sm font-medium border-b-2 border-transparent text-slate-500 hover:text-slate-700">
              CSV / Texto
            </button>
          </div>
        </div>

        <!-- Área JSON -->
        <div id="fi-panel-json">
          <label class="block text-xs font-medium text-slate-600 mb-1">
            JSON Array de itens
            <span class="text-slate-400 font-normal ml-1">— campos: name*, affiliate_url*, price, original_price, external_id, ean, image_url, product_url, brand, category</span>
          </label>
          <textarea id="fi-json" rows="8"
            class="w-full font-mono text-xs border border-slate-200 rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-blue-300 resize-y"
            placeholder='[
  {
    "name": "iPhone 15 Pro Max 256GB",
    "affiliate_url": "https://loja.com/go/produto123",
    "price": 8999.90,
    "original_price": 9999.00,
    "external_id": "produto123",
    "ean": "0194253708582",
    "brand": "Apple",
    "category": "smartphones",
    "image_url": "https://loja.com/img/produto123.jpg"
  }
]'></textarea>
        </div>

        <!-- Área CSV -->
        <div id="fi-panel-csv" class="hidden">
          <label class="block text-xs font-medium text-slate-600 mb-1">
            CSV com cabeçalho
            <span class="text-slate-400 font-normal ml-1">— colunas: name, affiliate_url, price, external_id, ean, brand, category</span>
          </label>
          <textarea id="fi-csv" rows="8"
            class="w-full font-mono text-xs border border-slate-200 rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-blue-300 resize-y"
            placeholder="name,affiliate_url,price,external_id,ean,brand,category
iPhone 15 Pro Max 256GB,https://loja.com/go/prod1,8999.90,prod1,0194253708582,Apple,smartphones
Galaxy S24 Ultra 512GB,https://loja.com/go/prod2,6999.00,prod2,,Samsung,smartphones"></textarea>
        </div>

        <!-- Botões -->
        <div class="flex items-center gap-3 mt-4">
          <button onclick="feedIngest()" class="btn-primary">
            📥 Enfileirar Links
          </button>
          <button onclick="feedIngestAndProcess()" class="bg-green-600 hover:bg-green-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
            ⚡ Enfileirar + Processar Agora
          </button>
          <button onclick="feedLoadExample()" class="btn-secondary text-sm">
            Ver Exemplo
          </button>
          <span id="fi-status" class="text-sm text-slate-500 ml-auto"></span>
        </div>

        <!-- Barra de progresso -->
        <div id="fi-progress" class="hidden mt-4">
          <div class="flex items-center justify-between text-xs text-slate-600 mb-1">
            <span id="fi-progress-label">Processando...</span>
            <span id="fi-progress-pct">0%</span>
          </div>
          <div class="w-full bg-slate-100 rounded-full h-2">
            <div id="fi-progress-bar" class="bg-blue-500 h-2 rounded-full transition-all duration-300" style="width:0%"></div>
          </div>
          <div id="fi-progress-stats" class="grid grid-cols-4 gap-2 mt-3 text-center"></div>
        </div>
      </div>

      <!-- Histórico de Lotes -->
      <div class="stat-card">
        <div class="flex items-center justify-between mb-4">
          <h4 class="font-semibold text-slate-700">📋 Histórico de Lotes</h4>
          <button onclick="renderFeedIngestion(document.getElementById('content-area'))"
            class="btn-secondary text-xs">↻ Atualizar</button>
        </div>

        ${batches.length === 0 ? `
          <p class="text-sm text-slate-400 text-center py-8">Nenhum lote importado ainda.</p>
        ` : `
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-slate-100">
                  <th class="text-left py-2 px-3 text-xs font-semibold text-slate-500">Lote</th>
                  <th class="text-left py-2 px-3 text-xs font-semibold text-slate-500">Loja</th>
                  <th class="text-left py-2 px-3 text-xs font-semibold text-slate-500">Rede</th>
                  <th class="text-right py-2 px-3 text-xs font-semibold text-slate-500">Total</th>
                  <th class="text-right py-2 px-3 text-xs font-semibold text-slate-500">Criados</th>
                  <th class="text-right py-2 px-3 text-xs font-semibold text-slate-500">Atualizados</th>
                  <th class="text-right py-2 px-3 text-xs font-semibold text-slate-500">Erros</th>
                  <th class="text-left py-2 px-3 text-xs font-semibold text-slate-500">Status</th>
                  <th class="text-left py-2 px-3 text-xs font-semibold text-slate-500">Data</th>
                  <th class="py-2 px-3"></th>
                </tr>
              </thead>
              <tbody>
                ${batches.map(b => {
                  const statusColor = {
                    done: 'bg-green-100 text-green-700',
                    processing: 'bg-blue-100 text-blue-700',
                    partial: 'bg-amber-100 text-amber-700',
                    error: 'bg-red-100 text-red-700'
                  }[b.status] || 'bg-slate-100 text-slate-600'
                  const pct = b.total_links > 0
                    ? Math.round(((b.matched + b.created + b.updated) / b.total_links) * 100)
                    : 0
                  return `
                    <tr class="border-b border-slate-50 hover:bg-slate-50 cursor-pointer" onclick="feedShowBatch('${b.id}')">
                      <td class="py-2 px-3 font-mono text-xs text-slate-400">${b.id.replace('batch_','').substring(0,16)}…</td>
                      <td class="py-2 px-3 text-slate-700">${b.store_name || '—'}</td>
                      <td class="py-2 px-3">
                        <span class="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">${b.network}</span>
                      </td>
                      <td class="py-2 px-3 text-right font-medium">${b.total_links}</td>
                      <td class="py-2 px-3 text-right text-green-600">${b.created}</td>
                      <td class="py-2 px-3 text-right text-blue-600">${b.matched + b.updated}</td>
                      <td class="py-2 px-3 text-right ${b.errors > 0 ? 'text-red-500 font-medium' : 'text-slate-400'}">${b.errors}</td>
                      <td class="py-2 px-3">
                        <span class="text-xs font-medium px-2 py-0.5 rounded-full ${statusColor}">
                          ${b.status}${b.status === 'processing' ? ` (${pct}%)` : ''}
                        </span>
                      </td>
                      <td class="py-2 px-3 text-xs text-slate-400">
                        ${new Date(b.started_at).toLocaleString('pt-BR', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}
                      </td>
                      <td class="py-2 px-3">
                        <button onclick="event.stopPropagation(); feedDeleteBatch('${b.id}')"
                          class="text-xs text-red-400 hover:text-red-600">✕</button>
                      </td>
                    </tr>
                  `
                }).join('')}
              </tbody>
            </table>
          </div>
        `}

        ${(batchRes?.total || 0) > 10 ? `
          <div class="mt-3 text-center">
            <button onclick="feedLoadMoreBatches()" class="btn-secondary text-xs">
              Ver todos os ${batchRes.total} lotes
            </button>
          </div>
        ` : ''}
      </div>

    </div>
  `

  // Inicializa tab ativa
  feedSwitchTab('json')
}

// ── Troca aba JSON / CSV ───────────────────────────────────
function feedSwitchTab(tab) {
  document.getElementById('fi-panel-json').classList.toggle('hidden', tab !== 'json')
  document.getElementById('fi-panel-csv').classList.toggle('hidden', tab !== 'csv')
  document.getElementById('fi-tab-json').className = `fi-tab px-4 py-2 text-sm font-medium border-b-2 ${
    tab === 'json' ? 'border-blue-500 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'
  }`
  document.getElementById('fi-tab-csv').className = `fi-tab px-4 py-2 text-sm font-medium border-b-2 ${
    tab === 'csv' ? 'border-blue-500 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'
  }`
}

// ── Exemplo de preenchimento ──────────────────────────────
function feedLoadExample() {
  document.getElementById('fi-json').value = JSON.stringify([
    {
      name: "iPhone 15 Pro Max 256GB Natural Titanium",
      affiliate_url: "https://exemplo.com/go/iphone15pm",
      price: 8999.90,
      original_price: 9999.00,
      external_id: "MLB123456789",
      ean: "0194253708582",
      brand: "Apple",
      category: "smartphones",
      image_url: "https://http2.mlstatic.com/D_NQ_NP_iphone15.jpg"
    },
    {
      name: "Samsung Galaxy S24 Ultra 512GB Titanium Black",
      affiliate_url: "https://exemplo.com/go/s24ultra",
      price: 6999.00,
      external_id: "MLB987654321",
      brand: "Samsung",
      category: "smartphones"
    }
  ], null, 2)
  feedSwitchTab('json')
  toast('Exemplo carregado!', 'success')
}

// ── Parseia o formulário e retorna { storeId, network, notes, items } ──
function feedParseForm() {
  const storeId = parseInt(document.getElementById('fi-store')?.value || '0')
  const network = document.getElementById('fi-network')?.value || 'manual'
  const notes   = document.getElementById('fi-notes')?.value?.trim() || null

  if (!storeId) { toast('Selecione uma loja', 'error'); return null }

  // Detecta aba ativa
  const csvPanel = document.getElementById('fi-panel-csv')
  const isCSV = csvPanel && !csvPanel.classList.contains('hidden')

  let items = []
  if (isCSV) {
    const text = document.getElementById('fi-csv')?.value?.trim()
    if (!text) { toast('Cole o CSV no campo de texto', 'error'); return null }
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
    const isHeader = /name|titulo|produto/i.test(lines[0]?.split(',')[0] || '')
    const dataLines = isHeader ? lines.slice(1) : lines
    items = dataLines.map(line => {
      const cols = line.split(',').map(s => s.trim().replace(/^"|"$/g, ''))
      const [name, affiliate_url, price, external_id, ean, brand, category] = cols
      return { name, affiliate_url, price: price ? parseFloat(price) : undefined, external_id: external_id || undefined, ean: ean || undefined, brand: brand || undefined, category: category || undefined }
    }).filter(i => i.name && i.affiliate_url)
  } else {
    const text = document.getElementById('fi-json')?.value?.trim()
    if (!text) { toast('Cole o JSON no campo de texto', 'error'); return null }
    try {
      items = JSON.parse(text)
      if (!Array.isArray(items)) { toast('O JSON deve ser um array [ ... ]', 'error'); return null }
    } catch(e) { toast('JSON inválido: ' + e.message, 'error'); return null }
  }

  if (items.length === 0) { toast('Nenhum item válido encontrado', 'error'); return null }
  if (items.length > 5000) { toast('Máximo 5000 itens por lote', 'error'); return null }

  return { storeId, network, notes, items }
}

// ── Enfileira links (sem processar) ──────────────────────
async function feedIngest() {
  const form = feedParseForm()
  if (!form) return

  const status = document.getElementById('fi-status')
  if (status) status.textContent = `⏳ Enfileirando ${form.items.length} links...`

  const res = await api('POST', '/admin/api/feed/ingest', {
    store_id: form.storeId,
    network: form.network,
    notes: form.notes,
    items: form.items
  })

  if (!res) return
  if (status) status.textContent = ''
  toast(`✅ ${res.total_queued} links enfileirados! Lote: ${res.batch_id}`, 'success')
  // Recarrega seção após 1s para mostrar o novo lote
  setTimeout(() => renderFeedIngestion(document.getElementById('content-area')), 1000)
}

// ── Enfileira + processa imediatamente ───────────────────
async function feedIngestAndProcess() {
  const form = feedParseForm()
  if (!form) return

  const status = document.getElementById('fi-status')
  const progress = document.getElementById('fi-progress')
  const progBar  = document.getElementById('fi-progress-bar')
  const progLabel = document.getElementById('fi-progress-label')
  const progPct  = document.getElementById('fi-progress-pct')
  const progStats = document.getElementById('fi-progress-stats')

  if (status) status.textContent = `⏳ Enfileirando ${form.items.length} links...`
  if (progress) progress.classList.remove('hidden')
  if (progBar)  progBar.style.width = '10%'
  if (progLabel) progLabel.textContent = 'Enfileirando links...'

  // 1. Ingest
  const ingestRes = await api('POST', '/admin/api/feed/ingest', {
    store_id: form.storeId,
    network: form.network,
    notes: form.notes,
    items: form.items
  })
  if (!ingestRes) { if (progress) progress.classList.add('hidden'); return }

  const batchId = ingestRes.batch_id
  if (progBar)  progBar.style.width = '30%'
  if (progLabel) progLabel.textContent = `Processando ${form.items.length} links...`
  if (status) status.textContent = `Lote ${batchId} — processando...`

  // 2. Process em rounds até zerar pendentes
  let round = 0
  let totalProcessed = 0
  let done = false

  while (!done && round < 20) {
    round++
    const procRes = await api('POST', `/admin/api/feed/process?batch_id=${batchId}&limit=200`)
    if (!procRes) break

    totalProcessed += procRes.processed || 0
    const batchStat = procRes.batches?.[batchId] || {}

    // Atualiza barra
    const pct = form.items.length > 0
      ? Math.min(99, Math.round((totalProcessed / form.items.length) * 100))
      : 99
    if (progBar) progBar.style.width = pct + '%'
    if (progPct) progPct.textContent = pct + '%'

    // Stats visuais
    if (progStats) {
      progStats.innerHTML = `
        <div class="bg-green-50 rounded p-2">
          <div class="text-green-700 font-bold text-lg">${batchStat.created || 0}</div>
          <div class="text-green-600 text-xs">Criados</div>
        </div>
        <div class="bg-blue-50 rounded p-2">
          <div class="text-blue-700 font-bold text-lg">${(batchStat.matched || 0) + (batchStat.updated || 0)}</div>
          <div class="text-blue-600 text-xs">Atualizados</div>
        </div>
        <div class="bg-slate-50 rounded p-2">
          <div class="text-slate-700 font-bold text-lg">${batchStat.skipped || 0}</div>
          <div class="text-slate-600 text-xs">Ignorados</div>
        </div>
        <div class="bg-red-50 rounded p-2">
          <div class="text-red-700 font-bold text-lg">${batchStat.errors || 0}</div>
          <div class="text-red-600 text-xs">Erros</div>
        </div>
      `
    }

    if ((procRes.processed || 0) === 0) done = true
    if (!done) await new Promise(r => setTimeout(r, 300))
  }

  // Finaliza UI
  if (progBar) progBar.style.width = '100%'
  if (progPct) progPct.textContent = '100%'
  if (progLabel) progLabel.textContent = '✅ Processamento concluído!'
  if (status) status.textContent = ''

  toast(`✅ ${totalProcessed} links processados com sucesso!`, 'success')
  setTimeout(() => renderFeedIngestion(document.getElementById('content-area')), 1500)
}

// ── Processa links pendentes globais ─────────────────────
async function feedProcessPending() {
  const btn = event?.target
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Processando...' }

  let round = 0, total = 0
  while (round < 30) {
    round++
    const res = await api('POST', '/admin/api/feed/process?limit=200')
    if (!res || res.processed === 0) break
    total += res.processed
    await new Promise(r => setTimeout(r, 200))
  }

  if (btn) { btn.disabled = false; btn.textContent = '▶ Processar Pendentes' }
  toast(total > 0 ? `✅ ${total} links processados!` : 'Nenhum link pendente.', total > 0 ? 'success' : 'info')
  setTimeout(() => renderFeedIngestion(document.getElementById('content-area')), 800)
}

// ── Detalhe de um lote (modal) ────────────────────────────
async function feedShowBatch(id) {
  const res = await api('GET', `/admin/api/feed/batches/${id}`)
  if (!res) return

  const b = res.batch
  const dist = res.status_distribution || []
  const links = res.links || []
  const errors = res.errors || []

  const statusColor = {
    done: 'bg-green-100 text-green-700',
    processing: 'bg-blue-100 text-blue-700',
    partial: 'bg-amber-100 text-amber-700',
    error: 'bg-red-100 text-red-700'
  }

  const methodBadge = {
    ean: '🔵 EAN',
    external_id: '🟣 ID Externo',
    ml_item_id: '🟡 ML Item',
    name_fuzzy: '🟠 Nome ~',
    name_exact: '🟢 Nome =',
    new: '⭐ Novo'
  }

  document.getElementById('modal-container').innerHTML = `
    <div class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onclick="if(event.target===this)this.remove()">
      <div class="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[85vh] overflow-y-auto">

        <!-- Header -->
        <div class="flex items-center justify-between p-6 border-b border-slate-100">
          <div>
            <h3 class="text-lg font-bold text-slate-800">📋 Detalhe do Lote</h3>
            <p class="text-xs font-mono text-slate-400 mt-0.5">${b.id}</p>
          </div>
          <div class="flex items-center gap-2">
            ${b.status === 'processing' ? `
              <button onclick="feedProcessBatch('${b.id}')" class="btn-primary text-sm">
                ▶ Continuar processamento
              </button>
            ` : ''}
            <button onclick="this.closest('.fixed').remove()" class="text-slate-400 hover:text-slate-600 text-xl">✕</button>
          </div>
        </div>

        <div class="p-6 space-y-5">

          <!-- Resumo -->
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div class="bg-slate-50 rounded-xl p-3 text-center">
              <div class="text-2xl font-bold text-slate-800">${b.total_links}</div>
              <div class="text-xs text-slate-500">Total</div>
            </div>
            <div class="bg-green-50 rounded-xl p-3 text-center">
              <div class="text-2xl font-bold text-green-700">${b.created}</div>
              <div class="text-xs text-green-600">Produtos criados</div>
            </div>
            <div class="bg-blue-50 rounded-xl p-3 text-center">
              <div class="text-2xl font-bold text-blue-700">${b.matched + b.updated}</div>
              <div class="text-xs text-blue-600">Atualizados</div>
            </div>
            <div class="bg-red-50 rounded-xl p-3 text-center">
              <div class="text-2xl font-bold text-red-700">${b.errors}</div>
              <div class="text-xs text-red-600">Erros</div>
            </div>
          </div>

          <!-- Meta -->
          <div class="flex flex-wrap gap-3 text-sm text-slate-600">
            <span>🏪 <strong>${b.store_name || '—'}</strong></span>
            <span>🔗 <strong>${b.network}</strong></span>
            <span>📅 ${new Date(b.started_at).toLocaleString('pt-BR')}</span>
            <span class="px-2 py-0.5 rounded-full text-xs font-medium ${statusColor[b.status] || 'bg-slate-100 text-slate-600'}">${b.status}</span>
            ${b.notes ? `<span class="italic text-slate-400">${b.notes}</span>` : ''}
          </div>

          <!-- Distribuição de status -->
          ${dist.length > 0 ? `
            <div>
              <h5 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Distribuição por Status</h5>
              <div class="flex gap-2 flex-wrap">
                ${dist.map(d => `
                  <span class="text-xs px-2 py-1 rounded-full bg-slate-100 text-slate-600">
                    <strong>${d.count}</strong> ${d.status}
                  </span>
                `).join('')}
              </div>
            </div>
          ` : ''}

          <!-- Erros -->
          ${errors.length > 0 ? `
            <div>
              <h5 class="text-xs font-semibold text-red-500 uppercase tracking-wide mb-2">⚠ Primeiros Erros</h5>
              <div class="space-y-1 max-h-32 overflow-y-auto">
                ${errors.map(e => `
                  <div class="text-xs bg-red-50 border border-red-100 rounded p-2">
                    <span class="font-medium text-red-700 truncate block">${e.name}</span>
                    <span class="text-red-400">${e.error_msg}</span>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}

          <!-- Tabela de links (últimos 50) -->
          <div>
            <h5 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
              Últimos links processados (máx 50)
            </h5>
            <div class="overflow-x-auto">
              <table class="w-full text-xs">
                <thead>
                  <tr class="border-b border-slate-100">
                    <th class="text-left py-1.5 px-2 text-slate-500">Nome do Link</th>
                    <th class="text-left py-1.5 px-2 text-slate-500">Produto Casado</th>
                    <th class="text-left py-1.5 px-2 text-slate-500">Método</th>
                    <th class="text-right py-1.5 px-2 text-slate-500">Score</th>
                    <th class="text-right py-1.5 px-2 text-slate-500">Preço</th>
                    <th class="text-left py-1.5 px-2 text-slate-500">Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${links.map(l => {
                    const sc = { matched:'bg-blue-50 text-blue-700', created:'bg-green-50 text-green-700',
                      updated:'bg-indigo-50 text-indigo-700', error:'bg-red-50 text-red-600',
                      pending:'bg-slate-50 text-slate-500', skipped:'bg-slate-50 text-slate-400' }
                    return `
                      <tr class="border-b border-slate-50 hover:bg-slate-50">
                        <td class="py-1.5 px-2 max-w-xs truncate text-slate-700" title="${l.name}">${l.name}</td>
                        <td class="py-1.5 px-2 max-w-xs truncate text-slate-500" title="${l.product_name || ''}">
                          ${l.product_name ? `<a href="/produto/${l.product_id}" target="_blank" class="hover:text-blue-600">${l.product_name}</a>` : '—'}
                        </td>
                        <td class="py-1.5 px-2">${methodBadge[l.match_method] || (l.match_method || '—')}</td>
                        <td class="py-1.5 px-2 text-right font-mono">${l.match_score != null ? (l.match_score * 100).toFixed(0) + '%' : '—'}</td>
                        <td class="py-1.5 px-2 text-right">${l.price != null ? 'R$' + l.price.toFixed(2) : '—'}</td>
                        <td class="py-1.5 px-2">
                          <span class="px-1.5 py-0.5 rounded text-xs font-medium ${sc[l.status] || 'bg-slate-100 text-slate-500'}">${l.status}</span>
                          ${l.error_msg ? `<span class="text-red-400 ml-1" title="${l.error_msg}">⚠</span>` : ''}
                        </td>
                      </tr>
                    `
                  }).join('')}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      </div>
    </div>
  `
}

// ── Processa um lote específico ───────────────────────────
async function feedProcessBatch(batchId) {
  toast('Processando lote...', 'info')
  let round = 0, total = 0
  while (round < 20) {
    round++
    const res = await api('POST', `/admin/api/feed/process?batch_id=${batchId}&limit=200`)
    if (!res || res.processed === 0) break
    total += res.processed
    await new Promise(r => setTimeout(r, 300))
  }
  toast(`✅ ${total} links processados!`, 'success')
  document.getElementById('modal-container').innerHTML = ''
  setTimeout(() => renderFeedIngestion(document.getElementById('content-area')), 500)
}

// ── Carrega mais lotes ────────────────────────────────────
async function feedLoadMoreBatches() {
  const res = await api('GET', '/admin/api/feed/batches?limit=100')
  // Substitui apenas a tabela de histórico
  const container = document.getElementById('content-area')
  if (container) renderFeedIngestion(container)
}

// ── Remove lote ────────────────────────────────────────────
async function feedDeleteBatch(id) {
  if (!confirm('Remover este lote e todos os seus raw_links?')) return
  await api('DELETE', `/admin/api/feed/batches/${id}`)
  toast('Lote removido.', 'success')
  setTimeout(() => renderFeedIngestion(document.getElementById('content-area')), 500)
}

// ============================================================
// CATEGORIAS — renderCategories
// Lista todas as categorias com COUNT real + botão de sync
// ============================================================
async function renderCategories(area) {
  area.innerHTML = `<div class="flex items-center justify-center py-16"><div class="text-slate-400 text-sm">Carregando categorias...</div></div>`

  const cats = await api('GET', '/admin/api/categories')
  if (!cats) return

  // Totais
  const totalCats  = cats.length
  const activeCats = cats.filter(c => c.is_active).length
  const totalProds = cats.reduce((s, c) => s + (c.product_count || 0), 0)
  const emptyCats  = cats.filter(c => (c.product_count || 0) === 0).length

  const statusBadge = (cat) => {
    if (!cat.is_active) return `<span class="badge-red">inativa</span>`
    if ((cat.product_count || 0) === 0) return `<span class="badge-yellow">vazia</span>`
    return `<span class="badge-green">ativa</span>`
  }

  const syncDiff = (cat) => {
    const stored = cat.stored_count || 0
    const real   = cat.product_count || 0
    if (stored === real) return `<span class="text-xs text-slate-400">=</span>`
    const delta = real - stored
    const color = delta > 0 ? 'text-green-600' : 'text-red-500'
    return `<span class="text-xs font-bold ${color}">${delta > 0 ? '+' : ''}${delta}</span>`
  }

  area.innerHTML = `
    <div class="section">

      <!-- Header -->
      <div class="flex items-center justify-between">
        <div>
          <h2 class="text-xl font-black text-slate-800">🗂️ Categorias</h2>
          <p class="text-sm text-slate-500 mt-0.5">${activeCats} ativas · ${totalProds} produtos · ${emptyCats} vazias</p>
        </div>
        <button onclick="syncCategories()" id="btn-sync-cats"
          class="btn-primary flex items-center gap-2">
          🔄 Sincronizar Contadores
        </button>
        <button onclick="recategorizeProducts()" id="btn-recat"
          class="btn-secondary flex items-center gap-2 ml-2">
          🤖 Recategorizar Produtos
        </button>
      </div>

      <!-- Cards resumo -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div class="stat-card text-center">
          <div class="text-2xl font-black text-blue-600">${totalCats}</div>
          <div class="text-xs text-slate-500 mt-1">Total de categorias</div>
        </div>
        <div class="stat-card text-center">
          <div class="text-2xl font-black text-green-600">${activeCats}</div>
          <div class="text-xs text-slate-500 mt-1">Ativas</div>
        </div>
        <div class="stat-card text-center">
          <div class="text-2xl font-black text-slate-800">${totalProds}</div>
          <div class="text-xs text-slate-500 mt-1">Produtos reais</div>
        </div>
        <div class="stat-card text-center">
          <div class="text-2xl font-black ${emptyCats > 0 ? 'text-amber-500' : 'text-green-600'}">${emptyCats}</div>
          <div class="text-xs text-slate-500 mt-1">Vazias</div>
        </div>
      </div>

      <!-- Aviso de categorias com contagem desatualizada -->
      ${(() => {
        const stale = cats.filter(c => (c.stored_count || 0) !== (c.product_count || 0))
        if (stale.length === 0) return ''
        return `
          <div class="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-start gap-3">
            <span class="text-amber-500 text-lg shrink-0">⚠️</span>
            <div>
              <div class="text-sm font-bold text-amber-800">${stale.length} categori${stale.length > 1 ? 'as têm' : 'a tem'} contagem desatualizada</div>
              <div class="text-xs text-amber-700 mt-0.5">
                Clique em <strong>Sincronizar Contadores</strong> para atualizar o campo <code>product_count</code> no banco.
              </div>
            </div>
          </div>`
      })()}

      <!-- Tabela de categorias -->
      <div class="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <table class="w-full">
          <thead>
            <tr class="bg-slate-50 border-b border-slate-100">
              <th class="table-th">Ícone</th>
              <th class="table-th">Slug</th>
              <th class="table-th">Nome</th>
              <th class="table-th text-right">Produtos reais</th>
              <th class="table-th text-right">No banco</th>
              <th class="table-th text-center">Delta</th>
              <th class="table-th text-center">Status</th>
              <th class="table-th text-center">Ordem</th>
              <th class="table-th text-center">Ações</th>
            </tr>
          </thead>
          <tbody>
            ${cats.map(cat => `
              <tr class="hover:bg-slate-50 transition-colors ${(cat.product_count || 0) === 0 ? 'opacity-60' : ''}">
                <td class="table-td text-2xl">${cat.icon || '🛍️'}</td>
                <td class="table-td">
                  <code class="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded">${cat.slug}</code>
                </td>
                <td class="table-td font-semibold text-slate-800">${cat.name}</td>
                <td class="table-td text-right">
                  <a href="/categoria/${cat.slug}" target="_blank"
                     class="text-blue-600 hover:underline font-bold">
                    ${cat.product_count || 0}
                  </a>
                </td>
                <td class="table-td text-right text-slate-500 text-xs">${cat.stored_count || 0}</td>
                <td class="table-td text-center">${syncDiff(cat)}</td>
                <td class="table-td text-center">${statusBadge(cat)}</td>
                <td class="table-td text-center text-xs text-slate-500">${cat.sort_order || 0}</td>
                <td class="table-td text-center">
                  <a href="/categoria/${cat.slug}" target="_blank"
                     class="text-xs text-blue-500 hover:text-blue-700 hover:underline">
                    Ver →
                  </a>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <!-- Info sobre auto-categorização -->
      <div class="bg-blue-50 border border-blue-200 rounded-2xl p-5">
        <h3 class="font-bold text-blue-800 mb-2">🤖 Auto-categorização ativa</h3>
        <p class="text-sm text-blue-700 leading-relaxed">
          Ao importar links via <strong>Feed Ingestion</strong>, o sistema detecta automaticamente a categoria
          pelo nome e URL do produto. O mapa cobre: smartphones, notebooks, TVs, tablets, games, áudio,
          câmeras, eletrodomésticos, computadores, monitores, impressoras, componentes, armazenamento,
          redes e moda.
        </p>
        <div class="mt-3 flex flex-wrap gap-2">
          ${['smartphones','notebooks','tv','tablets','games','audio','cameras',
             'eletrodomesticos','computadores','monitores','impressoras',
             'componentes','armazenamento','redes','moda'].map(slug => `
            <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-semibold bg-blue-100 text-blue-700">
              ${cats.find(c => c.slug === slug)?.icon || '🏷️'} ${slug}
            </span>
          `).join('')}
        </div>
      </div>

    </div>
  `
}

// ── Sincroniza product_count no banco ────────────────────
async function syncCategories() {
  const btn = document.getElementById('btn-sync-cats')
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Sincronizando...' }

  const res = await api('POST', '/admin/api/categories/sync')
  if (res?.ok) {
    toast(`✅ ${res.message}`, 'success')
    setTimeout(() => renderCategories(document.getElementById('content-area')), 600)
  } else {
    toast('Erro ao sincronizar', 'error')
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Sincronizar Contadores' }
  }
}

// ── Recategoriza produtos sem categoria (backfill) ────────
async function recategorizeProducts() {
  const btn = document.getElementById('btn-recat')
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Detectando...' }

  toast('Rodando auto-categorização nos produtos sem categoria...', 'info')

  const res = await api('POST', '/admin/api/categories/recategorize', null, 30000)
  if (!res) {
    toast('Timeout ou erro na recategorização', 'error')
    if (btn) { btn.disabled = false; btn.textContent = '🤖 Recategorizar Produtos' }
    return
  }

  if (res.ok) {
    const msg = `✅ ${res.updated} produto${res.updated !== 1 ? 's' : ''} categorizados` +
                (res.skipped > 0 ? ` · ${res.skipped} sem categoria reconhecida` : '')
    toast(msg, 'success')

    // Mostra preview dos resultados no modal
    if (res.results && res.results.length > 0) {
      const mc = document.getElementById('modal-container')
      if (mc) {
        mc.innerHTML = `
          <div class="modal-backdrop" onclick="this.parentElement.innerHTML=''">
            <div class="modal max-w-2xl" onclick="event.stopPropagation()">
              <div class="flex items-center justify-between mb-4">
                <h3 class="font-bold text-slate-800">🤖 Produtos recategorizados (${res.updated})</h3>
                <button onclick="document.getElementById('modal-container').innerHTML=''"
                  class="text-slate-400 hover:text-slate-700">✕</button>
              </div>
              <div class="overflow-y-auto max-h-80 space-y-1">
                ${res.results.map(r => `
                  <div class="flex items-center gap-3 px-3 py-2 rounded-lg bg-slate-50 text-sm">
                    <span class="badge-blue">${r.category}</span>
                    <span class="text-slate-600 truncate">${r.name}</span>
                  </div>
                `).join('')}
              </div>
              <div class="mt-4 pt-4 border-t border-slate-100 flex justify-between items-center">
                <span class="text-xs text-slate-400">${res.skipped} produto${res.skipped !== 1 ? 's' : ''} sem categoria reconhecida (ficaram como "outros")</span>
                <button onclick="document.getElementById('modal-container').innerHTML=''"
                  class="btn-primary text-sm">Fechar</button>
              </div>
            </div>
          </div>`
      }
    }

    // Após fechar o modal, sincroniza contadores e recarrega
    setTimeout(async () => {
      await api('POST', '/admin/api/categories/sync')
      renderCategories(document.getElementById('content-area'))
    }, 800)
  } else {
    toast(res.message || 'Nenhum produto para recategorizar', 'info')
    if (btn) { btn.disabled = false; btn.textContent = '🤖 Recategorizar Produtos' }
  }
}
