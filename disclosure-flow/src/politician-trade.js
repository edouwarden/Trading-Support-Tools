import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = join(HERE, '..', 'results');

const ENDPOINT = 'https://politician-trade-tracker1.p.rapidapi.com/get_latest_trades';

/** Pull the newest disclosed politician trades. */
export async function fetchPoliticianTrades(apiKey) {
	if (!apiKey) throw new Error('RAPIDAPI_KEY is required for the live politician feed');

	const response = await fetch(ENDPOINT, {
		method: 'GET',
		headers: {
			'x-rapidapi-key': apiKey,
			'x-rapidapi-host': 'politician-trade-tracker1.p.rapidapi.com'
		}
	});

	if (!response.ok) {
		throw new Error(`Politician feed returned ${response.status} ${response.statusText}`);
	}

	const payload = await response.json();
	const trades = Array.isArray(payload) ? payload : payload.data ?? payload.trades;
	if (!Array.isArray(trades)) {
		throw new Error('Unexpected politician-feed shape: expected an array');
	}
	return trades;
}

/**
 * Lower bound of a disclosed amount range, in dollars.
 * Handles the feed's compact form ("1K-5K") and plain ranges ("$1,001 - $15,000").
 * Returns 0 when the amount cannot be parsed, so the aggregate stays honest
 * rather than silently treating an unknown as a large trade.
 */
export function lowerBoundAmount(value) {
	const compact = String(value ?? '').match(/([\d.]+)\s*K\s*-\s*([\d.]+)\s*K/i);
	if (compact) return Number.parseFloat(compact[1]) * 1000;

	const plain = String(value ?? '').match(/\$\s*([\d,]+)\s*-\s*\$\s*([\d,]+)/);
	if (plain) return Number.parseFloat(plain[1].replace(/,/g, ''));

	return 0;
}

/**
 * Aggregate politician trades by ticker, politician, and party.
 * Pure function: no network access, no file writes.
 */
export function analyzeTradeData(trades) {
	const tickerGroups = new Map();
	const politicianGroups = new Map();
	const partyGroups = { Republican: 0, Democrat: 0 };
	let latestTradeDate = null;
	let earliestTradeDate = null;

	for (const trade of trades) {
		const ticker = trade.ticker ?? 'UNKNOWN';
		const politician = trade.name ?? 'Unknown';
		const party = trade.party ?? 'Unknown';

		const tickerGroup = tickerGroups.get(ticker) ?? {
			company: trade.company ?? null,
			ticker,
			buyCount: 0,
			sellCount: 0,
			totalAmount: 0,
			politicians: new Set(),
			parties: new Set()
		};

		if (trade.trade_type === 'buy') tickerGroup.buyCount += 1;
		if (trade.trade_type === 'sell') tickerGroup.sellCount += 1;
		tickerGroup.totalAmount += lowerBoundAmount(trade.trade_amount);
		tickerGroup.politicians.add(politician);
		tickerGroup.parties.add(party);
		tickerGroups.set(ticker, tickerGroup);

		const politicianGroup = politicianGroups.get(politician) ?? {
			name: politician,
			party,
			chamber: trade.chamber ?? null,
			state: trade.state_name ?? null,
			tradeCount: 0,
			tickers: new Set()
		};
		politicianGroup.tradeCount += 1;
		politicianGroup.tickers.add(ticker);
		politicianGroups.set(politician, politicianGroup);

		if (partyGroups[party] !== undefined) partyGroups[party] += 1;

		const tradeDate = new Date(trade.trade_date);
		if (!Number.isNaN(tradeDate.getTime())) {
			if (!latestTradeDate || tradeDate > latestTradeDate) latestTradeDate = tradeDate;
			if (!earliestTradeDate || tradeDate < earliestTradeDate) earliestTradeDate = tradeDate;
		}
	}

	const tickers = [...tickerGroups.values()];
	const politicians = [...politicianGroups.values()];

	const topTickers = [...tickers]
		.sort((a, b) => b.buyCount + b.sellCount - (a.buyCount + a.sellCount))
		.slice(0, 5);

	const strongBuySignals = tickers
		.filter((ticker) => ticker.buyCount > ticker.sellCount && ticker.politicians.size >= 2)
		.sort((a, b) => b.buyCount - a.buyCount)
		.slice(0, 3);

	const strongSellSignals = tickers
		.filter((ticker) => ticker.sellCount > ticker.buyCount && ticker.politicians.size >= 2)
		.sort((a, b) => b.sellCount - a.sellCount)
		.slice(0, 3);

	const topPoliticians = [...politicians]
		.sort((a, b) => b.tradeCount - a.tradeCount)
		.slice(0, 3);

	const today = new Date();
	const daysSinceLatestTrade = latestTradeDate
		? Math.floor((today - latestTradeDate) / (1000 * 60 * 60 * 24))
		: null;

	return {
		topTickers,
		strongBuySignals,
		strongSellSignals,
		topPoliticians,
		partyBreakdown: partyGroups,
		daysSinceLatestTrade,
		totalTrades: trades.length,
		latestTradeDate,
		earliestTradeDate
	};
}

const serializeTicker = (ticker) => ({
	...ticker,
	politicians: [...ticker.politicians],
	parties: [...ticker.parties]
});

const serializePolitician = (politician) => ({
	...politician,
	tickers: [...politician.tickers]
});

export function buildPoliticianReport(trades) {
	const analysis = analyzeTradeData(trades);
	return {
		title: 'Politician Trade Intelligence',
		topTickers: analysis.topTickers.map(serializeTicker),
		strongBuySignals: analysis.strongBuySignals.map(serializeTicker),
		strongSellSignals: analysis.strongSellSignals.map(serializeTicker),
		topPoliticians: analysis.topPoliticians.map(serializePolitician),
		partyBreakdown: analysis.partyBreakdown,
		daysSinceLatestTrade: analysis.daysSinceLatestTrade,
		totalTrades: analysis.totalTrades,
		latestTradeDate: analysis.latestTradeDate?.toISOString() ?? null,
		earliestTradeDate: analysis.earliestTradeDate?.toISOString() ?? null,
		source: 'Politician Trade Tracker via RapidAPI',
		generatedAt: new Date().toISOString()
	};
}

export async function writePoliticianReport(report) {
	await mkdir(RESULTS_DIR, { recursive: true });
	const out = join(RESULTS_DIR, 'politician-trades.json');
	await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
	return out;
}
