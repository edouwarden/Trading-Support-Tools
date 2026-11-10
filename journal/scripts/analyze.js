#!/usr/bin/env node
/**
 * Aggregate the betterGTrade execution journal.
 *
 * The export contains every order the bot created, so most rows are not
 * completed trades. A row is counted as a realised trade only when its
 * `profit` field is non-zero. `pnl` is unusable in this export: every value
 * is zero.
 *
 * Usage:
 *   node scripts/analyze.js
 *
 * Writes results/metrics.json and prints a compact summary.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SOURCE = join(ROOT, 'data', 'trade_journal.json');
const OUT = join(ROOT, 'results', 'metrics.json');

const round = (value, digits = 2) =>
	Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

const toMillis = (value) => {
	if (value == null) return null;
	if (typeof value === 'number') return value;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
};

const median = (values) => {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const uniqueJournalItems = (entries, field, keys) => {
	const seen = new Set();
	for (const trade of entries) {
		for (const item of trade.journal?.[field] ?? []) {
			const key = [trade.tradeId, ...keys.map((name) => item[name] ?? '')].join('\u0000');
			seen.add(key);
		}
	}
	return seen.size;
};

const groupStats = (trades, key) => {
	const groups = new Map();
	for (const trade of trades) {
		const name = trade[key] ?? 'Unknown';
		const group = groups.get(name) ?? { count: 0, wins: 0, losses: 0, profit: 0 };
		group.count += 1;
		group.profit += trade.profit;
		if (trade.profit > 0) group.wins += 1;
		if (trade.profit < 0) group.losses += 1;
		groups.set(name, group);
	}
	return [...groups.entries()]
		.map(([name, group]) => ({
			name,
			count: group.count,
			wins: group.wins,
			losses: group.losses,
			winRate: round((group.wins / group.count) * 100, 2),
			profit: round(group.profit)
		}))
		.sort((a, b) => b.count - a.count || b.profit - a.profit);
};

async function main() {
	const raw = JSON.parse(await readFile(SOURCE, 'utf8'));
	const entries = Array.isArray(raw) ? raw : raw.trades;

	if (!Array.isArray(entries)) {
		throw new Error('Unexpected journal shape: expected an array or { trades: [] }');
	}

	const closed = entries.filter((trade) => trade.closeTime);
	const realised = entries.filter(
		(trade) => typeof trade.profit === 'number' && trade.profit !== 0
	);
	const wins = realised.filter((trade) => trade.profit > 0);
	const losses = realised.filter((trade) => trade.profit < 0);

	const holdingMinutes = realised
		.map((trade) => {
			const opened = toMillis(trade.initDate);
			const closedAt = toMillis(trade.closeTime);
			return opened != null && closedAt != null ? (closedAt - opened) / 60_000 : null;
		})
		.filter((value) => value != null && value >= 0);

	const entryDates = entries
		.map((trade) => toMillis(trade.initDate))
		.filter((value) => value != null);
	const firstDate = entryDates.length ? new Date(Math.min(...entryDates)) : null;
	const lastDate = entryDates.length ? new Date(Math.max(...entryDates)) : null;

	const totalProfit = realised.reduce((sum, trade) => sum + trade.profit, 0);
	const grossProfit = wins.reduce((sum, trade) => sum + trade.profit, 0);
	const grossLoss = losses.reduce((sum, trade) => sum + trade.profit, 0);

	const metrics = {
		generatedAt: new Date().toISOString(),
		source: 'data/trade_journal.json',
		period: {
			from: firstDate ? firstDate.toISOString().slice(0, 10) : null,
			to: lastDate ? lastDate.toISOString().slice(0, 10) : null
		},
		counts: {
			entries: entries.length,
			tradeIds: new Set(entries.map((trade) => trade.tradeId)).size,
			closed: closed.length,
			realised: realised.length,
			wins: wins.length,
			losses: losses.length,
			notes: uniqueJournalItems(entries, 'notes', ['author', 'text', 'timestamp']),
			imageReferences: uniqueJournalItems(entries, 'images', ['description', 'timestamp'])
		},
		profit: {
			currency: 'USD (journal field, unreconciled)',
			net: round(totalProfit),
			grossProfit: round(grossProfit),
			grossLoss: round(grossLoss),
			averageWin: round(wins.length ? grossProfit / wins.length : 0),
			averageLoss: round(losses.length ? grossLoss / losses.length : 0),
			best: round(realised.length ? Math.max(...realised.map((t) => t.profit)) : 0),
			worst: round(realised.length ? Math.min(...realised.map((t) => t.profit)) : 0),
			winRate: round(realised.length ? (wins.length / realised.length) * 100 : 0),
			profitFactor:
				grossLoss !== 0 ? round(grossProfit / Math.abs(grossLoss)) : null
		},
		holding: {
			medianMinutes: round(median(holdingMinutes), 1),
			minMinutes: round(holdingMinutes.length ? Math.min(...holdingMinutes) : 0, 1),
			maxMinutes: round(holdingMinutes.length ? Math.max(...holdingMinutes) : 0, 1)
		},
		byDayOfWeek: groupStats(realised, 'dayOfWeek'),
		byPair: groupStats(realised, 'pairName')
	};

	await mkdir(dirname(OUT), { recursive: true });
	await writeFile(OUT, `${JSON.stringify(metrics, null, 2)}\n`);

	console.log('betterGTrade journal');
	console.log(`  entries              ${metrics.counts.entries}`);
	console.log(`  trade ids            ${metrics.counts.tradeIds}`);
	console.log(`  closed               ${metrics.counts.closed}`);
	console.log(`  realised (profit≠0)  ${metrics.counts.realised}`);
	console.log(`  wins / losses        ${metrics.counts.wins} / ${metrics.counts.losses}`);
	console.log(`  net profit (journal) ${metrics.profit.net}`);
	console.log(`  win rate             ${metrics.profit.winRate}%`);
	console.log(`  median hold          ${metrics.holding.medianMinutes} min`);
	console.log(`  period               ${metrics.period.from} → ${metrics.period.to}`);
	console.log(`  wrote                ${OUT}`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
