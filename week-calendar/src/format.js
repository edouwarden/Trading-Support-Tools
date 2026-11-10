/** Output formats for normalised calendar events. */

import { groupByDay } from './calendar.js';

const pad = (value) => String(value).padStart(2, '0');

const dayLabel = (date) =>
	new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', {
		weekday: 'short',
		day: '2-digit',
		month: 'short',
		timeZone: 'UTC'
	});

const eventLine = (event) => {
	const et = `${event.timeLocal} ET`;
	const utc = `${event.dateUtc.slice(11, 16)} UTC`;
	const details = [
		event.forecast ? `forecast ${event.forecast}` : null,
		event.previous ? `previous ${event.previous}` : null
	]
		.filter(Boolean)
		.join(', ');

	return `  ${et} / ${utc}  ${event.country}  ${event.title}${details ? `  (${details})` : ''}`;
};

/** Compact human-readable weekly view. */
export function formatText(events, { from, to, impacts } = {}) {
	const impactLabel = impacts?.length ? impacts.join(', ') : 'High';
	const header = `Macro calendar — ${from} → ${to} (${impactLabel} impact)`;
	if (events.length === 0) return `${header}\n\nNo events match.\n`;

	const days = groupByDay(events);
	const blocks = days.map(({ date, events: dayEvents }) => {
		const lines = dayEvents.map(eventLine);
		return `${dayLabel(date)}\n${lines.join('\n')}`;
	});

	return `${header}\n${events.length} event${events.length === 1 ? '' : 's'}\n\n${blocks.join('\n\n')}\n`;
}

const csvCell = (value) => {
	const text = String(value ?? '');
	return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** One row per event. Times are UTC; the ET time is included for convenience. */
export function formatCsv(events) {
	const header = [
		'date_utc',
		'date_local',
		'time_et',
		'country',
		'impact',
		'title',
		'forecast',
		'previous'
	];
	const rows = events.map((event) => [
		event.dateUtc,
		event.dateLocal,
		event.timeLocal,
		event.country,
		event.impact,
		event.title,
		event.forecast,
		event.previous
	]);
	return `${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

/** Structured JSON with metadata, not only the event list. */
export function buildJson(events, { from, to, impacts, source, fetchedAt } = {}) {
	return {
		source,
		fetchedAt,
		range: { from, to },
		impacts,
		count: events.length,
		events,
		byDay: groupByDay(events)
	};
}

const icsEscape = (value) =>
	String(value ?? '')
		.replace(/\\/g, '\\\\')
		.replace(/\n/g, '\\n')
		.replace(/,/g, '\\,')
		.replace(/;/g, '\\;');

const icsUtcStamp = (date) =>
	`${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T` +
	`${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;

const slug = (value) =>
	String(value)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 40);

/**
 * RFC 5545 calendar. DTSTART uses UTC so the file does not depend on the
 * reader's timezone database. Each event gets a 30-minute block.
 */
export function formatIcs(events, { now = new Date(), calendarName = 'Week calendar' } = {}) {
	const lines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//week-calendar//EN',
		'CALSCALE:GREGORIAN',
		'METHOD:PUBLISH',
		`X-WR-CALNAME:${icsEscape(calendarName)}`,
		'X-WR-TIMEZONE:America/New_York'
	];

	for (const event of events) {
		const start = new Date(event.dateUtc);
		const end = new Date(start.getTime() + 30 * 60 * 1000);
		const uid = `${slug(event.title)}-${start.getTime()}@week-calendar`;
		const description = [
			`Impact: ${event.impact}`,
			event.forecast ? `Forecast: ${event.forecast}` : null,
			event.previous ? `Previous: ${event.previous}` : null,
			`Source time: ${event.timeLocal} ET`
		]
			.filter(Boolean)
			.join('\n');

		lines.push(
			'BEGIN:VEVENT',
			`UID:${uid}`,
			`DTSTAMP:${icsUtcStamp(now)}`,
			`DTSTART:${icsUtcStamp(start)}`,
			`DTEND:${icsUtcStamp(end)}`,
			`SUMMARY:${icsEscape(`[${event.country}] ${event.title}`)}`,
			`DESCRIPTION:${icsEscape(description)}`,
			'END:VEVENT'
		);
	}

	lines.push('END:VCALENDAR');
	return `${lines.join('\r\n')}\r\n`;
}
