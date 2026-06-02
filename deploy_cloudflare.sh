#!/bin/bash
# ============================================================
# NexusIA Dev Platform — Deploy Automático Cloudflare Pages
# ============================================================
# USAGE: 
#   ./deploy_cloudflare.sh TOKEN                  # auto-detecta account
#   ./deploy_cloudflare.sh TOKEN ACCOUNT_ID       # account específica
# ============================================================

set -e

CF_TOKEN="${1:-$CLOUDFLARE_API_TOKEN}"
ACCOUNT_ID_ARG="$2"
PROJECT_NAME="nexusia-dev-platform"
BUILD_DIR="/home/user/flutter_app/build/web"
FLUTTER_DIR="/home/user/flutter_app"

# ──────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   NexusIA — Deploy Cloudflare Pages      ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# 1. Validar token
if [ -z "$CF_TOKEN" ]; then
  echo "❌ Token não fornecido!"
  echo ""
  echo "📋 COMO OBTER O TOKEN CLOUDFLARE:"
  echo "  1. Acesse: https://dash.cloudflare.com/profile/api-tokens"
  echo "  2. Clique em 'Create Token'"  
  echo "  3. Use template 'Edit Cloudflare Workers'"
  echo "     OU crie custom com permissão: Cloudflare Pages → Edit"
  echo "  4. Copie o token gerado"
  echo ""
  echo "USAGE: ./deploy_cloudflare.sh SEU_TOKEN"
  exit 1
fi

# 2. Verificar token
echo "🔐 Verificando token..."
VERIFY=$(curl -sf -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/user/tokens/verify" 2>/dev/null || echo '{"result":{"status":"invalid"}}')
STATUS=$(echo "$VERIFY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',{}).get('status','invalid'))" 2>/dev/null)
if [ "$STATUS" != "active" ]; then
  echo "❌ Token inválido ou expirado! Status: $STATUS"
  exit 1
fi
echo "✅ Token ativo!"

# 3. Account ID
echo "🔍 Obtendo Account ID..."
if [ -n "$ACCOUNT_ID_ARG" ]; then
  ACCOUNT_ID="$ACCOUNT_ID_ARG"
else
  ACCOUNT_ID=$(curl -sf -H "Authorization: Bearer $CF_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts?per_page=1" 2>/dev/null | \
    python3 -c "import sys,json; print(json.load(sys.stdin)['result'][0]['id'])" 2>/dev/null)
fi
if [ -z "$ACCOUNT_ID" ]; then
  echo "❌ Não foi possível obter Account ID."
  echo "   Forneça manualmente: ./deploy_cloudflare.sh TOKEN ACCOUNT_ID"
  echo "   Encontre em: https://dash.cloudflare.com → 'Account ID' no painel direito"
  exit 1
fi
echo "   Account ID: ${ACCOUNT_ID:0:8}..."

# 4. Criar projeto se não existir
echo "📋 Verificando projeto '$PROJECT_NAME'..."
PROJECT_EXISTS=$(curl -sf \
  -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects/$PROJECT_NAME" 2>/dev/null | \
  python3 -c "import sys,json; print('yes' if json.load(sys.stdin).get('success') else 'no')" 2>/dev/null || echo "no")

if [ "$PROJECT_EXISTS" != "yes" ]; then
  echo "🆕 Criando projeto '$PROJECT_NAME'..."
  RESULT=$(curl -sf -X POST \
    -H "Authorization: Bearer $CF_TOKEN" \
    -H "Content-Type: application/json" \
    "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects" \
    -d '{"name":"'"$PROJECT_NAME"'","production_branch":"main"}' 2>/dev/null)
  if ! echo "$RESULT" | python3 -c "import sys,json; exit(0 if json.load(sys.stdin).get('success') else 1)" 2>/dev/null; then
    echo "❌ Falha ao criar projeto: $RESULT"
    exit 1
  fi
  echo "✅ Projeto criado!"
else
  echo "✅ Projeto existente encontrado!"
fi

# 5. Build Flutter Web
echo ""
echo "🔨 Build Flutter Web (Release)..."
cd "$FLUTTER_DIR"
flutter build web --release \
  --dart-define=flutter.inspector.structuredErrors=false \
  --dart-define=debugShowCheckedModeBanner=false 2>&1 | grep -E "(Built|Error|Warning|✓)" || true
echo "✅ Build concluído → $BUILD_DIR"

# 6. Deploy via Wrangler
echo ""
echo "🚀 Fazendo upload para Cloudflare Pages..."
export CLOUDFLARE_API_TOKEN="$CF_TOKEN"
export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID"

wrangler pages deploy "$BUILD_DIR" \
  --project-name="$PROJECT_NAME" \
  --branch="main" \
  --commit-message="NexusIA Deploy — $(date '+%Y-%m-%d %H:%M')" 2>&1

# 7. Resultado
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║         🎉 DEPLOY CONCLUÍDO!             ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "🌐 Produção:  https://$PROJECT_NAME.pages.dev"
echo "📊 Painel:    https://dash.cloudflare.com/pages"
echo ""
