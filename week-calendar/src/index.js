#!/usr/bin/env node
/**
 * week-calendar CLI.
 *
 *   node src/index.js                 // this week, High impact, text
 *   node src/index.js --sample        // offline demo fixtures
 *   node src/index.js --impact High,Medium --format csv --out week.csv
 *   node src/index.js --from 2026-11-09 --to 2026-11-15 --format ics
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	SOURCE_URL,
	IMPACTS,
	parseEvents,
	filterEvents,
	fetchCalendar,
	parseDateArg,
	thisWeekRange
} from './calendar.js';
import { formatText, formatCsv, formatIcs, buildJson } from './format.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = join(HERE, '..', 'data', 'sample', 'ff_calendar_thisweek.json');

function parseArgs(argv) {
	const options = {
		sample: false,
		from: null,
		to: null,
		impacts: ['High'],
		format: 'text',
		out: null,
		url: SOURCE_URL
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const [flag, inline] = arg.split('=');
		const next = () => {
			if (inline !== undefined) return inline;
			i += 1;
			if (i >= argv.length) throw new Error(`${flag} needs a value`);
			return argv[i];
		};

		switch (flag) {
			case '--sample':
				options.sample = true;
				break;
			case '--from':
				options.from = parseDateArg(next(), '--from');
				break;
			case '--to':
				options.to = parseDateArg(next(), '--to');
				break;
			case '--impact': {
				const values = next()
					.split(',')
					.map((value) => value.trim())
					.filter(Boolean);
				options.impacts = values.map((value) => {
					const match = IMPACTS.find(
						(impact) => impact.toLowerCase() === value.toLowerCase()
					);
					if (!match) {
						throw new Error(`Unknown impact ${JSON.stringify(value)}; use ${IMPACTS.join(', ')}`);
					}
					return match;
				});
				break;
			}
			case '--all-impacts':
				options.impacts = [...IMPACTS];
				break;
			case '--format':
				options.format = next().toLowerCase();
				break;
			case '--out':
				options.out = next();
				break;
			case '--url':
				options.url = next();
				break;
			case '--help':
			case '-h':
				options.help = true;
				break;
			default:
				throw new Error(`Unknown option: ${arg}`);
		}
	}

	if (!['text', 'json', 'csv', 'ics'].includes(options.format)) {
		throw new Error(`Unknown format ${JSON.stringify(options.format)}; use text, json, csv, ics`);
	}
	if ((options.from === null) !== (options.to === null)) {
		throw new Error('--from and --to must be used together');
	}
	if (options.from && options.from > options.to) {
		throw new Error('--from must be before --to');
	}

	if (!options.out) {
		const extension = { json: '.json', csv: '.csv', ics: '.ics' }[options.format];
		if (extension) options.out = `week-calendar${extension}`;
	}

	return options;
}

function usage() {
	return `Usage: node src/index.js [options]

  --sample              Use data/sample/ff_calendar_thisweek.json (no network)
  --from YYYY-MM-DD     Start date (default: current Monday)
  --to YYYY-MM-DD       End date (default: current Sunday)
  --impact LIST         Comma-separated impacts (default: High)
  --all-impacts         Keep every impact level
  --format FORMAT       text | json | csv | ics (default: text)
  --out PATH            Write to PATH. Non-text formats default to a file.
  --url URL             Override the feed URL
  -h, --help            Show this help

The feed is published in US-Eastern time. Grouping uses the feed's calendar
date; every export also carries a UTC timestamp for each event.`;
}

async function loadEvents(options) {
	if (options.sample) {
		return {
			events: parseEvents(JSON.parse(await readFile(SAMPLE, 'utf8'))),
			source: 'data/sample/ff_calendar_thisweek.json',
			fetchedAt: null
		};
	}
	return {
		events: await fetchCalendar(options.url),
		source: options.url,
		fetchedAt: new Date().toISOString()
	};
}

function resolveRange(options, allEvents) {
	if (options.from) return { from: options.from, to: options.to };

	// The sample is a fixed week. Use the Monday-Sunday week around its first
	// event so the demo keeps working when the wall clock moves past the fixture.
	if (options.sample && allEvents.length) {
		const first = [...allEvents].map((event) => event.dateLocal).sort()[0];
		return thisWeekRange(new Date(`${first}T12:00:00Z`));
	}

	return thisWeekRange(new Date());
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(usage());
		return;
	}

	const { events: allEvents, source, fetchedAt } = await loadEvents(options);
	const { from, to } = resolveRange(options, allEvents);
	const events = filterEvents(allEvents, { from, to, impacts: options.impacts });

	let output;
	if (options.format === 'json') {
		output =
			JSON.stringify(
				buildJson(events, { from, to, impacts: options.impacts, source, fetchedAt }),
				null,
				2
			) + '\n';
	} else if (options.format === 'csv') {
		output = formatCsv(events);
	} else if (options.format === 'ics') {
		output = formatIcs(events, {
			now: fetchedAt ? new Date(fetchedAt) : new Date(),
			calendarName: `Macro calendar ${from} to ${to}`
		});
	} else {
		output = formatText(events, { from, to, impacts: options.impacts });
	}

	if (options.out) {
		const target = resolve(options.out);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, output);
		console.error(`Wrote ${events.length} event(s) to ${target}`);
	} else {
		process.stdout.write(output);
	}
}

main().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});
