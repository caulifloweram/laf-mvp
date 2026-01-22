#!/bin/bash

# Cleanup script for stale streams
# Usage: ./cleanup-streams.sh

API_URL="${API_URL:-https://lafapi-production.up.railway.app}"

echo "🧹 Cleaning up ALL active streams..."
echo "API URL: $API_URL"
echo ""

response=$(curl -s -X POST "$API_URL/api/admin/cleanup-streams" \
  -H "Content-Type: application/json" \
  -w "\n%{http_code}")

http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')

if [ "$http_code" = "200" ]; then
  echo "✅ Success!"
  echo ""
  if command -v jq &> /dev/null; then
    echo "$body" | jq '.'
    cleaned=$(echo "$body" | jq -r '.cleanedStreams | length' 2>/dev/null)
    active_before=$(echo "$body" | jq -r '.activeBefore' 2>/dev/null)
    active_after=$(echo "$body" | jq -r '.activeAfter' 2>/dev/null)
    echo ""
    echo "📊 Summary:"
    echo "   Active streams before: $active_before"
    echo "   Streams cleaned: $cleaned"
    echo "   Active streams after: $active_after"
  else
    echo "$body"
  fi
  echo ""
  echo "⏳ Wait a few seconds, then refresh the client page to see the changes."
else
  echo "❌ Error (HTTP $http_code):"
  echo "$body"
fi
