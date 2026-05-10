-- Migration 0011: Seed das 5 redes de Social Commerce em api_configs
-- TikTok Shop, Kwai Shop, Instagram Shopping, YouTube Shopping, Facebook Shops

INSERT OR IGNORE INTO api_configs (id, name, network, commission_rate, is_active, created_at, updated_at)
VALUES
  ('tiktok-shop',    'TikTok Shop Afiliados', 'tiktok-shop',    10.0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('kwai-shop',      'Kwai Shop Afiliados',   'kwai-shop',       8.0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('instagram-shop', 'Instagram Shopping',    'instagram-shop',  5.0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('youtube-shop',   'YouTube Shopping',      'youtube-shop',    5.0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('facebook-shop',  'Facebook Shops / Meta', 'facebook-shop',   5.0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
