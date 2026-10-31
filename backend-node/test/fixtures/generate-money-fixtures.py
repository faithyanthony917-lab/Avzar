#!/usr/bin/env python3
"""Generates money-parity.json. Expected values come from Python's Decimal (exact, ROUND_HALF_UP == half away from
zero), an oracle independent of the JS implementation. The same file can drive a C# test against InvoiceMath."""
import json, random
from decimal import Decimal as D, ROUND_HALF_UP, getcontext

getcontext().prec = 50
random.seed(20261018)
CENT = D('0.01')
R = lambda v: v.quantize(CENT, rounding=ROUND_HALF_UP)
s = lambda v: format(v, 'f')

def line(q, p, disc, tax):
    gross = R(q * p); net = gross - disc; t = R(net * tax / 100)
    return gross, net, t, net + t

def allocate(grosses, discount):
    total = sum(grosses)
    if discount <= 0 or total <= 0: return [D('0.00')] * len(grosses)
    exact = [g * discount / total for g in grosses]
    shares = [(e * 100).to_integral_value(rounding='ROUND_FLOOR') / 100 for e in exact]
    cents = int(((discount - sum(shares)) * 100).to_integral_value(rounding=ROUND_HALF_UP))
    order = sorted(range(len(shares)), key=lambda i: (-(exact[i] - shares[i]), i))
    for i in order[:cents]: shares[i] += D('0.01')
    return [R(x) for x in shares]

rates = ['0', '5', '7.5', '10', '12.5', '15', '16', '18', '20', '6.625', '8.875', '0.125', '7.25', '13', '14.975', '9.975', '100']
lines = []
known = [('1', '14.50', '0', '15'), ('3', '6.62', '0', '6.625'), ('1', '0.05', '0', '50'), ('1', '19.99', '0', '8.875'), ('2', '0.35', '0', '15')]
for q, p, d, t in known:
    g, n, x, tot = line(D(q), D(p), D(d), D(t))
    lines.append({'q': q, 'p': p, 'd': d, 't': t, 'gross': s(g), 'net': s(n), 'tax': s(x), 'total': s(tot)})
for _ in range(4000):
    q = D(random.randint(1, 5000)) / 100 if random.random() < .5 else D(random.randint(1, 20))
    p = D(random.randint(1, 500000)) / 100
    gross = R(q * p)
    d = R(gross * D(random.randint(0, 100)) / 100) if random.random() < .4 else D('0.00')
    t = D(random.choice(rates))
    g, n, x, tot = line(q, p, d, t)
    lines.append({'q': s(q), 'p': s(p), 'd': s(d), 't': s(t), 'gross': s(g), 'net': s(n), 'tax': s(x), 'total': s(tot)})

rounds = []
for v in ['2.675', '-2.675', '1.005', '-1.005', '0.005', '-0.005', '0.015', '2.5', '-2.5', '1234567.895', '0.004999', '-0.004999', '8.125', '1.115']:
    rounds.append({'v': v, 'r': s(R(D(v)))})
for _ in range(500):
    v = D(random.randint(-10_000_000, 10_000_000)) / 1000
    rounds.append({'v': s(v), 'r': s(R(v))})

percents = []
for _ in range(1500):
    amt = D(random.randint(1, 10_000_000)) / 100
    pct = D(random.choice(['10', '25', '30', '33.33', '12.5', '7.25', '6.625', '50', '15', '8.875']))
    percents.append({'amount': s(amt), 'percent': s(pct), 'r': s(R(amt * pct / 100))})

balances = []
for _ in range(1500):
    total = D(random.randint(1, 10_000_000)) / 100
    paid = R(total * D(random.randint(0, 100)) / 100)
    credited = R((total - paid) * D(random.randint(0, 100)) / 100)
    balances.append({'total': s(total), 'paid': s(paid), 'credited': s(credited), 'balance': s(total - paid - credited)})

allocations = []
for _ in range(1500):
    n = random.randint(1, 6)
    grosses = [D(random.randint(1, 2_000_000)) / 100 for _ in range(n)]
    discount = R(sum(grosses) * D(random.randint(0, 100)) / 100)
    allocations.append({'gross': [s(g) for g in grosses], 'discount': s(discount), 'shares': [s(x) for x in allocate(grosses, discount)]})

json.dump({'lines': lines, 'rounds': rounds, 'percents': percents, 'balances': balances, 'allocations': allocations},
          open('test/fixtures/money-parity.json', 'w'), separators=(',', ':'))
print({k: len(v) for k, v in locals().items() if k in ('lines', 'rounds', 'percents', 'balances', 'allocations')})
