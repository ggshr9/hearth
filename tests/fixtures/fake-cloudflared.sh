#!/usr/bin/env bash
# Fake cloudflared for tests. Prints a sentinel URL line within 100ms,
# then sits until killed.
set -e
echo "INF Requesting new quick Tunnel on trycloudflare.com..."
sleep 0.05
echo "Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):"
echo "https://fake-tunnel-test.trycloudflare.com"
# Stay alive
sleep 30 &
wait
