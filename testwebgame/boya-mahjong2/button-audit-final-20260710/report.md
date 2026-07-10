# Mahjong Ways 2 Client Button Audit

- verdict: PASS
- baseUrl: http://127.0.0.1:18082
- token: user2
- error: none
- HTTP >= 400: 0
- request failures: 0
- external HTTP requests: 0
- page errors: 0
- unexpected client closes: 0
- auth timeout: false
- server mismatches: 0

## Controls

- turbo: false -> true -> false
- sound restored: true/true
- space spin: 40002, bet=400
- bet multiplier: 20 -> 100 -> 20
- auto dialog: true
- rules: true/true
- history list/detail: 10/1
- settings selector: true
- replay finish/reentry: true/true
- local hub open/close: true/true
- quit popup/cancel: true/true

