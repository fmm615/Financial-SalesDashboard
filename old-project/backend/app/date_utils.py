from __future__ import annotations
"""Calendar-correct month arithmetic (the timedelta(days=30) approximation
skips/duplicates months — e.g. from Mar 1 it produces Oct, Nov, Dec, Dec, Jan, Mar)."""
import calendar
from datetime import date


def months_ago(d: date, n: int) -> date:
    """First day of the month `n` months before d's month. n=0 → first of d's month."""
    total = d.year * 12 + (d.month - 1) - n
    return date(total // 12, total % 12 + 1, 1)


def month_end(d: date) -> date:
    """Last day of d's month."""
    return date(d.year, d.month, calendar.monthrange(d.year, d.month)[1])
