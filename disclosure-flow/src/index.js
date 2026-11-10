#!/usr/bin/env node
/**
 * disclosure-flow runner.
 *
 *   --demo          Run both trackers against the committed sample data (no key).
 *   --insider       Fetch and report insider trades.
 *   --politician    Fetch and report politician trades.
 *   --all           Fetch both live feeds.
 *
 * Live modes require RAPIDAPI_KEY in the environment.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	fetchInsiderTrades,
	buildInsiderReport,
	writeInsiderReport
} from './insider.js';
import {
	fetchPoliticianTrades,
	buildPoliticianReport,
	writePoliticianReport
} from './politician-trade.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(HERE, '..', 'data', 'sample');

const flags = new Set(process.argv.slice(2));
const demo = flags.has('--demo');
const insider = flags.has('--insider') || flags.has('--all');
const politician = flags.has('--politician') || flags.has('--all');

const readSample = async (name) =>
	JSON.parse(await readFile(join(SAMPLES, name), 'utf8'));

async function runDemo() {
	const insiderRaw = await readSample('insider-trades.json');
	const politicianRaw = await readSample('politician-trades.json');

	const insiderReport = buildInsiderReport(insiderRaw);
	const insiderPath = await writeInsiderReport(insiderReport);
	console.log(`insider     ${insiderReport.trades.length} rows → ${insiderPath}`);

	const politicianReport = buildPoliticianReport(politicianRaw);
	const politicianPath = await writePoliticianReport(politicianReport);
	console.log(
		`politician  ${politicianReport.totalTrades} trades, ` +
			`${politicianReport.topTickers.length} tickers → ${politicianPath}`
	);
}

async function runLive() {
	const apiKey = process.env.RAPIDAPI_KEY;
	if (!apiKey) {
		throw new Error(
			'RAPIDAPI_KEY is not set. Use --demo for the offline sample, or export the key.'
		);
	}

	if (insider) {
		const raw = await fetchInsiderTrades(apiKey);
		const report = buildInsiderReport(raw);
		const out = await writeInsiderReport(report);
		console.log(`insider     ${report.trades.length} rows → ${out}`);
	}

	if (politician) {
		const raw = await fetchPoliticianTrades(apiKey);
		const report = buildPoliticianReport(raw);
		const out = await writePoliticianReport(report);
		console.log(`politician  ${report.totalTrades} trades → ${out}`);
	}
}

function usage() {
	console.log(`Usage: node src/index.js <mode>

  --demo          run both trackers against data/sample/ (no API key)
  --insider       fetch insider trades (requires RAPIDAPI_KEY)
  --politician    fetch politician trades (requires RAPIDAPI_KEY)
  --all           fetch both live feeds`);
}

async function main() {
	if (demo) return runDemo();
	if (insider || politician) return runLive();
	usage();
}

main().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});
