-- ============================================================
-- MIGRATION: Adiciona coluna affiliate_url na tabela products
-- Para integração com Mercado Livre Afiliados
-- Publisher ID: cfegdhabc31955
-- ============================================================

ALTER TABLE products ADD COLUMN affiliate_url TEXT;
ALTER TABLE products ADD COLUMN ml_item_id TEXT;  -- ID do item no ML (ex: MLB123456789)
ALTER TABLE products ADD COLUMN affiliate_updated_at DATETIME;
