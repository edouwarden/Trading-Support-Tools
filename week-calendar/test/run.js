/**
 * Dependency-free test runner. Works with `node test/run.js` and `bun test/run.js`.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	parseDateArg,
	parseEvent,
	parseEvents,
	filterEvents,
	groupByDay,
	thisWeekRange
} from '../src/calendar.js';
import { formatText, formatCsv, formatIcs, buildJson } from '../src/format.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = join(HERE, '..', 'data', 'sample', 'ff_calendar_thisweek.json');

let passed = 0;
let failed = 0;

function test(name, fn) {
	try {
		fn();
		passed += 1;
		console.log(`ok   ${name}`);
	} catch (error) {
		failed += 1;
		console.error(`FAIL ${name}\n     ${error.message}`);
	}
}

async function main() {
	const raw = JSON.parse(await readFile(SAMPLE, 'utf8'));
	const events = parseEvents(raw);

	test('parseDateArg accepts a real date', () => {
		assert.equal(parseDateArg('2026-11-09'), '2026-11-09');
	});

	test('parseDateArg rejects an impossible date', () => {
		assert.throws(() => parseDateArg('2026-02-30'), /not a real calendar date/);
	});

	test('parseDateArg rejects a loose format', () => {
		assert.throws(() => parseDateArg('09/11/2026'), /YYYY-MM-DD/);
	});

	test('thisWeekRange is Monday to Sunday', () => {
		const range = thisWeekRange(new Date('2026-11-11T12:00:00Z'));
		assert.deepEqual(range, { from: '2026-11-09', to: '2026-11-15' });
	});

	test('parseEvent keeps source date and converts to UTC', () => {
		const event = parseEvent({
			title: 'CPI m/m',
			country: 'usd',
			date: '2026-11-10T08:30:00-05:00',
			impact: 'High',
			forecast: '0.2%',
			previous: '0.1%'
		});
		assert.equal(event.dateUtc, '2026-11-10T13:30:00.000Z');
		assert.equal(event.dateLocal, '2026-11-10');
		assert.equal(event.timeLocal, '08:30');
		assert.equal(event.country, 'USD');
	});

	test('parseEvent rejects a timestamp without an offset', () => {
		assert.throws(
			() => parseEvent({ title: 'Bad', date: '2026-11-10T08:30:00', impact: 'High' }),
			/no ISO offset/
		);
	});

	test('filterEvents keeps the default High impact only', () => {
		const high = filterEvents(events, { from: '2026-11-09', to: '2026-11-15' });
		assert.ok(high.length > 0);
		assert.ok(high.every((event) => event.impact === 'High'));
	});

	test('filterEvents honours the range and an explicit impact list', () => {
		const medium = filterEvents(events, {
			from: '2026-11-09',
			to: '2026-11-09',
			impacts: ['Medium']
		});
		assert.equal(medium.length, 2);
		assert.ok(medium.every((event) => event.dateLocal === '2026-11-09'));
	});

	test('groupByDay is chronological and keeps events sorted inside a day', () => {
		const days = groupByDay(filterEvents(events, { from: '2026-11-09', to: '2026-11-13' }));
		const dates = days.map((day) => day.date);
		assert.deepEqual(dates, [...dates].sort());
		for (const day of days) {
			const times = day.events.map((event) => event.dateUtc);
			assert.deepEqual(times, [...times].sort());
		}
	});

	test('formatText names the range and includes an event', () => {
		const text = formatText(filterEvents(events, { from: '2026-11-09', to: '2026-11-15' }), {
			from: '2026-11-09',
			to: '2026-11-15',
			impacts: ['High']
		});
		assert.match(text, /2026-11-09 → 2026-11-15/);
		assert.match(text, /ECB President Lagarde Speaks/);
	});

	test('formatCsv escapes commas and quotes', () => {
		const csv = formatCsv([
			{
				...events[0],
				title: 'GDP q/q, "Preliminary"'
			}
		]);
		assert.match(csv, /"GDP q\/q, ""Preliminary"""/);
	});

	test('formatIcs writes a UTC DTSTART and CRLF lines', () => {
		const ics = formatIcs([events.find((event) => event.title === 'CPI m/m')], {
			now: new Date('2026-11-08T00:00:00Z')
		});
		assert.match(ics, /DTSTART:20261110T133000Z/);
		assert.match(ics, /\r\nEND:VCALENDAR\r\n$/);
		assert.match(ics, /SUMMARY:\[USD\] CPI m\/m/);
	});

	test('buildJson reports the filtered count', () => {
		const high = filterEvents(events, { from: '2026-11-09', to: '2026-11-15' });
		const json = buildJson(high, {
			from: '2026-11-09',
			to: '2026-11-15',
			impacts: ['High'],
			source: 'sample',
			fetchedAt: null
		});
		assert.equal(json.count, high.length);
		assert.equal(json.range.from, '2026-11-09');
	});

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
