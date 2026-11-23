'use strict';
// Time in Asia/Bahrain. Bahrain is UTC+3 all year, but this reads the zone from
// Intl so it stays right if that ever changes. Every decision about Fridays,
// quiet hours and "today" goes through here; the clock itself is injectable.

const TZ = 'Asia/Bahrain';
const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function bahrainParts(ms) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, weekday: WD[p.weekday] };
}
const pad = n => String(n).padStart(2, '0');
const bahrainDate = ms => { const p = bahrainParts(ms); return `${p.year}-${pad(p.month)}-${pad(p.day)}`; };
const isFriday = ms => bahrainParts(ms).weekday === 5;
const weekdayOfDate = isoDate => new Date(isoDate + 'T12:00:00Z').getUTCDay();
const toMin = hhmm => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };

/** Quiet hours [start, end) in Bahrain time; wraps midnight when start > end. Equal = no quiet hours. */
function inQuietHours(ms, { start, end }) {
  const p = bahrainParts(ms), now = p.hour * 60 + p.minute, s = toMin(start), e = toMin(end);
  if (s === e) return false;
  return s < e ? (now >= s && now < e) : (now >= s || now < e);
}
/** The UTC instant of a Bahrain wall-clock time (offset read from Intl at that date). */
function bahrainInstant(isoDate, hhmm) {
  const guess = Date.parse(`${isoDate}T${hhmm}:00Z`);
  const p = bahrainParts(guess);
  const offsetMin = (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - guess) / 6e4;
  return guess - offsetMin * 6e4;
}
/** Whole Bahrain calendar days from Day 0 (yyyy-mm-dd) to the instant ms. */
const dayIndex = (startIso, ms) => Math.round((Date.parse(bahrainDate(ms) + 'T00:00:00Z') - Date.parse(startIso + 'T00:00:00Z')) / 864e5);
const addDaysIso = (isoDate, n) => new Date(Date.parse(isoDate + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const shortDate = isoDate => new Date(isoDate + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

const systemClock = { now: () => Date.now() };
function fakeClock(start) {
  let t = typeof start === 'number' ? start : Date.parse(start);
  return { now: () => t, advance: ms => { t += ms; return t; }, set: v => { t = typeof v === 'number' ? v : Date.parse(v); return t; } };
}

module.exports = { TZ, bahrainParts, bahrainDate, isFriday, weekdayOfDate, inQuietHours, bahrainInstant, dayIndex, addDaysIso, shortDate, systemClock, fakeClock };
