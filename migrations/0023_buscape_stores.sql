-- Migration 0023: Integração Buscapé
-- 1. Lojas que aparecem no Buscapé mas ainda não existem no banco
-- 2. Coluna buscape_oid na tabela offers (OID do redirect do Buscapé)
-- 3. Coluna source na tabela offers (origem: 'ml', 'buscape', 'manual')

-- ── Novas lojas Buscapé ───────────────────────────────────────────────────────
-- Nota: 'ponto' é o mesmo grupo que casasbahia (Via Varejo / Grupo Casas Bahia)
-- 'extra' também é do mesmo grupo — todos usam rede Awin
INSERT OR IGNORE INTO stores (slug, name, logo_url, affiliate_network, checkout_pattern, deeplink_base, commission_rate, is_active) VALUES
  ('ponto',    'Ponto',     'https://logo.clearbit.com/ponto.com.br',    'awin', 'https://www.ponto.com.br/produto/{ID}',    'https://www.ponto.com.br/produto/{ID}',    4.0, 1),
  ('extra',    'Extra',     'https://logo.clearbit.com/extra.com.br',    'awin', 'https://www.extra.com.br/produto/{ID}',    'https://www.extra.com.br/produto/{ID}',    4.0, 1),
  ('fastshop', 'Fast Shop', 'https://logo.clearbit.com/fastshop.com.br', 'awin', 'https://www.fastshop.com.br/web/c/p/produto/{ID}', 'https://www.fastshop.com.br/web/c/p/produto/{ID}', 4.0, 1);

-- ── Coluna buscape_oid em offers ──────────────────────────────────────────────
-- OID = identificador único da oferta no Buscapé, usado para montar o link redirect:
-- https://www.buscape.com.br/lead?oid=OID&channel=11
-- Permite rastrear cliques e validar se o link ainda está ativo
ALTER TABLE offers ADD COLUMN buscape_oid TEXT;

-- ── Coluna source em offers ───────────────────────────────────────────────────
-- 'ml'      = importado via GeckoAPI / Mercado Livre
-- 'buscape' = importado via scraping do Buscapé
-- 'manual'  = inserido manualmente pelo admin
ALTER TABLE offers ADD COLUMN source TEXT DEFAULT 'ml';

-- ── Coluna buscape_oid em products ────────────────────────────────────────────
-- Salva o productID do Buscapé para facilitar re-importação / atualização diária
ALTER TABLE products ADD COLUMN buscape_product_id TEXT;
ALTER TABLE products ADD COLUMN buscape_url TEXT;

-- ── Índice para busca por buscape_oid ─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_offers_buscape_oid ON offers(buscape_oid);
CREATE INDEX IF NOT EXISTS idx_products_buscape_product_id ON products(buscape_product_id);
