#!/bin/bash
set -e

echo "=== Deploy chess.logteam.asia ==="
echo ""

echo "[1/4] Pull code..."
git pull

echo ""
echo "[2/4] Build..."
./gradlew :webapp:assemble -x test

echo ""
echo "[3/4] Restart service..."
sudo systemctl restart elephantchess

echo ""
echo "[4/4] Check status..."
sleep 3
sudo systemctl status elephantchess --no-pager | head -20

echo ""
echo "--- Last logs ---"
sudo journalctl -u elephantchess -n 20 --no-pager

echo ""
echo "--- Health check ---"
if curl -sf -o /dev/null http://127.0.0.1:8080/; then
    echo "OK - http://127.0.0.1:8080 is up"
else
    echo "FAIL - http://127.0.0.1:8080 not responding"
    exit 1
fi

echo ""
echo "=== Done! Check https://chess.logteam.asia ==="
