/**
 * Calendar fetching and normalisation.
 *
 * The Fair Economy feed publishes US-Eastern ISO timestamps, for example
 * `2026-11-09T08:30:00-05:00`. We keep three representations:
 *
 *   date        original string from the feed
 *   dateUtc     canonical UTC instant
 *   dateLocal   calendar date in the source timezone (what a trader calls
 *               "Monday's session")
 *
 * Grouping uses `dateLocal`, so an 08:30 ET release stays on Monday even
 * though it is 13:30 UTC.
 */

export const SOURCE_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
export const SOURCE_TIMEZONE = 'America/New_York';
export const IMPACTS = ['High', 'Medium', 'Low', 'Non-Economic', 'Unknown'];

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const pad = (value) => String(value).padStart(2, '0');
const isoDate = (date) =>
	`${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

/** Validate a YYYY-MM-DD argument and return it unchanged. */
export function parseDateArg(value, name = 'date') {
	if (!DATE_ONLY.test(value ?? '')) {
		throw new Error(`${name} must be YYYY-MM-DD, got ${JSON.stringify(value)}`);
	}
	const [year, month, day] = value.split('-').map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	if (
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day
	) {
		throw new Error(`${name} is not a real calendar date: ${value}`);
	}
	return value;
}

/** Calendar date in a named timezone. */
export function dateInTimeZone(now, timeZone) {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat('en-CA', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			weekday: 'short'
		})
			.formatToParts(now)
			.map((part) => [part.type, part.value])
	);
	return {
		date: `${parts.year}-${parts.month}-${parts.day}`,
		weekday: parts.weekday
	};
}

/** Monday-to-Sunday range for the week containing `now`, in the source timezone. */
export function thisWeekRange(now = new Date(), timeZone = SOURCE_TIMEZONE) {
	const { date, weekday } = dateInTimeZone(now, timeZone);
	const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
	if (index === -1) throw new Error(`Unexpected weekday: ${weekday}`);

	const [year, month, day] = date.split('-').map(Number);
	const monday = new Date(Date.UTC(year, month - 1, day));
	monday.setUTCDate(monday.getUTCDate() - ((index + 6) % 7));

	const sunday = new Date(monday);
	sunday.setUTCDate(sunday.getUTCDate() + 6);

	return { from: isoDate(monday), to: isoDate(sunday) };
}

/** Normalise one raw feed row. Throws on malformed timestamps. */
export function parseEvent(raw) {
	if (!raw || typeof raw.title !== 'string' || !raw.title.trim()) {
		throw new Error('Calendar event is missing a title');
	}
	if (!ISO_WITH_OFFSET.test(raw.date ?? '')) {
		throw new Error(
			`Event ${JSON.stringify(raw.title)} has no ISO offset in date: ${JSON.stringify(raw.date)}`
		);
	}

	const instant = new Date(raw.date);
	if (Number.isNaN(instant.getTime())) {
		throw new Error(`Invalid date on event ${JSON.stringify(raw.title)}: ${raw.date}`);
	}

	const [dateLocal, timeLocal] = raw.date.split('T');

	return {
		title: raw.title.trim(),
		country: (raw.country ?? 'XXX').trim().toUpperCase(),
		impact: raw.impact?.trim() || 'Unknown',
		forecast: raw.forecast ?? '',
		previous: raw.previous ?? '',
		date: raw.date,
		dateUtc: instant.toISOString(),
		dateLocal,
		timeLocal: timeLocal.slice(0, 5)
	};
}

export function parseEvents(rawRows) {
	if (!Array.isArray(rawRows)) {
		throw new Error('Expected the feed to be a JSON array');
	}
	return rawRows.map(parseEvent);
}

/** Filter by source-local calendar date and impact. */
export function filterEvents(events, { from, to, impacts } = {}) {
	const allowed = new Set(
		(impacts && impacts.length ? impacts : ['High']).map((value) => value.toLowerCase())
	);
	return events.filter((event) => {
		if (from && event.dateLocal < from) return false;
		if (to && event.dateLocal > to) return false;
		return allowed.has(event.impact.toLowerCase());
	});
}

/** Group events by source-local date, chronologically. */
export function groupByDay(events) {
	const days = new Map();
	for (const event of events) {
		const list = days.get(event.dateLocal) ?? [];
		list.push(event);
		days.set(event.dateLocal, list);
	}
	return [...days.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, list]) => ({
			date,
			events: list.sort((a, b) => a.dateUtc.localeCompare(b.dateUtc))
		}));
}

/** Fetch the current week's feed. */
export async function fetchCalendar(url = SOURCE_URL, fetchImpl = fetch) {
	const response = await fetchImpl(url, {
		headers: {
			accept: 'application/json',
			'user-agent': 'week-calendar/1.0'
		}
	});
	if (!response.ok) {
		throw new Error(`Calendar feed returned ${response.status} ${response.statusText}`);
	}
	return parseEvents(await response.json());
}
