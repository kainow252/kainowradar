-- Migration 0012: Seed das 6 novas redes de afiliados
-- Plataformas de Parceria: LTK, Impact.com
-- Live Commerce: Twitch
-- Discovery Commerce: Pinterest
-- E-commerce Builder: WooCommerce, Shopify Multi-vendor

INSERT OR IGNORE INTO api_configs (id, name, network, commission_rate, is_active, created_at, updated_at)
VALUES
  ('ltk',           'LTK (LikeToKnow.it)',    'ltk-api',           8.0,  0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('impact',        'Impact.com',             'impact-api',        5.0,  0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('twitch',        'Twitch + Amazon Assoc.', 'twitch-api',        5.0,  0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('pinterest',     'Pinterest Shopping API', 'pinterest-api',     4.0,  0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('woocommerce',   'WooCommerce Affiliates', 'woocommerce-api',   15.0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('shopify-store', 'Shopify Multi-vendor',   'shopify-store-api', 15.0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
