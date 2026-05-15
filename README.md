# ShoppingCompare — Comparador de Preços estilo Buscapé

## URLs de Produção

| Ambiente | URL |
|----------|-----|
| **Homepage** | https://shopping-compare.pages.dev/ |
| **Admin Panel** | https://shopping-compare.pages.dev/admin |
| **API Base** | https://shopping-compare.pages.dev/api |
| **Deploy** | Cloudflare Pages (Edge global) |

**Senha admin (produção):** `kainow@admin2025`

---

## Visão Geral

Comparador de preços com 8 lojas parceiras, painel administrativo completo, motor de ingestão de feeds e deeplinks de checkout direto.

**Lojas:** Amazon · Magalu · Mercado Livre · Shopee · Americanas · Casas Bahia · Submarino · AliExpress

---

## Arquitetura

```
Cloudflare Pages (Edge)
├── Hono Framework (SSR + API)
├── Cloudflare D1 (SQLite — webapp-production: 271288fa)
├── Cloudflare KV  (Cache — CACHE: 81f0b165)
└── Wrangler Secrets (ADMIN_SECRET, API keys)
```

### Módulos principais

| Módulo | Arquivo | Função |
|--------|---------|--------|
| **Rotas API** | `src/routes/api.ts` | Produtos, busca, ofertas, cliques, ingest |
| **Páginas SSR** | `src/routes/pages.ts` | Homepage, produto, categoria, redirect |
| **Admin SPA** | `src/routes/admin.ts` | Painel completo (vanilla JS) |
| **Cache** | `src/lib/cache.ts` | KV wrapper com TTL diferenciado |
| **Matching** | `src/lib/matching.ts` | EAN → SKU → Jaro-Winkler (0.72) |
| **Ingestão** | `src/lib/ingest.ts` | Batch upsert + processamento de fila |
| **Deeplinks** | `src/lib/deeplink.ts` | Geração de URLs de checkout direto |

---

## API Reference

### Públicas

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| `GET` | `/api/products` | Lista com filtros: `?q=`, `?category=`, `?store=`, `?sort=`, `?page=`, `?limit=` |
| `GET` | `/api/products/:slug` | Produto + ofertas comparadas |
| `GET` | `/api/search/suggestions?q=` | Autocomplete (5 sugestões) |
| `GET` | `/api/featured` | Produtos em destaque |
| `GET` | `/api/deals` | Melhores ofertas |
| `GET` | `/api/categories` | Categorias com contagem |
| `GET` | `/api/stores` | Lojas ativas |
| `POST` | `/api/click` | Rastrear clique em oferta |
| `POST` | `/api/ingest` | Ingestão em lote (Bearer token) |
| `POST` | `/api/cron/process-queue` | Processar fila de atualização |

### Admin (Bearer token obrigatório)

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| `POST` | `/admin/api/login` | Login → retorna token |
| `POST` | `/admin/api/logout` | Invalida sessão |
| `GET` | `/admin/api/dashboard` | Métricas: produtos, ofertas, cliques, fila |
| `GET` | `/admin/api/top-deals` | GROUP BY MIN(price) por produto |
| `GET` | `/admin/api/products` | Lista produtos com filtros |
| `PATCH` | `/admin/api/products/:id` | Editar produto |
| `DELETE` | `/admin/api/products/:id` | Remover produto |
| `GET` | `/admin/api/offers` | Lista ofertas |
| `GET` | `/admin/api/stores` | Lojas + métricas |
| `PATCH` | `/admin/api/stores/:id/toggle` | Ativar/desativar loja |
| `GET` | `/admin/api/api-configs` | Configurações de APIs/integrações |
| `PATCH` | `/admin/api/api-configs/:id` | Editar chaves de API |
| `PATCH` | `/admin/api/api-configs/:id/toggle` | Ativar/desativar integração |
| `GET` | `/admin/api/users` | Lista usuários |
| `PATCH` | `/admin/api/users/:id/status` | Bloquear/desbloquear usuário |
| `DELETE` | `/admin/api/users/:id` | Remover usuário |
| `GET` | `/admin/api/price-history/:productId` | Histórico de preços |
| `GET` | `/admin/api/queue` | Fila de atualização de preços |
| `GET` | `/admin/api/clicks` | Análise de cliques por dia/loja/produto |

### Páginas SSR

| Rota | Descrição |
|------|-----------|
| `/` | Homepage com hero, busca, destaques, categorias |
| `/produto/:slug` | Página de produto com comparação de preços |
| `/categoria/:slug` | Listagem por categoria |
| `/go/:slug/:offerId` | Redirect com rastreamento de clique |

---

## Schema do Banco (D1)

### Tabelas principais

| Tabela | Propósito |
|--------|-----------|
| `products` | Produto normalizado (EAN único, best_price denormalizado) |
| `offers` | Ofertas por loja (UNIQUE: product_id+store_id+external_id) |
| `stores` | 8 lojas com checkout_pattern e affiliate_id |
| `url_patterns` | Padrões de URL por loja (configurável via admin) |
| `categories` | Categorias com ícone e contagem |
| `price_update_queue` | Fila de atualização (priority 1-10) |
| `click_events` | Cliques com ip_hash (SHA-256) para privacidade |
| `api_configs` | Configurações de APIs/redes de afiliados |
| `users` | Clientes/membros com wishlist e alertas |
| `admin_sessions` | Tokens de sessão admin (Bearer, 8h TTL) |
| `price_history` | Histórico para gráficos de evolução |
| `price_alerts` | Alertas de preço (target_price) |

