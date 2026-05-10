-- Migration 0009: Adiciona coluna logo_url na tabela api_configs
-- e corrige os registros existentes para ter os networks corretos

ALTER TABLE api_configs ADD COLUMN logo_url TEXT;

-- Corrige networks que estavam com valores antigos
UPDATE api_configs SET network = 'magalu-api'       WHERE id = 'magalu'     AND network != 'magalu-api';
UPDATE api_configs SET network = 'shopee-api'        WHERE id = 'shopee'     AND network != 'shopee-api';
UPDATE api_configs SET network = 'lomadee'           WHERE id = 'socialsoul' AND network != 'lomadee';

-- Insere todas as 18 redes que ainda não existem no banco
INSERT OR IGNORE INTO api_configs (id, name, network, commission_rate, is_active, created_at, updated_at) VALUES
  ('amazon',       'Amazon Associados',       'amazon-pa-api',      5.0,  0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('mercadolivre', 'Mercado Livre Afiliados', 'meli-api',           8.0,  0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('magalu',       'Magalu Parceiro',         'magalu-api',         7.0,  0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('shopee',       'Shopee Afiliados',        'shopee-api',         6.0,  0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('shein',        'Shein Afiliados',         'shein-api',          15.0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('aliexpress',   'AliExpress Portals',      'aliexpress-portals', 6.0,  0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('dafiti',       'Dafiti Afiliados',        'dafiti-api',         7.0,  0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('hotmart',      'Hotmart',                 'hotmart-api',        40.0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('eduzz',        'Eduzz',                   'eduzz-api',          40.0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('monetizze',    'Monetizze',               'monetizze-api',      35.0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('braip',        'Braip',                   'braip-api',          30.0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('socialsoul',   'SocialSoul / Lomadee',    'lomadee',            8.0,  0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('awin',         'Awin',                    'awin',               5.0,  0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('rakuten',      'Rakuten Advertising',     'rakuten',            5.0,  0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('hostinger',    'Hostinger',               'hostinger-api',      50.0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('shopify',      'Shopify Partners',        'shopify-partners',   20.0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('nuvemshop',    'Nuvemshop / Tiendanube',  'nuvemshop-api',      25.0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('nestle',       'Nestlé',                  'nestle-api',         3.0,  0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Remove duplicata lomadee se existir (registro legado sem vínculo com o array)
DELETE FROM api_configs WHERE id = 'lomadee' AND name = 'Lomadee';
