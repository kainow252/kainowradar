#!/usr/bin/env python3
"""
shopee_fix_prices_playwright.py
-------------------------------
Usa Playwright (Chromium headless) para renderizar a página do produto Shopee
com JavaScript completo, extraindo o preço real do DOM.

Funciona do sandbox (IP EUA) porque o Playwright emula um browser completo
com fingerprint realista, contornando o geo-bloqueio baseado em User-Agent/headers
que afeta requests HTTP diretos.
"""

import json
import time
import re
import sys
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

# ── Offers com preço R$0,01 que precisam de correção ─────────────────────────
OFFERS = [
    {"id": 1142, "external_id": "23394276680", "external_sku": "1429781525",
     "affiliate_url": "https://s.shopee.com.br/6L1KILb3ZY",
     "title": "Kit 6/12/18/24 Panos De Limpeza Aço Premium"},
    {"id": 1143, "external_id": "19399549510", "external_sku": "1127030290",
     "affiliate_url": "https://s.shopee.com.br/W3XLqQ2d9",
     "title": "Máquina Nebulizadora Portátil Inalador"},
    {"id": 1144, "external_id": "23799391942", "external_sku": "330607227",
     "affiliate_url": "https://s.shopee.com.br/3g0Z7gdyrY",
     "title": "Body Splash Feminino Ameixa Negra 200ml"},
    {"id": 1145, "external_id": "27893329314", "external_sku": "1362613236",
     "affiliate_url": "https://s.shopee.com.br/3Vh8vOeDAv",
     "title": "Smartwatch Relógio Inteligente Tela Infinita"},
    {"id": 1146, "external_id": "23093068858", "external_sku": "535866882",
     "affiliate_url": "https://s.shopee.com.br/5L8n7GqfyK",
     "title": "Conjunto 5 Potes de Vidro Hermetico Bowl"},
    {"id": 1147, "external_id": "58210082441", "external_sku": "1004806694",
     "affiliate_url": "https://s.shopee.com.br/9UyM4wIoLq",
     "title": "Kit Figurinha Álbum Copa do Mundo 2026"},
    {"id": 1148, "external_id": "23293480319", "external_sku": "1284769631",
     "affiliate_url": "https://s.shopee.com.br/5q53iYF9Ux",
     "title": "Mini Compressor de Ar Portátil 4 em 1"},
    {"id": 1149, "external_id": "23598669907", "external_sku": "1478371070",
     "affiliate_url": "https://s.shopee.com.br/2BBlLp1gsc",
     "title": "Bolsa de maternidade multifuncional térmica"},
    {"id": 1150, "external_id": "58256443834", "external_sku": "1603111326",
     "affiliate_url": "https://s.shopee.com.br/7pq86FgKgH",
     "title": "Coberdron Queen Edredon Dupla Face Sherpa"},
    {"id": 1151, "external_id": "13590189810", "external_sku": "338251868",
     "affiliate_url": "https://s.shopee.com.br/7VDHheJxeU",
     "title": "Linha Mamãe e Bebê Natura"},
]


