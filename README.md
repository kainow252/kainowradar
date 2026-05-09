# ShoppingCompare 🛒

Shopping comparador de preços estilo Buscapé — construído com Hono + Cloudflare Pages + D1 + KV.

## 🌐 URLs
- **Local (sandbox):** https://3000-it6xuh3lcux4gzjw0rjqh-5c13a017.sandbox.novita.ai
- **Produção:** (deploy via `npm run deploy` no Cloudflare Pages)

---

## 🏗️ Arquitetura

### Banco de Dados Híbrido
| Camada | Tecnologia | O que guarda |
|--------|-----------|--------------|
| Estrutura | **Cloudflare D1** (SQLite) | Produtos, lojas, categorias, ofertas, fila de jobs |
| Velocidade | **Cloudflare KV** | Cache de preços (TTL 1h), buscas (TTL 5min), produtos (TTL 30min) |

### Tabelas D1
```
products       → Produto único (EAN como chave mestre)
offers         → 1 oferta por loja por produto (preço, checkout_url, etc.)
stores         → 8 lojas parceiras + padrões de deeplink
url_patterns   → Tabela de templates de URL configurável por loja
categories     → Categorias com ícone e contagem
click_events   → Analytics de cliques (IP hasheado)
price_update_queue → Fila de background jobs para atualização cirúrgica
```

---

## 🧠 Módulos Implementados

### Módulo 1 — O Coração (`src/lib/cache.ts`)
- `CacheManager` wrapping Cloudflare KV
- TTLs diferenciados: preços (1h), produtos (30min), buscas (5min), categorias (1h)
- Invalidação granular por slug ou productId

### Módulo 2 — Motor de Ingestão (`src/lib/ingest.ts`)
- `IngestEngine.ingestBatch()` → processa feeds XML/CSV em lotes de 50
- Upsert inteligente: atualiza se existe, cria se não existe
- `queuePriceUpdate(offerId, priority)` → prioridade 1 (clicou) a 10 (baixo)
- `processQueue(limit)` → background job para atualização cirúrgica

### Módulo 3 — Algoritmo de Matching (`src/lib/matching.ts`)
Cascata de 3 etapas em ordem de confiança:
1. **EAN/GTIN** → confiança 100% (código de barras idêntico)
2. **SKU externo** → confiança 95% (mesmo external_id na mesma loja)
3. **Jaro-Winkler + Jaccard tokenizado** → confiança variável (threshold 0.72)

```
"iPhone 15 128GB Preto Lacrado" ↔ "Apple iPhone 15 128GB" = 0.78 ✅ MATCH
"Samsung TV 55 4K" ↔ "LG TV 55 4K" = 0.61 ❌ NO MATCH
```

### Módulo 4 — Deeplink Engine (`src/lib/deeplink.ts`)
Gera URL de checkout direto por loja:

| Loja | Tipo | URL gerada |
|------|------|-----------|
| Amazon | Cart:Create | `amazon.com.br/gp/aws/cart/add.html?ASIN.1={ID}` |
| Magalu | Carrinho | `magazineluiza.com.br/carrinho/adicionar/{ID}/` |
| Mercado Livre | Checkout direto | `mercadolivre.com.br/checkout/buy?item_id={ID}` |
| Casas Bahia | Carrinho | `casasbahia.com.br/produto/{ID}/carrinho` |
| Americanas | Add-to-cart | `americanas.com.br/produto/{ID}/add-to-cart` |

---

## 🔌 API REST

```bash
# Busca de produtos
GET /api/products?q=iphone&category=smartphones&sort=price_asc&page=1

# Produto com ofertas
GET /api/products/:slug

# Autocompletar
GET /api/search/suggestions?q=ipho

# Destaques / Deals
GET /api/featured
GET /api/deals

# Categorias e Lojas
GET /api/categories
GET /api/stores

# Rastrear clique (prioriza update de preço)
POST /api/click { offer_id, product_id, store_id }

# Ingestão de dados (protegida por Bearer token)
POST /api/ingest { items: IngestItem[] }

# Background job
POST /api/cron/process-queue
```

### Redirect com rastreamento
```
GET /go/:productSlug/:offerId
→ Registra clique → Gera URL de afiliado → 302 para loja
```

---

## 📦 Estrutura do Projeto

