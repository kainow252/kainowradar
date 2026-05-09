-- ============================================================
-- SEED 0005: Dados iniciais das configurações de API
-- ============================================================

INSERT OR IGNORE INTO api_configs (id, name, network, endpoint_url, feed_url, feed_type, rate_limit_per_min, commission_rate, is_active) VALUES
('amazon',       'Amazon',           'amazon-pa-api', 'https://webservices.amazon.com.br/paapi5/searchitems', NULL, 'api', 10, 8.0, 0),
('mercadolivre', 'Mercado Livre',    'meli-api',      'https://api.mercadolibre.com/sites/MLB/search',        NULL, 'api', 30, 3.0, 0),
('lomadee',      'Lomadee',          'lomadee',       'https://api.lomadee.com/v3/{source_id}/offer/_search', 'https://api.lomadee.com/v3/{source_id}/offer/download', 'api', 20, 5.0, 0),
('awin',         'Awin',             'awin',          'https://api.awin.com/publishers/{id}/productfeeds',    NULL, 'api', 15, 4.5, 0),
('shopee',       'Shopee Afiliados', 'shopee',        'https://open-api.affiliate.shopee.com.br/graphql',     NULL, 'api', 20, 6.0, 0),
('magalu',       'Magazine Luiza',   'lomadee',       'https://api.lomadee.com/v3/{source_id}/offer/_search', NULL, 'api', 10, 5.0, 0);
