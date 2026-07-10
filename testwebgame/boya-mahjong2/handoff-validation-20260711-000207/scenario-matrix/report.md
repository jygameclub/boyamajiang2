# Boya Mahjong2 deterministic scenario matrix

- verdict: PASS
- scenarios: 28
- HTTP >= 400: 0
- pageErrors: 0
- clientCloses: 0
- authTimeout: false
- serverMismatches: 0

- route-near-miss: PASS, winSteps=0, multipliers=-, lines=
- route-zigzag-single: PASS, winSteps=1, multipliers=1, lines=1
- route-multi-ways: PASS, winSteps=1, multipliers=1, lines=1
- route-five-axes: PASS, winSteps=1, multipliers=1, lines=1
- route-multi-icon: PASS, winSteps=1, multipliers=1, lines=2
- cascade-two-win-steps: PASS, winSteps=2, multipliers=1/2, lines=1/1
- cascade-four-win-steps: PASS, winSteps=4, multipliers=1/2/3/5, lines=1/1/1/1
- cascade-gold-to-wild: PASS, winSteps=2, multipliers=1/2, lines=1/1
- cascade-wild-next-eliminate: PASS, winSteps=2, multipliers=1/2, lines=1/1
- route-wild-reuse: PASS, winSteps=1, multipliers=1, lines=2
- cascade-refill-win: PASS, winSteps=2, multipliers=1/2, lines=1/1
- cascade-limit-terminal: PASS, winSteps=2, multipliers=1/2, lines=1/1
- route-top-single: PASS, winSteps=1, multipliers=1, lines=1
- route-bottom-single: PASS, winSteps=1, multipliers=1, lines=1
- route-four-axes: PASS, winSteps=1, multipliers=1, lines=1
- route-four-axes-multi-ways: PASS, winSteps=1, multipliers=1, lines=1
- route-five-axes-multi-ways: PASS, winSteps=1, multipliers=1, lines=1
- route-three-icons: PASS, winSteps=1, multipliers=1, lines=3
- cascade-one-win-step: PASS, winSteps=1, multipliers=1, lines=1
- cascade-three-win-steps: PASS, winSteps=3, multipliers=1/2/3, lines=1/1/1
- cascade-multi-way-refill: PASS, winSteps=2, multipliers=1/2, lines=1/1
- cascade-multi-icon-refill: PASS, winSteps=2, multipliers=1/2, lines=2/2
- cascade-scatter-gravity: PASS, winSteps=1, multipliers=1, lines=1
- cascade-gold-wild-hold: PASS, winSteps=1, multipliers=1, lines=1
- cascade-double-gold-to-wild: PASS, winSteps=2, multipliers=1/2, lines=1/1
- route-multiple-wild-same-line: PASS, winSteps=1, multipliers=1, lines=1
- cascade-gold-wild-multi-icon: PASS, winSteps=2, multipliers=1/2, lines=1/2
- route-mixed-base-gold-wild: PASS, winSteps=1, multipliers=1, lines=1

