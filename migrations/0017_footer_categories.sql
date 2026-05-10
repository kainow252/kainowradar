-- Migration 0017: Seeds de categorias no footer_config
-- Adiciona seção 'categories' para exibição no rodapé do site

INSERT OR IGNORE INTO footer_config (section, key, value, is_visible, sort_order) VALUES
  ('categories', 'Smartphones',      '/categoria/smartphones',        1, 1),
  ('categories', 'Notebooks',         '/categoria/notebooks',          1, 2),
  ('categories', 'TVs & Smart TVs',   '/categoria/tvs-smart-tvs',      1, 3),
  ('categories', 'Games & Consoles',  '/categoria/games-consoles',     1, 4),
  ('categories', 'Eletrodomésticos',  '/categoria/eletrodomesticos',   1, 5),
  ('categories', 'Áudio & Fones',     '/categoria/audio-fones',        1, 6),
  ('categories', 'Câmeras & Drones',  '/categoria/cameras-drones',     1, 7),
  ('categories', 'Tablets & iPads',   '/categoria/tablets-ipads',      1, 8),
  ('categories', 'Moda & Calçados',   '/categoria/moda-calcados',      1, 9);