```
webapp/
├── src/
│   ├── index.tsx           # Entry point + homepage SSR
│   ├── types/index.ts      # TypeScript types
│   ├── lib/
│   │   ├── cache.ts        # CacheManager (KV)
│   │   ├── matching.ts     # MatchingEngine (EAN/SKU/Jaro-Winkler)
│   │   ├── ingest.ts       # IngestEngine (feeds + fila)
│   │   └── deeplink.ts     # DeeplinkEngine (checkout direto)
│   └── routes/
│       ├── api.ts          # Todos os endpoints /api/*
│       └── pages.ts        # SSR das páginas HTML
├── public/static/
│   ├── style.css           # Design system completo
│   └── app.js              # Frontend JS (search, suggestions, tracking)
├── migrations/
│   ├── 0001_initial_schema.sql  # Schema completo
│   ├── 0002_seed_stores.sql     # 8 lojas + padrões de URL
│   └── 0003_seed_products.sql   # 7 produtos demo + 16 ofertas
├── ecosystem.config.cjs    # PM2 config para sandbox
└── wrangler.jsonc          # Config Cloudflare Pages + D1 + KV
```

---

## 🚀 Setup e Deploy

### Desenvolvimento local (sandbox)
```bash
# Aplicar migrations e seeds
npm run db:migrate:local

# Build
npm run build

# Iniciar com PM2
pm2 start ecosystem.config.cjs

# Testar
curl http://localhost:3000/api/products
```

### Deploy para Cloudflare Pages (produção)

#### 1. Criar banco D1
```bash
npx wrangler d1 create shopping-compare-production
# Copiar o database_id para wrangler.jsonc
```

#### 2. Criar KV namespace
```bash
npx wrangler kv:namespace create CACHE
npx wrangler kv:namespace create CACHE --preview
# Copiar os IDs para wrangler.jsonc
```

#### 3. Aplicar migrations em produção
```bash
npm run db:migrate:prod
```

#### 4. Configurar segredos (APIs de afiliados)
```bash
npx wrangler pages secret put AMAZON_ACCESS_KEY --project-name shopping-compare
npx wrangler pages secret put AMAZON_SECRET_KEY --project-name shopping-compare
npx wrangler pages secret put AMAZON_PARTNER_TAG --project-name shopping-compare
npx wrangler pages secret put LOMADEE_SOURCE_ID  --project-name shopping-compare
npx wrangler pages secret put AWIN_PUBLISHER_ID  --project-name shopping-compare
npx wrangler pages secret put MELI_ACCESS_TOKEN  --project-name shopping-compare
```

#### 5. Deploy
```bash
npm run deploy
```

---

## 🛍️ Lojas Parceiras

| Loja | Rede | Comissão | Deeplink |
|------|------|----------|---------|
| Amazon | PA-API v5 | 8% | Cart:Create (cookie 90 dias) |
| Magazine Luiza | Lomadee | 5% | Carrinho direto |
| Mercado Livre | ML API | 3% | Checkout direto |
| Shopee | Lomadee | 6% | Link parametrizado |
| Americanas | Awin | 4.5% | Add-to-cart |
| Casas Bahia | Awin | 4% | Carrinho |
| Submarino | Awin | 4.5% | Produto |
| AliExpress | Awin | 7% | Produto |

---

## 🗺️ Próximos Passos

### Fase 2 — Ingestão real de dados
- [ ] Conectar Amazon PA-API 5.0 (Cart:Create real)
- [ ] Integrar Lomadee feed XML (download noturno)
- [ ] Integrar Awin feed CSV
- [ ] Webhook de Mercado Livre para preços em tempo real
- [ ] Cron job Cloudflare para processar fila a cada 5 min

### Fase 3 — Funcionalidades avançadas
- [ ] Alertas de preço (e-mail quando o preço baixar)
- [ ] Histórico de preços (gráfico com Chart.js)
- [ ] Comparação lado a lado (até 4 produtos)
- [ ] Filtros avançados: frete grátis, condição, vendedor oficial
- [ ] SEO: sitemap.xml + meta tags Open Graph
- [ ] PWA: service worker + manifest.json

### Fase 4 — Escala
- [ ] Cloudflare R2 para imagens (CDN próprio)
- [ ] Algolia para busca full-text avançada
- [ ] Cloudflare Analytics para métricas de cliques
- [ ] A/B testing de layouts de produto

---

## 📊 Status Atual
- **Plataforma:** Cloudflare Pages (edge computing)
- **Banco:** D1 local ✅ | D1 produção ⏳
- **Cache:** KV local ✅ | KV produção ⏳
- **Produtos demo:** 7 produtos, 16 ofertas, 8 lojas
- **Última atualização:** 2025-05-09
