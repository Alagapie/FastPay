// Turns what the customer said about "when" into calendar days in their timezone.
// This is plain code, not the AI, so "yesterday" always means the same thing.
// Days are 'YYYY-MM-DD' strings in the customer's timezone.

const MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6,
  july: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
};
const MONTH_RE = `(${Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|')})\\.?`;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WORD_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const NUM_WORD = '(\\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten)';
const toNum = (s) => (/\d/.test(s) ? Number(s) : WORD_NUM[s]);

const parts = (ymd) => ymd.split('-').map(Number);

function makeYmd(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

export function addDays(ymd, n) {
  const [y, m, d] = parts(ymd);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const weekdayOf = (ymd) => {
  const [y, m, d] = parts(ymd);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

export const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && makeYmd(...parts(s)) !== null;

/** The calendar day an instant falls on, in `tz`. */
export function localDate(instant, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(instant))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

function offsetMinutes(tz, instant) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(new Date(instant))
    .find((x) => x.type === 'timeZoneName')?.value;
  const m = name?.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}

/** The UTC instant at which local day `ymd` starts in `tz`. */
export function startOfLocalDay(ymd, tz) {
  const [y, m, d] = parts(ymd);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetMinutes(tz, guess) * 60_000;
  t = guess - offsetMinutes(tz, t) * 60_000; // second pass handles a DST change near midnight
  return new Date(t);
}

/** { from, to } local days -> { start, end } UTC ISO instants, end exclusive. */
export function rangeToUtc(range, tz) {
  return { start: startOfLocalDay(range.from, tz).toISOString(), end: startOfLocalDay(addDays(range.to, 1), tz).toISOString() };
}

export function formatLocal(iso, tz) {
  if (!iso) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(iso));
}

export function formatDay(ymd) {
  const [y, m, d] = parts(ymd);
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

export function describeRange(range) {
  if (!range) return null;
  return range.from === range.to ? formatDay(range.from) : `${formatDay(range.from)} to ${formatDay(range.to)}`;
}

/**
 * Find a date expression in `text` and return { from, to, label } in local days, or null.
 * Never returns days in the future.
 */
export function resolveDatePhrase(text, now, tz) {
  if (!text) return null;
  const p = String(text).toLowerCase();
  const today = localDate(now, tz);
  const one = (d, label) => (d && d <= today ? { from: d, to: d, label: label ?? `on ${formatDay(d)}` } : null);
  const range = (from, to, label) => ({ from, to: to > today ? today : to, label });
  let m;

  // Explicit dates first: 2026-11-11, 11/11/2026 (day first, as written in Nigeria), 11 Nov, Nov 11th
  if ((m = p.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/))) {
    const r = one(makeYmd(+m[1], +m[2], +m[3]));
    if (r) return r;
  }
  if ((m = p.match(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4}|\d{2})\b/))) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const r = one(makeYmd(y, +m[2], +m[1]));
    if (r) return r;
  }
  const dayMonth = p.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MONTH_RE}(?:,?\\s+(\\d{4}))?\\b`));
  const monthDay = p.match(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`));
  for (const [label, day, mon, year] of [
    dayMonth && [dayMonth[0], dayMonth[1], dayMonth[2], dayMonth[3]],
    monthDay && [monthDay[0], monthDay[2], monthDay[1], monthDay[3]],
  ].filter(Boolean)) {
    const month = MONTHS[mon];
    const thisYear = Number(today.slice(0, 4));
    let d = makeYmd(year ? +year : thisYear, month, +day);
    if (d && !year && d > today) d = makeYmd(thisYear - 1, month, +day); // "Dec 30" said in January
    const r = one(d);
    if (r) return r;
  }

  // Relative days
  if (/\bday before yesterday\b/.test(p)) return one(addDays(today, -2), 'the day before yesterday');
  if (/\blast night\b/.test(p)) return range(addDays(today, -1), today, 'last night');
  if (/\byesterday\b/.test(p)) return one(addDays(today, -1), 'yesterday');
  if (/\b(\d+|an?|few|couple of)\s*(mins?|minutes?|hours?|hrs?)\s+ago\b/.test(p)) return range(addDays(today, -1), today, 'a few hours ago');
  if (/\b(today|this (morning|afternoon|evening)|tonight|earlier today|just now|(a )?(short|little) (time|while) ago|moments? ago|recently)\b/.test(p)) return one(today, 'today');
  if ((m = p.match(new RegExp(`\\b${NUM_WORD}\\s+days?\\s+ago\\b`)))) {
    const n = toNum(m[1]);
    if (n >= 0 && n <= 366) return one(addDays(today, -n), m[0]);
  }
  if (/\b(a\s+)?couple\s+(of\s+)?days\s+ago\b/.test(p)) return range(addDays(today, -3), addDays(today, -1), 'a couple of days ago');
  if (/\b(a\s+)?few\s+days\s+ago\b/.test(p)) return range(addDays(today, -6), addDays(today, -1), 'a few days ago');
  if ((m = p.match(new RegExp(`\\b${NUM_WORD}\\s+weeks?\\s+ago\\b`)))) {
    const n = toNum(m[1]);
    if (n >= 1 && n <= 52) return range(addDays(today, -7 * n - 3), addDays(today, -7 * n + 3), m[0]);
  }

  const mondayThisWeek = addDays(today, -((weekdayOf(today) + 6) % 7));
  if (/\blast\s+week\b/.test(p)) return range(addDays(mondayThisWeek, -7), addDays(mondayThisWeek, -1), 'last week');
  if (/\bthis\s+week\b/.test(p)) return range(mondayThisWeek, today, 'this week');

  const [y, mo] = parts(today);
  if (/\blast\s+month\b/.test(p)) {
    const first = makeYmd(mo === 1 ? y - 1 : y, mo === 1 ? 12 : mo - 1, 1);
    return range(first, addDays(makeYmd(y, mo, 1), -1), 'last month');
  }
  if (/\bthis\s+month\b/.test(p)) return range(makeYmd(y, mo, 1), today, 'this month');

  if ((m = p.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/))) {
    let back = (weekdayOf(today) - WEEKDAYS.indexOf(m[1]) + 7) % 7;
    if (back === 0) back = 7; // "on Monday" said on a Monday means last Monday
    return one(addDays(today, -back), `on ${m[1][0].toUpperCase()}${m[1].slice(1)}`);
  }
  return null;
}