def extract_price_from_page(page) -> float | None:
    """Extrai preço do DOM da página Shopee após renderização JS."""
    
    # 1. Tenta via interceptação de API (o mais confiável)
    # (feito via interceptor de rede, não aqui)
    
    # 2. Tenta via seletores CSS do preço
    price_selectors = [
        # Seletor principal do preço na PDP
        "._3n5NQx",  # classe histórica do preço Shopee
        "._3HmxNH",  # variante
        ".pqTWkA",   # outro seletor comum
        "[data-testid='pdp-price']",
        ".product-price",
        # Texto que contém R$
        "//span[contains(@class,'price') and contains(text(),'R$')]",
    ]
    
    for selector in price_selectors:
        try:
            if selector.startswith("//"):
                elements = page.locator(f"xpath={selector}").all()
            else:
                elements = page.locator(selector).all()
            
            for el in elements[:3]:
                text = el.text_content() or ""
                price = parse_brl_price(text)
                if price and price > 0.01:
                    return price
        except Exception:
            continue
    
    # 3. Tenta via JavaScript - busca no texto da página
    try:
        price_text = page.evaluate("""
            () => {
                // Procura elementos com preço R$
                const walker = document.createTreeWalker(
                    document.body, NodeFilter.SHOW_TEXT, null, false
                );
                const prices = [];
                let node;
                while (node = walker.nextNode()) {
                    const text = node.textContent.trim();
                    if (text.match(/R\\$\\s*\\d+[.,]\\d{2}/) && text.length < 30) {
                        prices.push(text);
                    }
                }
                return prices.slice(0, 5).join('|');
            }
        """)
        
        if price_text:
            for part in price_text.split("|"):
                price = parse_brl_price(part)
                if price and price > 0.01:
                    return price
    except Exception:
        pass
    
    # 4. Tenta via window.__INITIAL_STATE__ ou similar
    try:
        js_price = page.evaluate("""
            () => {
                // Tenta extrair do estado do React/Redux
                const keys = ['__INITIAL_STATE__', '__initialState__', 'pageData', '__APP_DATA__'];
                for (const key of keys) {
                    if (window[key]) {
                        const str = JSON.stringify(window[key]);
                        const match = str.match(/"price":(\\d+)/);
                        if (match) return parseInt(match[1]) / 100000;
                        const match2 = str.match(/"price_min":(\\d+)/);
                        if (match2) return parseInt(match2[1]) / 100000;
                    }
                }
                return null;
            }
        """)
        if js_price and float(js_price) > 0.01:
            return round(float(js_price), 2)
    except Exception:
        pass
    
    return None


def parse_brl_price(text: str) -> float | None:
    """Converte 'R$ 29,90' ou 'R$29.90' para float."""
    if not text:
        return None
    # Remove caracteres não numéricos exceto vírgula e ponto
    cleaned = re.sub(r'[^\d.,]', '', text.replace('R$', '').strip())
    if not cleaned:
        return None
    try:
        # Formato BR: 1.234,56 → remove pontos de milhar, troca vírgula por ponto
        if ',' in cleaned:
            cleaned = cleaned.replace('.', '').replace(',', '.')
        return float(cleaned)
    except ValueError:
        return None


def fetch_product_data(page, offer: dict) -> dict:
    """
    Carrega a página do produto Shopee e extrai price, title, image.
    Intercepta chamadas à API para capturar price diretamente.
    """
    shop_id  = offer["external_sku"]
    item_id  = offer["external_id"]
    short_url = offer["affiliate_url"]
    
    captured_price = {"value": None}
    
    def handle_response(response):
        """Intercepta respostas da API do produto."""
        url = response.url
        if "get_pc" in url or "item/get" in url or "pdp/get" in url:
            try:
                if response.status == 200:
                    body = response.json()
                    data = body.get("data") or body.get("item") or {}
                    
                    price_info = data.get("price_info", [])
                    if price_info and isinstance(price_info, list):
                        raw = price_info[0].get("price")
                        if raw:
                            captured_price["value"] = round(raw / 100000, 2)
                    
                    if not captured_price["value"]:
                        raw = data.get("price") or data.get("price_min")
                        if raw and raw > 100:  # preços em centavos × 1000
                            captured_price["value"] = round(raw / 100000, 2)
            except Exception:
                pass
    
    page.on("response", handle_response)
    
    # Navega para o link curto (faz redirect para URL completa com shop+item)
    product_url = f"https://shopee.com.br/i.{shop_id}.{item_id}"
    
    try:
        page.goto(product_url, wait_until="domcontentloaded", timeout=30000)
        # Aguarda um pouco para o React renderizar
        page.wait_for_timeout(4000)
    except PlaywrightTimeout:
        print(f"  ⚠️  Timeout ao carregar {product_url}")
    except Exception as e:
        print(f"  ⚠️  Erro ao navegar: {e}")
    
    # Tenta extrair preço via API interceptada primeiro
    price = captured_price["value"]
    
    # Se não capturou via API, tenta via DOM
    if not price:
        price = extract_price_from_page(page)
    
    # Extrai título via DOM ou meta tag
    title = None
    try:
        title = page.evaluate("""
            () => {
                const og = document.querySelector('meta[property="og:title"]');
                if (og) return og.content;
                const h1 = document.querySelector('h1[class*="product"], h1[class*="title"], h1');
                if (h1) return h1.textContent.trim();
                return document.title;
            }
        """)
        if title:
            # Limpa o título (remove "| Shopee Brasil" etc)
            title = re.sub(r'\s*\|\s*Shopee.*$', '', title).strip()
            if len(title) < 3:
                title = None
    except Exception:
        pass
    
    # Extrai imagem via meta og:image
    image = None
    try:
        image = page.evaluate("""
            () => {
                const og = document.querySelector('meta[property="og:image"]');
                if (og) return og.content;
                // Tenta imagem principal do produto
                const img = document.querySelector('img[class*="product"], img[class*="main"]');
                if (img) return img.src;
                return null;
            }
        """)
    except Exception:
        pass
    
    page.remove_listener("response", handle_response)
    
    return {
        "price": price,
        "title": title,
        "image": image,
    }


