import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = join(HERE, '..', 'results');

const ENDPOINT = 'https://mboum-finance.p.rapidapi.com/v1/markets/insider-trades';

const parseUsd = (value) => {
	const parsed = Number.parseFloat(String(value ?? '').replace(/,/g, ''));
	return Number.isFinite(parsed) ? parsed : 0;
};

const latestTransactionDate = (trades) => {
	const dates = trades
		.map((trade) => Date.parse(trade.transactionDate))
		.filter((value) => !Number.isNaN(value));
	return dates.length ? new Date(Math.max(...dates)).toLocaleDateString('en-US', {
		year: '2-digit',
		month: '2-digit',
		day: '2-digit'
	}) : null;
};

/** Fetch the raw insider-trade list from Mboum Finance. */
export async function fetchInsiderTrades(apiKey) {
	if (!apiKey) throw new Error('RAPIDAPI_KEY is required for the live insider feed');

	const response = await fetch(ENDPOINT, {
		method: 'GET',
		headers: {
			'x-rapidapi-key': apiKey,
			'x-rapidapi-host': 'mboum-finance.p.rapidapi.com'
		}
	});

	if (!response.ok) {
		throw new Error(`Insider feed returned ${response.status} ${response.statusText}`);
	}

	const payload = await response.json();
	if (!Array.isArray(payload.body)) {
		throw new Error('Unexpected insider-feed shape: expected { body: [] }');
	}
	return payload.body;
}

/**
 * Turn raw insider rows into a compact report.
 * `targetDate` uses the feed's MM/DD/YY format. When omitted, the most recent
 * transaction date in the sample is used (handy for the offline demo).
 */
export function buildInsiderReport(rawTrades, targetDate = null) {
	const date = targetDate ?? latestTransactionDate(rawTrades);
	const trades = rawTrades.filter((trade) => trade.transactionDate === date);

	const sortedTrades = [...trades]
		.sort((a, b) => parseUsd(b.usdValue) - parseUsd(a.usdValue))
		.slice(0, 10);

	const rows = sortedTrades.map((trade, index) => ({
		rank: index + 1,
		symbol: trade.symbol,
		company: trade.symbolName,
		insider: trade.fullName,
		role: trade.shortJobTitle && trade.shortJobTitle !== 'N/A' ? trade.shortJobTitle : null,
		transactionType: trade.transactionType,
		emoji: String(trade.transactionType).toLowerCase() === 'sell' ? 'RED' : 'GREEN',
		amount: trade.amount,
		reportedPrice: Number.parseFloat(trade.reportedPrice),
		usdValue: parseUsd(trade.usdValue),
		transactionDate: trade.transactionDate
	}));

	const totals = trades.reduce(
		(acc, trade) => {
			const value = parseUsd(trade.usdValue);
			if (String(trade.transactionType).toLowerCase() === 'sell') {
				acc.totalSell += value;
				acc.totalSellCount += 1;
			} else {
				acc.totalBuy += value;
				acc.totalBuyCount += 1;
			}
			return acc;
		},
		{ totalBuy: 0, totalSell: 0, totalBuyCount: 0, totalSellCount: 0 }
	);

	return {
		title: "Today's Top Insider Trades",
		description:
			'Latest insider trading activities from company executives and major shareholders.',
		date,
		trades: rows,
		totals,
		source: 'Mboum Finance API via RapidAPI',
		generatedAt: new Date().toISOString()
	};
}

export async function writeInsiderReport(report) {
	await mkdir(RESULTS_DIR, { recursive: true });
	const out = join(RESULTS_DIR, 'insider-trades.json');
	await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
	return out;
}
