-- ============================================================
-- SEED: Produtos de demonstração com ofertas realistas
-- ============================================================

-- Produtos de exemplo
INSERT OR IGNORE INTO products (ean, name, slug, brand, category, subcategory, description, image_url, specs, best_price, offer_count) VALUES
('0194253413868', 'Apple iPhone 15 128GB', 'apple-iphone-15-128gb', 'Apple', 'smartphones', 'ios',
 'O iPhone 15 traz a Dynamic Island, câmera principal de 48 MP com zoom 2x e chip A16 Bionic.',
 'https://images.unsplash.com/photo-1695048133142-1a20484d2569?w=400',
 '{"tela":"6.1 polegadas Super Retina XDR","processador":"A16 Bionic","ram":"6GB","armazenamento":"128GB","camera_principal":"48 MP","bateria":"3279 mAh","sistema":"iOS 17","5g":true}',
 3899.00, 4),

('0195949370472', 'Samsung Galaxy S24 256GB', 'samsung-galaxy-s24-256gb', 'Samsung', 'smartphones', 'android',
 'Galaxy S24 com Galaxy AI integrado, câmera de 50MP e processador Snapdragon 8 Gen 3.',
 'https://images.unsplash.com/photo-1706527862994-e2dfc75cff95?w=400',
 '{"tela":"6.2 polegadas Dynamic AMOLED","processador":"Snapdragon 8 Gen 3","ram":"8GB","armazenamento":"256GB","camera_principal":"50 MP","bateria":"4000 mAh","sistema":"Android 14","5g":true}',
 3299.00, 3),

('0196548956543', 'Samsung Smart TV 55" 4K QLED', 'samsung-smart-tv-55-4k-qled', 'Samsung', 'tv', 'qled',
 'TV QLED 55 polegadas com Quantum HDR, processador Crystal 4K e Tizen OS.',
 'https://images.unsplash.com/photo-1593359677879-a4bb92f829e1?w=400',
 '{"tela":"55 polegadas QLED","resolucao":"4K UHD 3840x2160","hdr":"Quantum HDR 12x","processador":"Crystal 4K","sistema":"Tizen","hdmi":4,"usb":2}',
 2799.00, 5),

('7891234567890', 'Notebook Dell Inspiron 15 i5 16GB 512GB SSD', 'notebook-dell-inspiron-15-i5', 'Dell', 'notebooks', 'windows',
 'Notebook Dell com Intel Core i5 12ª geração, 16GB RAM e SSD de 512GB.',
 'https://images.unsplash.com/photo-1588702547919-26089e690ecc?w=400',
 '{"tela":"15.6 Full HD","processador":"Intel Core i5-1235U","ram":"16GB DDR4","armazenamento":"512GB SSD NVMe","gpu":"Intel Iris Xe","bateria":"54 Whr","sistema":"Windows 11"}',
 3199.00, 4),

('0193575186084', 'Apple AirPods Pro 2ª Geração', 'apple-airpods-pro-2-geracao', 'Apple', 'audio', 'fones-sem-fio',
 'AirPods Pro com cancelamento ativo de ruído, modo Transparência e chip H2.',
 'https://images.unsplash.com/photo-1600294037681-c80b4cb5b434?w=400',
 '{"tipo":"In-ear true wireless","anc":true,"bateria_fone":"6h","bateria_case":"30h","chip":"H2","resistencia":"IPX4","audio_espacial":true}',
 1799.00, 3),

('0195949036548', 'PlayStation 5 Slim', 'playstation-5-slim', 'Sony', 'games', 'consoles',
 'PS5 Slim com leitor de disco, SSD de 1TB, suporte a 4K 120fps e DualSense.',
 'https://images.unsplash.com/photo-1607853202273-797f1c22a38e?w=400',
 '{"cpu":"AMD Zen 2 3.5GHz","gpu":"AMD RDNA 2 10.3 TFLOPS","ram":"16GB GDDR6","armazenamento":"1TB SSD","resolucao":"4K 120fps","audio":"3D","leitor_disco":true}',
 3699.00, 4),