### Query top-deals (GROUP BY MIN price)

```sql
SELECT p.id, p.name, MIN(o.price) AS lowest_price, ...
FROM products p
JOIN offers o  ON o.product_id = p.id AND o.is_active = 1 AND o.in_stock = 1
JOIN offers o2 ON o2.product_id = p.id
  AND o2.price = (SELECT MIN(o3.price) FROM offers o3
                  WHERE o3.product_id = p.id AND o3.is_active = 1 AND o3.in_stock = 1)
JOIN stores s  ON s.id = o2.store_id AND s.is_active = 1
WHERE p.is_active = 1
GROUP BY p.id
ORDER BY lowest_price ASC
```

---

## Matching de Produtos

Cascade de 3 níveis:
1. **EAN/GTIN** — 100% confiança (barcode idêntico)
2. **SKU** — 95% confiança (ID externo da loja)
3. **Jaro-Winkler + Jaccard** — threshold 0.72 (nome normalizado sem stopwords)

`normalizeName()` remove: acentos, pontuação, stopwords de cor/condição ("preto", "lacrado", "original", etc.)

---

## Cache KV (TTL)

| Tipo | TTL | Chave |
|------|-----|-------|
| Preços | 1h | `price:{offerId}` |
| Produtos | 30min | `product:{slug}` |
| Busca | 5min | `search:{hash}` |
| Categorias | 1h | `category:{slug}` |
| Ofertas | 15min | `offers:{productId}` |

---

## Deeplinks de Checkout

| Loja | Padrão |
|------|--------|
| Amazon | `Cart:Create` — `?ASIN.1={ID}&Quantity.1=1` |
| Mercado Livre | `/checkout/buy?item_id={ID}&quantity=1` |
| Magalu | `/carrinho/adicionar/{ID}/` |
| Americanas/Sub | `/produto/{ID}/add-to-cart` |
| Casas Bahia | `/produto/{ID}/add-to-cart` |
| Shopee | `/product/{SHOP_ID}/{ID}` |
| AliExpress | `/item/{ID}.html` |

---

## Infraestrutura Cloudflare

| Recurso | ID | Nome |
|---------|----|------|
| **Pages Project** | `9d34ae23-...` | `shopping-compare` |
| **D1 Database** | `271288fa-fb7b-45c9-a801-e25b8973e635` | `webapp-production` |
| **KV Namespace** | `81f0b165fc0c4669a1d45c9c267de55e` | `CACHE` |

---

## Setup Local

```bash
# Instalar dependências
npm install

# Aplicar migrations locais
npm run db:migrate:local

# Seeds de teste
npm run db:seed

# Iniciar servidor local
npm run build
pm2 start ecosystem.config.cjs

# Testar
curl http://localhost:3000/api/products
```

## Deploy para Produção

```bash
# Build
npm run build

# Aplicar migrations na D1 remota
npx wrangler d1 execute webapp-production --remote --file=migrations/XXXX.sql

# Deploy
npx wrangler pages deploy dist --project-name shopping-compare --commit-dirty=true

# Configurar secrets (quando tiver as chaves)
npx wrangler pages secret put AMAZON_ACCESS_KEY --project-name shopping-compare
npx wrangler pages secret put AMAZON_SECRET_KEY --project-name shopping-compare
npx wrangler pages secret put AMAZON_PARTNER_TAG --project-name shopping-compare
npx wrangler pages secret put MELI_ACCESS_TOKEN --project-name shopping-compare
npx wrangler pages secret put LOMADEE_SOURCE_ID --project-name shopping-compare
npx wrangler pages secret put AWIN_PUBLISHER_ID --project-name shopping-compare
```

---

## Estado do Banco (Produção)

| Métrica | Valor |
|---------|-------|
| **Produtos ativos** | 263 (264 − 1 inválido `Produto MLB6130836212` auto-deletado pelo enrich) |
| **Offers** | 263 (todas com `price > 0` e `image_url`) |
| **Home** | 16 produtos aleatórios por carga (`ORDER BY RANDOM()`) |
| **Enriquecer** | 0 restantes (correto — todas as offers já estão completas) |
| **Top Deals** | Query rápida via `best_price` denormalizado (O(N), sem correlated subquery) |

---

## Features Implementadas ✅

