#!/usr/bin/env python3
"""Audit and gate publication of betterGTrade journal notes and captions.

The raw export was written for private use. This tool turns it into a
review queue, then builds a small public file from rows a human has
explicitly approved.

Usage:
    python3 scripts/review_notes.py audit   # writes review/notes-review.csv + report.md
    python3 scripts/review_notes.py check   # fails if an approved row has a hard flag
    python3 scripts/review_notes.py build   # writes data/public/journal-highlights.json

Decisions in the CSV are one of: publish, redact, drop. Empty means not
reviewed yet, and is treated as drop.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "trade_journal.json"
REVIEW_DIR = ROOT / "review"
REVIEW_CSV = REVIEW_DIR / "notes-review.csv"
REPORT = REVIEW_DIR / "report.md"
PUBLIC = ROOT / "data" / "public" / "journal-highlights.json"
CURATION = ROOT / "curation" / "notes-en.json"

# Hard flags block publication: a match is either a secret, an account
# identifier, a contact detail, or a link back to a private system.
HARD = [
    ("url", re.compile(r"https?://\S+|www\.\S+", re.I)),
    ("email", re.compile(r"[\w.+-]+@[\w-]+\.[\w.]{2,}")),
    ("evm_address", re.compile(r"\b0x[a-fA-F0-9]{40}\b")),
    ("btc_address", re.compile(r"\bbc1[a-z0-9]{25,}\b", re.I)),
    ("tron_address", re.compile(r"\bT[1-9A-HJ-NP-Za-km-z]{33}\b")),
    ("wallet_like", re.compile(r"\b[1-9A-HJ-NP-Za-km-z]{32,44}\b")),
    ("ip_address", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")),
    ("local_path", re.compile(r"(?:/home/|/Users/|[A-Za-z]:\\\\|~/|\.\.?/)")),
    ("secret_keyword", re.compile(
        r"(?i)\b(api[_ -]?key|secret|token|password|passwd|seed|mnemonic|"
        r"private[_ -]?key|bearer|webhook|authorization)\b")),
    ("discord_id", re.compile(
        r"cdn\.discordapp\.com|media\.discordapp\.net|discord\.gg|"
        r"discordapp\.com/api/webhooks|<@!?\d+>|@everyone|@here", re.I)),
    ("phone", re.compile(r"\+\d[\d\s().-]{7,}\d")),
    ("iban", re.compile(r"\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}\b")),
    ("long_number", re.compile(r"(?<![\d.])\d{9,}(?![\d.])")),
    ("api_token", re.compile(r"\b(?:sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{10,}\b")),
]

# Soft flags do not block, but each one is a reason to look at the row.
SOFT = [
    ("money", re.compile(
        r"(?i)(?:\$|€|£)\s?\d[\d\s,.]*|\b\d[\d\s,.]*\s?(?:usd|usdc|usdt|eur|gbp)\b")),
    ("account_word", re.compile(
        r"(?i)\b(account|compte|balance|solde|wallet|portefeuille|collateral|"
        r"marge|margin|equity)\b")),
    ("clock_time", re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?\b")),
    ("bot_id", re.compile(r"(?i)\b(?:trade|order|position)\s*(?:id|#)\s*[:=]?\s*\w+")),
    ("large_number", re.compile(
        r"(?<![\d.])(?!19\d{2}\b|20\d{2}\b)\d{4,}(?:[.,]\d+)?(?![\d.])")),
]

DECISIONS = {"publish", "redact", "drop"}


def load_rows() -> list[dict]:
    with DATA.open(encoding="utf-8") as fh:
        return json.load(fh)["trades"]


def flags_for(text: str) -> tuple[list[str], list[str]]:
    hard = [name for name, rx in HARD if rx.search(text or "")]
    soft = [name for name, rx in SOFT if rx.search(text or "")]
    return hard, soft


def collect_items(rows: list[dict]) -> list[dict]:
    """Return one item per unique note or caption.

    The export repeats a trade across several rows (up to 101 copies), so the
    same journal entry can appear many times. Deduplicating on
    (trade, kind, author, text, timestamp) keeps the queue reviewable.
    """
    by_trade = defaultdict(list)
    for row in rows:
        by_trade[row["tradeId"]].append(row)

    items = []
    for trade_id, copies in sorted(by_trade.items()):
        pair = copies[0].get("pairName", "")
        seen = set()
        counters = Counter()
        for row in copies:
            journal = row.get("journal") or {}
            for note in journal.get("notes") or []:
                key = ("note", note.get("author", ""), note.get("text", ""),
                       note.get("timestamp", ""))
                if key in seen:
                    continue
                seen.add(key)
                counters["note"] += 1
                items.append({
                    "item_id": f"t{trade_id}-note-{counters['note']}",
                    "trade_id": trade_id,
                    "pair": pair,
                    "kind": "note",
                    "author": note.get("author", ""),
                    "timestamp": note.get("timestamp", ""),
                    "text": note.get("text", ""),
                })
            for image in journal.get("images") or []:
                key = ("image-caption", "", image.get("description", "") or "",
                       image.get("timestamp", ""))
                if key in seen:
                    continue
                seen.add(key)
                counters["image-caption"] += 1
                items.append({
                    "item_id": f"t{trade_id}-image-{counters['image-caption']}",
                    "trade_id": trade_id,
                    "pair": pair,
                    "kind": "image-caption",
                    "author": "",
                    "timestamp": image.get("timestamp", ""),
                    "text": image.get("description", "") or "",
                })
    return items


def representative(copies: list[dict]) -> dict:
    """Pick the most complete row for a trade ID (closed first)."""
    closed = [r for r in copies if r.get("closeTime")]
    pool = closed or copies
    return max(pool, key=lambda r: r.get("profit") or 0)


def write_csv(items: list[dict]) -> Counter:
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    hard_counts, soft_counts = Counter(), Counter()
    with REVIEW_CSV.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow([
            "item_id", "trade_id", "pair", "kind", "author", "timestamp",
            "hard_flags", "soft_flags", "decision", "text",
        ])
        for item in items:
            hard, soft = flags_for(item["text"])
            hard_counts.update(hard)
            soft_counts.update(soft)
            writer.writerow([
                item["item_id"], item["trade_id"], item["pair"], item["kind"],
                item["author"], item["timestamp"], ";".join(hard), ";".join(soft),
                "", item["text"],
            ])
    return hard_counts, soft_counts


def snippet(text: str, limit: int = 120) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def write_report(rows: list[dict], items: list[dict], hard: Counter, soft: Counter) -> None:
    notes = [i for i in items if i["kind"] == "note"]
    captions = [i for i in items if i["kind"] == "image-caption"]
    hard_rows = [i for i in items if flags_for(i["text"])[0]]
    soft_rows = [i for i in items if flags_for(i["text"])[1]]

    lines = []
    add = lines.append
    add("# Journal notes review\n")
    add("Generated by `scripts/review_notes.py audit`. Working file: "
        "`review/notes-review.csv` (gitignored).\n")

    add("## Scope\n")
    add(f"- Rows in export: **{len(rows)}**")
    add(f"- Unique trade IDs: **{len({r['tradeId'] for r in rows})}**")
    add(f"- Notes after deduplicating repeated rows: **{len(notes)}** "
        f"({sum(1 for i in notes if i['author'] == 'System')} System / "
        f"{sum(1 for i in notes if i['author'] == 'User')} User)")
    add(f"- Image captions after deduplicating: **{len(captions)}** "
        f"({sum(1 for i in captions if i['text'].strip())} non-empty)")
    add(f"- Items with a hard flag: **{len(hard_rows)}**")
    add(f"- Items with only soft flags: **{len(soft_rows) - len(hard_rows)}**\n")
    add("> The export is not 1,059 distinct trades. It contains 98 trade IDs, "
        "some repeated up to 101 times, so the same journal entry can appear "
        "in dozens of rows. The counts above are unique. Reviewing row by row "
        "would triple the work and invite approving a duplicate you had "
        "already rejected.\n")

    add("## Hard flags\n")
    if hard:
        add("| Flag | Matches |")
        add("|---|---|")
        for name, count in hard.most_common():
            add(f"| `{name}` | {count} |")
        add("")
        add("Any row in this table must be dropped or redacted, not approved:\n")
        for item in hard_rows[:40]:
            names = ",".join(flags_for(item["text"])[0])
            add(f"- `{item['item_id']}` [{names}] {snippet(item['text'])}")
        if len(hard_rows) > 40:
            add(f"- … {len(hard_rows) - 40} more in the CSV")
    else:
        add("No URLs, emails, wallet addresses, phone numbers, local paths, "
            "secret keywords, Discord identifiers, or long account-like "
            "numbers were found in the note or caption text.")
    add("")

    add("## Soft flags\n")
    if soft:
        add("| Flag | Matches |")
        add("|---|---|")
        for name, count in soft.most_common():
            add(f"| `{name}` | {count} |")
        add("")
        add("Soft flags are context, not guilt. Amounts and exact times are "
            "still account information, so decide per row.\n")
        seen = defaultdict(int)
        for item in soft_rows:
            names = flags_for(item["text"])[1]
            for name in names:
                if seen[name] < 3:
                    seen[name] += 1
                    add(f"- `{name}` · `{item['item_id']}` {snippet(item['text'], 100)}")
        add("")
    else:
        add("No amount or time-of-day strings found.\n")

    add("## Exposure outside the note text\n")
    add("Approving every note does not make the export safe. The row itself "
        "carries account-relevant fields:\n")
    add("| Field | Why it matters |")
    add("|---|---|")
    add("| `collateralAmount` | posted size per trade |")
    add("| `leverage` | risk setting |")
    add("| `openPrice`, `closePrice`, `sl`, `tp` | exact execution levels |")
    add("| `initDate`, `closeTime` | exact timestamps, hence trading hours and timezone |")
    add("| `profit`, `profitPercentage` | per-trade result |")
    add("| `journal.chartPath` | filename linking a trade to a private screenshot |")
    add("| `tradeId` | internal bot identifier, repeated in System notes |")
    add("")
    add("Publishing `data/trade_journal.json` therefore publishes the account "
        "history even when every note is clean. If the journal was not written "
        "for publication, do not publish the raw export.\n")

    add("## Recommended publication model\n")
    add("1. Keep `data/trade_journal.json`, `review/`, and `evidence/raw/` out "
        "of version control. They are working data, not portfolio material.")
    add("2. Publish `results/metrics.json` (aggregates only) and a short "
        "hand-written highlights page with a few approved notes.")
    add("3. If you want a data-shaped file, build it from explicit decisions: "
        "`python3 scripts/review_notes.py build`. It emits pair, side, date, "
        "and approved text only — no prices, size, leverage, P&L, or IDs.")
    add("4. Screenshots are a separate gate. Each one can show balances, "
        "account names, browser tabs, or notifications; crop or drop it before "
        "it leaves `evidence/raw/`.\n")

    add("## Curation overrides\n")
    add("`curation/notes-en.json` carries the reviewed English replacements. "
        "A curated item is published without needing a CSV decision, and the "
        "`dropped` groups record the items excluded for risk, weak reasoning, "
        "or duplication. `check` re-scans every curated string as if it came "
        "from the export.\n")

    add("## Review protocol\n")
    add("- [ ] Work top to bottom in `review/notes-review.csv`; filter "
        "`hard_flags` first and set `decision=drop` on every hit.")
    add("- [ ] Read every `User` note and every non-empty caption; System notes "
        "only repeat price and trade ID, so they can usually be dropped wholesale.")
    add("- [ ] For each row you want to keep, ask: does this reveal size, P&L, "
        "timing, identity, or a third party? If yes, `redact` or `drop`.")
    add("- [ ] Run `check`; it refuses to pass if an approved row still has a "
        "hard flag.")
    add("- [ ] Only then run `build`, and read the output file once end to end.")
    add("- [ ] Review the images separately; do not assume a clean caption "
        "means a clean screenshot.\n")

    add("## Commands\n")
    add("```bash")
    add("cd journal")
    add("python3 scripts/review_notes.py audit   # refresh the queue")
    add("python3 scripts/review_notes.py check   # gate the current decisions")
    add("python3 scripts/review_notes.py build   # write the public subset")
    add("```")

    REPORT.write_text("\n".join(lines) + "\n", encoding="utf-8")


def read_decisions() -> list[dict]:
    if not REVIEW_CSV.exists():
        sys.exit(f"missing {REVIEW_CSV}; run `audit` first")
    with REVIEW_CSV.open(newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    bad = {r.get("decision", "") for r in rows} - DECISIONS - {""}
    if bad:
        sys.exit(f"unknown decisions: {sorted(bad)}")
    return rows


def load_curation() -> tuple[dict[str, str], set[str]]:
    """Return reviewed English replacements and the explicit drop list."""
    if not CURATION.exists():
        return {}, set()
    data = json.loads(CURATION.read_text(encoding="utf-8"))
    items = data.get("items") or {}
    dropped = {
        item_id
        for ids in (data.get("dropped") or {}).values()
        for item_id in ids
    }
    return items, dropped


def selected_rows(rows: list[dict], curation: tuple[dict[str, str], set[str]]) -> list[dict]:
    """Resolve curation overrides, then validate every approved text."""
    items, dropped = curation
    known = {r["item_id"] for r in rows}
    unknown = (set(items) | dropped) - known
    if unknown:
        sys.exit("curation references unknown item IDs: " + ", ".join(sorted(unknown)))
    overlap = set(items) & dropped
    if overlap:
        sys.exit("items are both kept and dropped: " + ", ".join(sorted(overlap)))

    selected, failures = [], []
    for row in rows:
        item = dict(row)
        if item["item_id"] in items:
            item["text"] = items[item["item_id"]]
            item["decision"] = "publish"
        elif item["item_id"] in dropped:
            continue
        elif item.get("decision") not in {"publish", "redact"}:
            continue

        hard, _ = flags_for(item["text"])
        if hard and item["decision"] == "publish":
            failures.append((item["item_id"], ",".join(hard)))
        selected.append(item)

    if failures:
        detail = "\n".join(f"  {i}: {f}" for i, f in failures)
        sys.exit("refusing to publish hard-flagged rows:\n" + detail)
    return selected


def redact(text: str) -> str:
    for _, rx in HARD:
        text = rx.sub("[redacted]", text)
    for name, rx in SOFT:
        if name in {"money", "large_number"}:
            text = rx.sub("[amount]", text)
    return " ".join(text.split())


def iso_day(value) -> str:
    if isinstance(value, (int, float)) and value > 0:
        from datetime import datetime, timezone
        return datetime.fromtimestamp(value / 1000, timezone.utc).date().isoformat()
    return (value or "")[:10]


def build(rows: list[dict], approved: list[dict]) -> None:
    by_trade = defaultdict(list)
    for item in approved:
        by_trade[int(item["trade_id"])].append(item)
    copies = defaultdict(list)
    for row in rows:
        copies[int(row["tradeId"])].append(row)

    trades = []
    for index, trade_id in enumerate(sorted(by_trade), start=1):
        source = representative(copies[trade_id])
        items = by_trade[trade_id]
        notes, captions = [], []
        for item in items:
            text = item["text"] if item["decision"] == "publish" else redact(item["text"])
            if not text.strip():
                continue
            entry = {
                "date": (item["timestamp"] or "")[:10],
                "text": text,
            }
            if item["kind"] == "note":
                entry["author"] = "bot" if item["author"] == "System" else "trader"
                notes.append(entry)
            else:
                captions.append(entry)
        trades.append({
            "ref": f"trade-{index:02d}",
            "pair": source.get("pairName", ""),
            "side": "long" if source.get("isLong") else "short",
            "date": iso_day(source.get("closeTime") or source.get("initDate")),
            "notes": notes,
            "captions": captions,
        })

    PUBLIC.parent.mkdir(parents=True, exist_ok=True)
    PUBLIC.write_text(json.dumps({
        "note": "Reviewed subset. Notes are edited English. No prices, size, leverage, P&L, or bot IDs.",
        "trades": trades,
    }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {PUBLIC.relative_to(ROOT)} ({len(trades)} trades, "
          f"{sum(len(t['notes']) for t in trades)} notes, "
          f"{sum(len(t['captions']) for t in trades)} captions)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["audit", "check", "build"])
    args = parser.parse_args()

    rows = load_rows()

    if args.command == "audit":
        items = collect_items(rows)
        hard, soft = write_csv(items)
        write_report(rows, items, hard, soft)
        print(f"review queue: {REVIEW_CSV.relative_to(ROOT)} ({len(items)} items)")
        print(f"report:       {REPORT.relative_to(ROOT)}")
        print(f"hard flags:   {sum(hard.values())} across {len(items)} items")
        print(f"soft flags:   {sum(soft.values())} across {len(items)} items")
        if hard:
            print("\nhard flags must be dropped or redacted before publication:")
            for name, count in hard.most_common():
                print(f"  {name}: {count}")
        return

    curation = load_curation()
    selected = selected_rows(read_decisions(), curation)
    if args.command == "check":
        print(f"ok: {len(selected)} selected items "
              f"({len(curation[0])} curated, {len(curation[1])} dropped), "
              "no hard-flagged publishes")
        return
    build(rows, selected)


if __name__ == "__main__":
    main()