('7890000123456', 'Geladeira Samsung 453L Frost Free Inox', 'geladeira-samsung-453l-frost-free', 'Samsung', 'eletrodomesticos', 'refrigeradores',
 'Geladeira Samsung 453 litros com All Around Cooling, Digital Inverter e acabamento inox.',
 'https://images.unsplash.com/photo-1571175443880-49e1d25b2bc5?w=400',
 '{"capacidade":"453 litros","frost_free":true,"inverter":true,"cor":"Inox","altura":"178cm","classe_energetica":"A"}',
 3499.00, 3);

-- Ofertas da Amazon
INSERT OR IGNORE INTO offers (product_id, store_id, external_id, title, price, original_price, discount_percent, free_shipping, in_stock, product_url, checkout_url, condition) VALUES
(1, 1, 'B0CHX2LQBS', 'Apple iPhone 15 (128 GB) - Preto', 3899.00, 4499.00, 13.3, 1, 1,
 'https://www.amazon.com.br/dp/B0CHX2LQBS', 'https://www.amazon.com.br/gp/aws/cart/add.html?ASIN.1=B0CHX2LQBS&Quantity.1=1', 'new'),
(2, 1, 'B0CMDTFLJM', 'Samsung Galaxy S24 256GB Cinza Onyx', 3299.00, 3799.00, 13.2, 1, 1,
 'https://www.amazon.com.br/dp/B0CMDTFLJM', 'https://www.amazon.com.br/gp/aws/cart/add.html?ASIN.1=B0CMDTFLJM&Quantity.1=1', 'new'),
(3, 1, 'B0CN7VBV1D', 'Samsung Smart TV 55" QLED 4K Q60C', 2799.00, 3499.00, 20.0, 1, 1,
 'https://www.amazon.com.br/dp/B0CN7VBV1D', 'https://www.amazon.com.br/gp/aws/cart/add.html?ASIN.1=B0CN7VBV1D&Quantity.1=1', 'new'),
(5, 1, 'B0BDHB9Y8H', 'Apple AirPods Pro (2ª geração) com USB-C', 1799.00, 2199.00, 18.2, 1, 1,
 'https://www.amazon.com.br/dp/B0BDHB9Y8H', 'https://www.amazon.com.br/gp/aws/cart/add.html?ASIN.1=B0BDHB9Y8H&Quantity.1=1', 'new'),
(6, 1, 'B0CXHRS4FJ', 'PlayStation 5 Slim com leitor de disco', 3699.00, 3999.00, 7.5, 1, 1,
 'https://www.amazon.com.br/dp/B0CXHRS4FJ', 'https://www.amazon.com.br/gp/aws/cart/add.html?ASIN.1=B0CXHRS4FJ&Quantity.1=1', 'new');

-- Ofertas do Magalu
INSERT OR IGNORE INTO offers (product_id, store_id, external_id, title, price, original_price, discount_percent, free_shipping, in_stock, product_url, checkout_url, condition) VALUES
(1, 2, '238901700', 'Apple iPhone 15 128GB Preto', 3959.10, 4499.00, 12.0, 1, 1,
 'https://www.magazineluiza.com.br/produto/238901700', 'https://www.magazineluiza.com.br/carrinho/adicionar/238901700/', 'new'),
(2, 2, '239845600', 'Samsung Galaxy S24 256GB Onyx Black', 3389.10, 3799.00, 10.8, 1, 1,
 'https://www.magazineluiza.com.br/produto/239845600', 'https://www.magazineluiza.com.br/carrinho/adicionar/239845600/', 'new'),
(4, 2, '240123400', 'Notebook Dell Inspiron 15 i5 16GB 512SSD', 3249.00, 3799.00, 14.5, 1, 1,
 'https://www.magazineluiza.com.br/produto/240123400', 'https://www.magazineluiza.com.br/carrinho/adicionar/240123400/', 'new'),
