-- ============================================================
-- SEED: Lojas parceiras com padrões de deeplink
-- ============================================================

INSERT OR IGNORE INTO stores (slug, name, logo_url, affiliate_network, checkout_pattern, deeplink_base, commission_rate) VALUES
('amazon', 'Amazon', 'https://upload.wikimedia.org/wikipedia/commons/a/a9/Amazon_logo.svg', 'amazon-pa-api', 'https://www.amazon.com.br/gp/aws/cart/add.html?ASIN.1={ID}&Quantity.1=1', 'https://www.amazon.com.br/dp/{ID}', 8.0),
('magalu', 'Magazine Luiza', 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/59/Magazine_Luiza_logo.svg/320px-Magazine_Luiza_logo.svg.png', 'lomadee', 'https://www.magazineluiza.com.br/carrinho/adicionar/{ID}/', 'https://www.magazineluiza.com.br/produto/{ID}/', 5.0),
('mercadolivre', 'Mercado Livre', 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2a/Mercado_Libre_logo.svg/320px-Mercado_Libre_logo.svg.png', 'meli-api', 'https://www.mercadolivre.com.br/checkout/buy?item_id={ID}&quantity=1', 'https://produto.mercadolivre.com.br/{ID}', 3.0),
('shopee', 'Shopee', 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fe/Shopee.svg/320px-Shopee.svg.png', 'lomadee', 'https://shopee.com.br/product/{ID}', 'https://shopee.com.br/product/{ID}', 6.0),
('americanas', 'Americanas', 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b7/Americanas_logo.svg/320px-Americanas_logo.svg.png', 'awin', 'https://www.americanas.com.br/produto/{ID}', 'https://www.americanas.com.br/produto/{ID}', 4.5),
('casasbahia', 'Casas Bahia', 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/72/CasasBahia_logo.svg/320px-CasasBahia_logo.svg.png', 'awin', 'https://www.casasbahia.com.br/produto/{ID}/carrinho', 'https://www.casasbahia.com.br/produto/{ID}', 4.0),
('submarino', 'Submarino', NULL, 'awin', 'https://www.submarino.com.br/produto/{ID}', 'https://www.submarino.com.br/produto/{ID}', 4.5),
('aliexpress', 'AliExpress', 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/76/Aliexpress_logo.svg/320px-Aliexpress_logo.svg.png', 'awin', 'https://www.aliexpress.com/item/{ID}.html', 'https://www.aliexpress.com/item/{ID}.html', 7.0);

-- Padrões de URL por loja
INSERT OR IGNORE INTO url_patterns (store_id, pattern_type, url_template, notes) VALUES
(1, 'cart', 'https://www.amazon.com.br/gp/aws/cart/add.html?ASIN.1={ID}&Quantity.1=1', 'Cart:Create via PA-API — cookie 90 dias'),
(1, 'product', 'https://www.amazon.com.br/dp/{ID}?tag={AFFILIATE_ID}', 'Página de produto com tag de afiliado'),
(2, 'cart', 'https://www.magazineluiza.com.br/carrinho/adicionar/{ID}/', 'Adiciona direto ao carrinho Magalu'),
(2, 'deeplink', 'https://lomadee.com/deeplink/{AFFILIATE_ID}?url=https://www.magazineluiza.com.br/produto/{ID}/', 'Deeplink via Lomadee'),
(3, 'checkout', 'https://www.mercadolivre.com.br/checkout/buy?item_id={ID}&quantity=1', 'Checkout direto ML'),
(3, 'product', 'https://produto.mercadolivre.com.br/{ID}', 'Página produto ML'),
(4, 'product', 'https://shopee.com.br/product/{SELLER_ID}/{ID}', 'Produto Shopee'),
(5, 'cart', 'https://www.americanas.com.br/produto/{ID}/add-to-cart', 'Carrinho Americanas via Awin'),
(6, 'cart', 'https://www.casasbahia.com.br/produto/{ID}/carrinho', 'Carrinho Casas Bahia via Awin');

-- Categorias principais
INSERT OR IGNORE INTO categories (slug, name, icon, sort_order) VALUES
('smartphones', 'Smartphones', '📱', 1),
('notebooks', 'Notebooks', '💻', 2),
('tv', 'TVs & Monitores', '📺', 3),
('eletrodomesticos', 'Eletrodomésticos', '🏠', 4),
('games', 'Games', '🎮', 5),
('audio', 'Áudio & Fones', '🎧', 6),
('cameras', 'Câmeras', '📷', 7),
('moda', 'Moda & Beleza', '👗', 8);
