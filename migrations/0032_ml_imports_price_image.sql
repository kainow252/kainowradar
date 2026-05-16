-- ============================================================
-- Migration 0032: Adiciona product_price e product_image
--   na tabela ml_affiliate_imports
-- Permite salvar nome, preço e imagem obtidos via API ML
-- ao importar links meli.la/xxx
-- ============================================================

ALTER TABLE ml_affiliate_imports ADD COLUMN product_price REAL;
ALTER TABLE ml_affiliate_imports ADD COLUMN product_image TEXT;
