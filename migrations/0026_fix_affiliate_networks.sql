-- Migration 0026: Corrigir redes afiliadas e mapeamentos Awin
-- 
-- Problemas identificados:
--   1. Americanas, Submarino → affiliate_network='awin' mas NÃO existem na Awin BR
--   2. Centauro, KaBuM → affiliate_network='lomadee' mas têm awin_advertiser_id (existem na Awin BR)
--   3. MadeiraMadeira, Renner, Riachuelo → affiliate_network='lomadee' mas existem na Awin BR
--   4. Carrefour, Dafiti, Samsung, Tok&Stok → affiliate_network='awin' mas sem awin_advertiser_id mapeado
--
-- Fontes verificadas: tabela awin_programmes (sync de 246 programas)

-- ── 1. Lojas que existem na Awin BR: garantir affiliate_network='awin' + awin_advertiser_id correto ──

-- Centauro (estava lomadee, mas existe na Awin como id=17806)
UPDATE stores SET affiliate_network = 'awin', awin_advertiser_id = 17806 WHERE slug = 'centauro';

-- KaBuM (estava lomadee, mas existe na Awin como id=17729)
UPDATE stores SET affiliate_network = 'awin', awin_advertiser_id = 17729 WHERE slug = 'kabum';

-- MadeiraMadeira (estava lomadee, existe na Awin como id=17762)
UPDATE stores SET affiliate_network = 'awin', awin_advertiser_id = 17762 WHERE slug = 'madeiramadeira';

-- Renner (estava lomadee, existe na Awin como id=17801)
UPDATE stores SET affiliate_network = 'awin', awin_advertiser_id = 17801 WHERE slug = 'renner';

-- Riachuelo (estava lomadee, existe na Awin como id=86587)
UPDATE stores SET affiliate_network = 'awin', awin_advertiser_id = 86587 WHERE slug = 'riachuelo';

-- Carrefour (já era awin, faltava o ID = 17665)
UPDATE stores SET awin_advertiser_id = 17665 WHERE slug = 'carrefour';

-- Dafiti (já era awin, faltava o ID = 17697)
UPDATE stores SET awin_advertiser_id = 17697 WHERE slug = 'dafiti';

-- Samsung (já era awin, faltava o ID = 25539)
UPDATE stores SET awin_advertiser_id = 25539 WHERE slug = 'samsung';

-- Tok&Stok (já era awin, faltava o ID = 36382)
UPDATE stores SET awin_advertiser_id = 36382 WHERE slug = 'tok_stok';

-- ── 2. Lojas que NÃO existem na Awin BR: corrigir affiliate_network para 'direct' ──
-- (mantém product_url como link principal até outra rede ser configurada)

-- Americanas → não existe na Awin BR
UPDATE stores SET affiliate_network = 'direct', awin_advertiser_id = NULL WHERE slug = 'americanas';

-- Submarino → não existe na Awin BR (é do grupo B2W/Americanas, mesmo problema)
UPDATE stores SET affiliate_network = 'direct', awin_advertiser_id = NULL WHERE slug = 'submarino';

-- Netshoes → não existe na Awin BR
UPDATE stores SET affiliate_network = 'direct', awin_advertiser_id = NULL WHERE slug = 'netshoes';

-- Zattini → não existe na Awin BR (é do grupo Netshoes/Magazine Luiza)
UPDATE stores SET affiliate_network = 'direct', awin_advertiser_id = NULL WHERE slug = 'zattini';

-- ── 3. Lojas lomadee sem lomadee_org_id: manter lomadee mas deixar claro (sem alteração) ──
-- Magalu, Leroy Merlin, Shopee, Renner* já corrigida acima, Riachuelo* já corrigida
-- Nota: Magalu, Leroy, Shopee não têm programa na Awin BR nem lomadee_org_id configurado
--       → serão resolvidos quando o bot auto-sync trazer os dados

-- ── 4. Limpar offers de Americanas e Submarino que tinham affiliate_network='awin' incorreto ──
-- Reseta affiliate_url para NULL nestas lojas para evitar links quebrados
UPDATE offers SET affiliate_url = NULL
WHERE store_id IN (
  SELECT id FROM stores WHERE slug IN ('americanas', 'submarino', 'netshoes', 'zattini')
)
AND (affiliate_url IS NULL OR affiliate_url = '' OR affiliate_url NOT LIKE 'http%');
