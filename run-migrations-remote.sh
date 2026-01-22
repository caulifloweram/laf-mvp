#!/bin/bash
# Run migrations against Railway PostgreSQL
# Usage: DATABASE_URL="postgresql://..." ./run-migrations-remote.sh

if [ -z "$DATABASE_URL" ]; then
  echo "❌ Error: DATABASE_URL environment variable is required"
  echo "Usage: DATABASE_URL='postgresql://...' ./run-migrations-remote.sh"
  echo ""
  echo "Get DATABASE_URL from Railway:"
  echo "1. Go to your Railway project"
  echo "2. Click on PostgreSQL service"
  echo "3. Go to Variables tab"
  echo "4. Copy the DATABASE_URL value"
  exit 1
fi

echo "🔗 Connecting to Railway database..."
echo "📦 Running migrations..."

cd packages/api
export DATABASE_URL="$DATABASE_URL"
pnpm run migrate

if [ $? -eq 0 ]; then
  echo "✅ Migrations completed successfully!"
else
  echo "❌ Migration failed. Check the error above."
  exit 1
fi
