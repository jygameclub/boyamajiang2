# Boya Mahjong2 live controls verification

- verdict: PASS
- baseUrl: http://127.0.0.1:18082
- token: button-final-live-20260710
- error: none
- HTTP >= 400: 0
- pageErrors: 0
- clientCloses: 0
- authTimeout: false
- serverMismatches: 0

## Controls

- auto: requests=3, responses=3
- bet: betMulti=100, betCoin=2000, roundWin=0
- buy: cost=160000, scatter=3, positions=11,16,17, free=10
- buy first free: betMulti=100, betCoin=2000, roundWin=3600
- in-game history: list=147 bytes, detail=6176 bytes
- persisted live rows: 4