- [x] Homepage com hero, busca, sugestões autocomplete, destaques, categorias
- [x] Página de produto com tabela de comparação de preços por loja
- [x] Deeplinks de checkout direto (Amazon Cart:Create, ML, Magalu, Americanas)
- [x] EAN/SKU/Jaro-Winkler matching para deduplicação de produtos
- [x] Motor de ingestão em lote (XML/CSV feeds)
- [x] Fila de atualização de preços com prioridade
- [x] Cache KV com TTL diferenciado por tipo de dado
- [x] Rastreamento de cliques com ip_hash (privacidade LGPD)
- [x] Admin Panel SPA completo (vanilla JS, sem framework)
- [x] Dashboard com métricas reais do banco
- [x] Gestão de lojas (toggle ativo/inativo, métricas)
- [x] Gestão de APIs/integrações (chaves, status, última sync)
- [x] Gestão de usuários (bloquear/desbloquear/deletar)
- [x] Visualizador da fila de atualização de preços
- [x] Análise de cliques por dia/loja (Chart.js)
- [x] Top-deals com `GROUP BY p.id + MIN(o.price)` correlated subquery
- [x] Auth admin: Bearer token + sessão em DB + fallback ADMIN_SECRET
- [x] Deploy Cloudflare Pages com D1 + KV bindings reais
- [x] **Importação em massa** via aba "Em Massa" → `/import-links` direto (chunks de 50)
- [x] **Home rotativa** com `ORDER BY RANDOM()` — 16 produtos diferentes a cada refresh
- [x] **`/api/sync-products-from-offers`** — sincroniza `price`/`image_url`/`name` das offers para `products`
- [x] **`/api/fix-names`** — remove produtos com nome inválido (`cfegdhabc%`, `Produto MLB%`, `Produto Import%`)
- [x] **`parseLine`** aceita hint `mlb:` em qualquer campo (não apenas posição fixa)
- [x] **Top Deals query** — reescrita usando `best_price` denormalizado (O(N) vs O(N²) com correlated subquery)
- [x] **Enrich auto-deleta** produtos com nome inválido (`Produto MLB*`, `cfegdhabc*`) se não conseguir enriquecer

---

## Fixes do Ciclo 2026-05-15

| Bug | Causa | Fix |
|-----|-------|-----|
| Aba "Em Massa": 0 salvos | Pipeline `feed/ingest→process` não suporta links `/social/` | `siMassImport` reescrita usando `/import-links` direto |
| 26 erros na importação | `parseLine` esperava `mlb:` em `parts[4]` fixo | `parseLine` varre todos os campos com `for` |
| Home não atualizava | D1 binding não configurado no Cloudflare Pages | PATCH API Cloudflare + redeploy |
| Home excluía importados | `WHERE best_price IS NOT NULL` em 11 lugares | Removido de `index.tsx` (2x) e `pages.ts` (9x via `sed`) |
| Home mostrava sempre os mesmos 8 | `ORDER BY created_at` — todos importados no mesmo segundo | `ORDER BY RANDOM()` + `image_url IS NOT NULL` |
| 4 produtos sem offer (IDs 890-894) | Bug anterior no `parseLine` criou produto sem offer | Desativados via `PATCH is_active=0` |
| `products.image_url` NULL | Enrich salvou nas offers mas não propagou para `products` | Novo endpoint `/api/sync-products-from-offers` |
| **Top Deals travando ("só carregando")** | **Correlated subquery `SELECT MIN(o3.price)` por linha — O(N²) no D1** | **Reescrita usando `p.best_price` denormalizado — 1 JOIN simples** |
| **Enrich em loop: "Produto MLB6130836212"** | **Produto com nome inválido (`Produto MLB%`) — parseLine não resolveu** | **Enrich auto-deleta nomes inválidos + fix-names expandido** |
| **Duplicado rejeitado ("Produto com mesmo nome")** | **import-links rejeitava ao invés de atualizar offer existente** | **Bloco reescrito para UPDATE offer com novos dados (preço, imagem, affiliateUrl)** |
| **Em Massa 39→20 (19 perdidos)** | **Social links com `hint_mlb_id` caíam no Caso B e eram descartados silenciosamente** | **Caso B exige `!hint_mlb_id`; social links isolados viram Caso A** |
| **Card da loja mostra contador desatualizado após import** | **`renderStores()` não é chamado após o modal de import fechar — UI fica stale** | **`_refreshStoreCard(storeId)` busca dados frescos via API e atualiza apenas o card afetado** |

---

## Roadmap 🔜

- [ ] Gamification (Kainow Coins: login diário, compartilhar, resgatar)
- [ ] Gráficos de histórico de preços (Chart.js na página do produto)
- [ ] Anti-fraude Black Friday (detecção de inflação artificial de preço)
- [ ] Alertas de preço por email/push (price_alerts table pronta)
- [ ] Comunidade: grupos Telegram/WhatsApp de ofertas
- [ ] Browser extension (auto-fill checkout)
- [ ] Guest checkout / proxy checkout (Stripe + automação)
- [ ] Ads nativos + AdSense + brand insights

---

## Tech Stack

- **Backend:** Hono 4.x (TypeScript, edge-first)
- **Deploy:** Cloudflare Pages + Workers
- **DB:** Cloudflare D1 (SQLite distribuído)
- **Cache:** Cloudflare KV
- **Frontend:** Vanilla JS + Tailwind CSS (CDN) + Chart.js
- **Build:** Vite + @hono/vite-cloudflare-pages
- **Dev:** Wrangler 4.x + PM2

**Última atualização:** 2026-05-15