def main():
    print("=" * 65)
    print("  shopee_fix_prices_playwright.py — Preços via Playwright")
    print("=" * 65)
    print()
    
    results    = []
    sql_lines  = []
    sql_lines.append("-- Correção de preços Shopee via Playwright")
    sql_lines.append(f"-- Data: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    sql_lines.append("")

    with sync_playwright() as p:
        print("🚀 Iniciando Chromium headless...")
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--lang=pt-BR",
            ]
        )
        
        context = browser.new_context(
            locale="pt-BR",
            timezone_id="America/Sao_Paulo",
            viewport={"width": 1280, "height": 800},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            extra_http_headers={
                "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
            }
        )
        
        page = context.new_page()
        
        # Bloqueia recursos desnecessários para acelerar
        def block_resources(route):
            if route.request.resource_type in ("media", "font"):
                route.abort()
            else:
                route.continue_()
        
        page.route("**/*", block_resources)
        
        print("✅ Browser pronto!\n")
        
        for i, offer in enumerate(OFFERS, 1):
            offer_id  = offer["id"]
            title_db  = offer["title"]
            
            print(f"[{i}/{len(OFFERS)}] offer {offer_id}: {title_db[:50]}...")
            
            result = fetch_product_data(page, offer)
            
            price = result.get("price")
            title = result.get("title") or title_db
            image = result.get("image")
            
            if price and price > 0.01:
                print(f"  ✅ price=R$ {price:.2f}")
            else:
                print(f"  ⚠️  Sem preço obtido")
            
            if title and title != title_db:
                print(f"  📝 title={title[:55]}")
            if image:
                print(f"  🖼️  image={image[:55]}...")
            
            results.append({
                "offer_id": offer_id,
                "price": price,
                "title": title,
                "image": image,
                "status": "ok" if (price and price > 0.01) else "no_price",
            })
            
            if price and price > 0.01:
                title_esc = (title or "").replace("'", "''")
                image_sql = f"'{image}'" if image else "image_url"
                sql_lines.append(
                    f"UPDATE offers SET "
                    f"price={price}, "
                    f"image_url={image_sql}, "
                    f"title='{title_esc}', "
                    f"last_updated=CURRENT_TIMESTAMP "
                    f"WHERE id={offer_id};"
                )
            
            print()
            time.sleep(1)
        
        browser.close()
    
    # ── Salva SQL ──────────────────────────────────────────────────────────
    sql_path  = "/home/user/webapp/scripts/fix_shopee_prices.sql"
    json_path = "/home/user/webapp/scripts/fix_shopee_prices_result.json"
    
    with open(sql_path, "w", encoding="utf-8") as f:
        f.write("\n".join(sql_lines) + "\n")
    
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    
    # ── Resumo ─────────────────────────────────────────────────────────────
    print("=" * 65)
    ok       = [r for r in results if r["status"] == "ok"]
    no_price = [r for r in results if r["status"] == "no_price"]
    
    print(f"RESUMO:")
    print(f"  ✅ Com preço válido : {len(ok)}")
    print(f"  ⚠️  Sem preço       : {len(no_price)}")
    print()
    
    if ok:
        print("Preços obtidos:")
        for r in ok:
            print(f"  offer {r['offer_id']}: R$ {r['price']:.2f}")
        print()
        print(f"✅ SQL salvo em: {sql_path}")
        print()
        print("Execute para aplicar no D1 remoto:")
        print(f"  cd /home/user/webapp && npx wrangler d1 execute webapp-production --remote --file=./scripts/fix_shopee_prices.sql")
    else:
        print("❌ Nenhum preço obtido via Playwright.")
        print("   A Shopee está bloqueando IPs do sandbox mesmo com browser headless.")
    
    print("=" * 65)
    print(f"📊 JSON: {json_path}")
    
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
