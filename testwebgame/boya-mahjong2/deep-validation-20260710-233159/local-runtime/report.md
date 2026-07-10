# Boya Mahjong2 local runtime audit

- verdict: PASS
- baseUrl: http://127.0.0.1:18083
- error: none

- test-client: PASS, requests=246, websockets=2, hosts=127.0.0.1:18083, external=0, HTTP>=400=0, failed=0
- live-client: PASS, requests=250, websockets=2, hosts=127.0.0.1:18083, external=0, HTTP>=400=0, failed=0
- admin: PASS, requests=6, websockets=0, hosts=127.0.0.1:18083, external=0, HTTP>=400=0, failed=0
- history: PASS, requests=8, websockets=0, hosts=127.0.0.1:18083, external=0, HTTP>=400=0, failed=0
