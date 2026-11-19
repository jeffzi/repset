"""Writes tests/fixtures/signed-rank.json, the expected values tests/signed-rank.test.ts checks.

Each case holds its differences beside `p`, the two-sided exact signed-rank p value with zeros
dropped (scipy's exact `wilcoxon`, or an exact `permutation_test` when magnitudes tie), `estimate`,
the Hodges-Lehmann estimate, and `intervals`, the exact interval at each level 1 - 0.05 / pairs a
contest of 2 to 8 contenders uses. scipy has no Hodges-Lehmann estimate or interval, so both are
computed here from the Walsh averages, with the critical value from the untied null checked
against scipy.

scipy's exact `wilcoxon` returns 0.0 for p values under about 1e-16 once n passes 53, so the
cases past 53 keep p above 1e-6.
"""

import json
import random
import statistics
import sys
from fractions import Fraction
from functools import cache

import numpy as np
from scipy import stats

LEVELS = [1 - 0.05 / (k * (k - 1) // 2) for k in range(2, 9)]


def walsh(d):
    return sorted((d[i] + d[j]) / 2 for i in range(len(d)) for j in range(i, len(d)))


@cache
def untied_counts(n):
    """counts[t] = number of sign assignments of ranks 1..n whose positive rank sum is t."""
    counts = [1]
    for r in range(1, n + 1):
        nxt = counts + [0] * r
        for t, c in enumerate(counts):
            nxt[t + r] += c
        counts = nxt
    return counts


def untied_cdf(n, c):
    counts = untied_counts(n)
    return Fraction(sum(counts[: c + 1]), 2**n)


def scipy_untied_p(n, c):
    """scipy's exact two-sided p for ranks 1..n whose negative rank sum is c."""
    values = list(range(1, n + 1))
    remaining = c
    for r in range(n, 0, -1):
        if r <= remaining:
            values[r - 1] = -r
            remaining -= r
    assert remaining == 0
    return stats.wilcoxon(values, method="exact").pvalue


def critical(n, level):
    alpha = 1 - level
    found = 0
    for c in range(1, n * (n + 1) // 2 + 1):
        if 2 * untied_cdf(n, c - 1) <= alpha:
            found = c
        else:
            break
    if found:
        for c in (found - 1, found):
            ours = min(1.0, float(2 * untied_cdf(n, c)))
            theirs = scipy_untied_p(n, c)
            assert abs(ours - theirs) <= 1e-12 * theirs, (n, c, ours, theirs)
    return found


def p_value(d):
    nonzero = np.array([x for x in d if x != 0])
    if len(nonzero) == 0:
        return 1.0
    magnitudes = np.abs(nonzero)
    if len(np.unique(magnitudes)) == len(magnitudes):
        p = float(stats.wilcoxon(nonzero, method="exact").pvalue)
        assert len(nonzero) <= 53 or p > 1e-6, (len(nonzero), p)
        return p
    ranks = stats.rankdata(magnitudes)

    def statistic(x, axis):
        return np.sum(np.where(x > 0, ranks, 0), axis=axis)

    result = stats.permutation_test(
        (nonzero,),
        statistic,
        permutation_type="samples",
        vectorized=True,
        n_resamples=np.inf,
        alternative="two-sided",
    )
    return float(result.pvalue)


def case(name, d):
    w = walsh(d)
    m = len(w)
    intervals = []
    for level in LEVELS:
        c = critical(len(d), level)
        if c:
            intervals.append({"level": level, "low": w[c - 1], "high": w[m - c]})
    return {
        "name": name,
        "differences": d,
        "p": p_value(d),
        "estimate": statistics.median(w),
        "intervals": intervals,
    }


def main():
    out = sys.argv[1]
    rng = random.Random(20261119)

    def draws(n, mean, sd=0.05):
        return [rng.gauss(mean, sd) for _ in range(n)]

    def on_grid(values, step=0.01):
        return [round(round(v / step) * step, 2) for v in values]

    cases = [
        case("untied, n = 6", draws(6, 0.02)),
        case("untied, n = 9, mixed signs", draws(9, 0.0)),
        case("ties, n = 10", on_grid(draws(10, 0.02, 0.03))),
        case("ties, n = 14", on_grid(draws(14, 0.01, 0.03))),
        case("ties, n = 16, one value repeated", [0.02] * 5 + on_grid(draws(11, 0.03, 0.04))),
        case("zeros, n = 12", [0.0, 0.0, 0.0] + draws(9, 0.03)),
        case("zeros and ties, n = 13", [0.0, 0.0] + on_grid(draws(11, 0.02, 0.03))),
        case("only zeros, n = 4", [0.0, 0.0, 0.0, 0.0]),
        case("untied, n = 11", draws(11, 0.02)),
        case("untied, n = 13", draws(13, 0.01)),
        case("untied, n = 16", draws(16, 0.02)),
        case("untied, n = 20", draws(20, 0.01)),
        case("untied, n = 25", draws(25, 0.0)),
        case("untied, n = 30", draws(30, 0.02)),
        case("untied, n = 54", draws(54, 0.01)),
        case("untied, n = 60, shifted", draws(60, 0.02)),
        case("untied, n = 80", draws(80, 0.0)),
        case("zeros, n = 64, 58 nonzero", [0.0] * 6 + draws(58, 0.01)),
    ]
    with open(out, "w") as f:
        json.dump(
            {
                "generator": "scripts/signed-rank-fixtures.py",
                "cases": cases,
            },
            f,
        )


main()
