#!/bin/bash
# ============================================================
# NexusIA Dev Platform — Deploy Automático Cloudflare Pages
# ============================================================
# USO: ./deploy_cloudflare.sh <CLOUDFLARE_API_TOKEN> [ACCOUNT_ID]
# ============================================================

set -e

CF_TOKEN="${1:-$CLOUDFLARE_API_TOKEN}"
PROJECT_NAME="nexusia-dev-platform"
BUILD_DIR="/home/user/flutter_app/build/web"

if [ -z "$CF_TOKEN" ]; then
  echo "❌ ERRO: Token Cloudflare não fornecido!"
  echo ""
  echo "Como obter o token:"
  echo "  1. Acesse: https://dash.cloudflare.com/profile/api-tokens"
  echo "  2. Clique em 'Create Token'"
  echo "  3. Use o template 'Edit Cloudflare Workers' ou crie custom com:"
  echo "     - Cloudflare Pages: Edit"
  echo "     - Account: Read"
  echo "  4. Copie o token gerado"
  echo ""
  echo "Uso: ./deploy_cloudflare.sh SEU_TOKEN_AQUI"
  exit 1
fi

echo "🔐 Verificando token Cloudflare..."
VERIFY=$(curl -s -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/user/tokens/verify")
  
if ! echo "$VERIFY" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('result',{}).get('status')=='active' else 1)" 2>/dev/null; then
  echo "❌ Token inválido ou sem permissão!"
  echo "Resposta: $VERIFY"
  exit 1
fi
echo "✅ Token válido!"

# Obter Account ID
echo "🔍 Obtendo Account ID..."
if [ -n "$2" ]; then
  ACCOUNT_ID="$2"
  echo "   Usando Account ID fornecido: $ACCOUNT_ID"
else
  ACCOUNT_ID=$(curl -s -H "Authorization: Bearer $CF_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts?per_page=1" | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result'][0]['id'])" 2>/dev/null)
  if [ -z "$ACCOUNT_ID" ]; then
    echo "❌ Não foi possível obter o Account ID automaticamente."
    echo "   Forneça como segundo argumento: ./deploy_cloudflare.sh TOKEN ACCOUNT_ID"
    exit 1
  fi
  echo "   Account ID: $ACCOUNT_ID"
fi

# Verificar se o projeto já existe
echo "📋 Verificando projeto '$PROJECT_NAME'..."
PROJECT_EXISTS=$(curl -s \
  -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects/$PROJECT_NAME" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if d.get('success') else 'no')" 2>/dev/null)

if [ "$PROJECT_EXISTS" != "yes" ]; then
  echo "🆕 Criando projeto Cloudflare Pages '$PROJECT_NAME'..."
  CREATE_RESULT=$(curl -s -X POST \
    -H "Authorization: Bearer $CF_TOKEN" \
    -H "Content-Type: application/json" \
    "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects" \
    --data "{
      \"name\": \"$PROJECT_NAME\",
      \"production_branch\": \"main\"
    }")
  
  if ! echo "$CREATE_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('success') else 1)" 2>/dev/null; then
    echo "❌ Falha ao criar projeto!"
    echo "$CREATE_RESULT"
    exit 1
  fi
  echo "✅ Projeto criado!"
else
  echo "✅ Projeto já existe, atualizando..."
fi

# Rebuild para garantir que está atualizado
echo ""
echo "🔨 Rebuilding Flutter Web (release)..."
cd /home/user/flutter_app
flutter build web --release \
  --dart-define=flutter.inspector.structuredErrors=false \
  --dart-define=debugShowCheckedModeBanner=false 2>&1 | tail -3

# Deploy via wrangler
echo ""
echo "🚀 Fazendo deploy para Cloudflare Pages..."
export CLOUDFLARE_API_TOKEN="$CF_TOKEN"
export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID"

wrangler pages deploy "$BUILD_DIR" \
  --project-name="$PROJECT_NAME" \
  --branch="main" \
  --commit-message="NexusIA Dev Platform — Flutter Web Release" 2>&1

echo ""
echo "✅ Deploy concluído!"
echo ""
echo "🌐 URL do projeto:"
echo "   https://$PROJECT_NAME.pages.dev"
echo ""
echo "📋 Painel Cloudflare:"
echo "   https://dash.cloudflare.com/$ACCOUNT_ID/pages/view/$PROJECT_NAME"