(7, 2, '241567800', 'Geladeira Samsung 453L Frost Free Inox', 3449.10, 3999.00, 13.8, 1, 1,
 'https://www.magazineluiza.com.br/produto/241567800', 'https://www.magazineluiza.com.br/carrinho/adicionar/241567800/', 'new');

-- Ofertas do Mercado Livre
INSERT OR IGNORE INTO offers (product_id, store_id, external_id, title, price, original_price, discount_percent, free_shipping, in_stock, product_url, checkout_url, seller_name, condition) VALUES
(1, 3, 'MLB3456789012', 'iPhone 15 128gb Preto Apple Original NF', 3849.00, 4299.00, 10.5, 1, 1,
 'https://produto.mercadolivre.com.br/MLB-3456789012', 'https://www.mercadolivre.com.br/checkout/buy?item_id=MLB3456789012&quantity=1', 'Apple Store Oficial', 'new'),
(2, 3, 'MLB3567890123', 'Samsung Galaxy S24 256gb Lacrado Garantia', 3199.00, 3699.00, 13.5, 1, 1,
 'https://produto.mercadolivre.com.br/MLB-3567890123', 'https://www.mercadolivre.com.br/checkout/buy?item_id=MLB3567890123&quantity=1', 'Samsung Store Oficial', 'new'),
(3, 3, 'MLB4123456789', 'Smart TV Samsung 55 QLED 4K Q60C 2023', 2699.00, 3299.00, 18.2, 1, 1,
 'https://produto.mercadolivre.com.br/MLB-4123456789', 'https://www.mercadolivre.com.br/checkout/buy?item_id=MLB4123456789&quantity=1', 'Samsung Store Oficial', 'new'),
(6, 3, 'MLB5234567890', 'Console PlayStation 5 Slim 1TB Japão Lacrado', 3649.00, 3999.00, 8.8, 0, 1,
 'https://produto.mercadolivre.com.br/MLB-5234567890', 'https://www.mercadolivre.com.br/checkout/buy?item_id=MLB5234567890&quantity=1', 'Games Import', 'new');

-- Ofertas Americanas
INSERT OR IGNORE INTO offers (product_id, store_id, external_id, title, price, original_price, discount_percent, free_shipping, in_stock, product_url, checkout_url, condition) VALUES
(3, 5, '2345678901', 'Samsung Smart TV QLED 4K 55" QN55Q60CA', 2749.00, 3499.00, 21.4, 1, 1,
 'https://www.americanas.com.br/produto/2345678901', 'https://www.americanas.com.br/produto/2345678901/add-to-cart', 'new'),
(4, 5, '3456789012', 'Notebook Dell Inspiron Core i5 16GB 512SSD Win11', 3099.00, 3699.00, 16.2, 1, 1,
 'https://www.americanas.com.br/produto/3456789012', 'https://www.americanas.com.br/produto/3456789012/add-to-cart', 'new'),
(7, 5, '4567890123', 'Refrigerador Samsung 453L Frost Free Digital Inox', 3399.00, 3899.00, 12.8, 1, 1,
 'https://www.americanas.com.br/produto/4567890123', 'https://www.americanas.com.br/produto/4567890123/add-to-cart', 'new');

-- Atualizar best_price e offer_count dos produtos
UPDATE products SET 
  best_price = (SELECT MIN(price) FROM offers WHERE product_id = products.id AND is_active = 1),
  best_store_id = (SELECT store_id FROM offers WHERE product_id = products.id AND is_active = 1 ORDER BY price ASC LIMIT 1),
  offer_count = (SELECT COUNT(*) FROM offers WHERE product_id = products.id AND is_active = 1)
WHERE id IN (SELECT DISTINCT product_id FROM offers);

-- Atualizar contagem de produtos nas categorias
UPDATE categories SET product_count = (
  SELECT COUNT(*) FROM products WHERE category = categories.slug AND is_active = 1
);
