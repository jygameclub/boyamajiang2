# Boya Mahjong2 live controls verification

- verdict: PASS
- baseUrl: http://127.0.0.1:18082
- token: bugfix-user
- error: none
- HTTP >= 400: 0
- pageErrors: 0
- clientCloses: 0
- authTimeout: false
- serverMismatches: 0

## Controls

- auto: requests=3, responses=3
- bet: betMulti=100, betCoin=2000, roundWin=0
- buy: cost=160000, scatter=5, positions=2,4,14,16,21, free=14
- buy first free: betMulti=100, betCoin=2000, roundWin=19200
- in-game history: list=180 bytes, detail=9532 bytes
- persisted live rows: 6
