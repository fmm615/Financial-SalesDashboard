from __future__ import annotations
"""
Generates matplotlib charts as PNG bytes for embedding in PDF reports.
Uses the Agg (non-interactive) backend — safe in background threads.
"""
import io
from typing import Optional
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker

PURPLE = "#2A004C"
LIME = "#C8FF00"
GREY = "#555555"
LIGHT = "#E8E0F0"

plt.rcParams.update({
    "font.family": "DejaVu Sans",
    "axes.spines.top": False,
    "axes.spines.right": False,
    "axes.edgecolor": "#CCCCCC",
    "axes.labelcolor": GREY,
    "xtick.color": GREY,
    "ytick.color": GREY,
    "figure.facecolor": "white",
    "axes.facecolor": "white",
})


def _to_png(fig) -> bytes:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=150, bbox_inches="tight")
    plt.close(fig)
    buf.seek(0)
    return buf.read()


def revenue_trend_chart(rows: list[dict], width_in: float = 6.5, height_in: float = 3.2) -> bytes:
    """Stacked bar: B2C / B2B / Other per month."""
    labels = [r.get("label", r.get("month", "")) for r in rows]
    b2c = [float(r.get("b2c", 0)) for r in rows]
    b2b = [float(r.get("b2b", 0)) for r in rows]
    other = [float(r.get("other", 0)) for r in rows]

    x = range(len(labels))
    fig, ax = plt.subplots(figsize=(width_in, height_in))
    bar_width = 0.55

    ax.bar(x, b2c, bar_width, label="B2C", color=LIME, edgecolor="none")
    ax.bar(x, b2b, bar_width, bottom=b2c, label="B2B", color=PURPLE, edgecolor="none")
    bottom_other = [a + b for a, b in zip(b2c, b2b)]
    ax.bar(x, other, bar_width, bottom=bottom_other, label="Other", color=LIGHT, edgecolor="none")

    ax.set_xticks(list(x))
    ax.set_xticklabels(labels, rotation=30, ha="right", fontsize=8)
    ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda v, _: f"${v/1000:.0f}K" if v >= 1000 else f"${v:.0f}"))
    ax.set_ylabel("Revenue (USD)", fontsize=9)
    ax.legend(fontsize=8, frameon=False)
    ax.set_title("Revenue by Month", fontsize=11, color=PURPLE, fontweight="bold", pad=8)
    fig.tight_layout()
    return _to_png(fig)


def pipeline_funnel_chart(stages: list[dict], width_in: float = 6.5, height_in: float = 3.2) -> bytes:
    """Horizontal bars: B2B pipeline by stage (value)."""
    labels = [s.get("stage", "Unknown") for s in stages]
    values = [float(s.get("total_value", 0)) for s in stages]
    counts = [int(s.get("count", 0)) for s in stages]

    fig, ax = plt.subplots(figsize=(width_in, height_in))
    y = range(len(labels))
    bars = ax.barh(list(y), values, color=PURPLE, edgecolor="none", height=0.6)
    for bar, count, val in zip(bars, counts, values):
        ax.text(
            bar.get_width() + max(values) * 0.01,
            bar.get_y() + bar.get_height() / 2,
            f"${val/1000:.0f}K ({count})",
            va="center", fontsize=8, color=GREY
        )
    ax.set_yticks(list(y))
    ax.set_yticklabels(labels, fontsize=9)
    ax.xaxis.set_major_formatter(mticker.FuncFormatter(lambda v, _: f"${v/1000:.0f}K"))
    ax.set_xlabel("Pipeline Value (USD)", fontsize=9)
    ax.set_title("B2B Pipeline by Stage", fontsize=11, color=PURPLE, fontweight="bold", pad=8)
    ax.invert_yaxis()
    fig.tight_layout()
    return _to_png(fig)


def member_growth_chart(rows: list[dict], width_in: float = 6.5, height_in: float = 3.0) -> bytes:
    """Line chart: total active members over time."""
    labels = [r.get("label", r.get("month", "")) for r in rows]
    values = [float(r.get("total", 0)) for r in rows]

    fig, ax = plt.subplots(figsize=(width_in, height_in))
    ax.plot(labels, values, color=PURPLE, linewidth=2.5, marker="o", markersize=5, zorder=3)
    ax.fill_between(labels, values, alpha=0.08, color=PURPLE)
    ax.set_xticks(range(len(labels)))
    ax.set_xticklabels(labels, rotation=30, ha="right", fontsize=8)
    ax.set_ylabel("Members", fontsize=9)
    ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda v, _: f"{int(v):,}"))
    ax.set_title("Member Growth", fontsize=11, color=PURPLE, fontweight="bold", pad=8)
    fig.tight_layout()
    return _to_png(fig)


def expense_breakdown_chart(rows: list[dict], width_in: float = 4.0, height_in: float = 3.5) -> bytes:
    """Pie chart: expense by category."""
    clean = {r.get("category", "other").replace("expense_", "").replace("_", " ").title(): float(r.get("amount", 0)) for r in rows if float(r.get("amount", 0)) > 0}
    if not clean:
        fig, ax = plt.subplots(figsize=(width_in, height_in))
        ax.text(0.5, 0.5, "No expense data", transform=ax.transAxes, ha="center", va="center", color=GREY)
        ax.axis("off")
        return _to_png(fig)

    labels = list(clean.keys())
    sizes = list(clean.values())
    palette = [PURPLE, LIME, "#7B3FA0", "#9DD6FF", "#A8E6CF", "#FFB347", "#FF6B6B"]
    colors = [palette[i % len(palette)] for i in range(len(labels))]

    fig, ax = plt.subplots(figsize=(width_in, height_in))
    wedges, _, autotexts = ax.pie(
        sizes, labels=None, autopct="%1.0f%%", colors=colors,
        startangle=140, pctdistance=0.75,
        wedgeprops=dict(linewidth=0.5, edgecolor="white"),
    )
    for at in autotexts:
        at.set_fontsize(8)
    ax.legend(wedges, labels, loc="lower center", bbox_to_anchor=(0.5, -0.18), ncol=2, fontsize=8, frameon=False)
    ax.set_title("Expense Breakdown", fontsize=11, color=PURPLE, fontweight="bold", pad=8)
    fig.tight_layout()
    return _to_png(fig)
