export interface BusinessHourRule {
  /** 0 = Sunday … 6 = Saturday */
  day: number;
  open: string; // "09:00"
  close: string; // "18:00"
  enabled: boolean;
}

export const DEFAULT_BUSINESS_HOURS: BusinessHourRule[] = [
  { day: 0, open: '09:00', close: '18:00', enabled: false },
  { day: 1, open: '09:00', close: '18:00', enabled: true },
  { day: 2, open: '09:00', close: '18:00', enabled: true },
  { day: 3, open: '09:00', close: '18:00', enabled: true },
  { day: 4, open: '09:00', close: '18:00', enabled: true },
  { day: 5, open: '09:00', close: '18:00', enabled: true },
  { day: 6, open: '10:00', close: '16:00', enabled: false },
];

export function parseBusinessHours(value: unknown): BusinessHourRule[] {
  if (!Array.isArray(value)) return DEFAULT_BUSINESS_HOURS;
  const rules = value.filter(
    (r): r is BusinessHourRule =>
      typeof r === 'object' &&
      r !== null &&
      typeof (r as BusinessHourRule).day === 'number' &&
      typeof (r as BusinessHourRule).open === 'string' &&
      typeof (r as BusinessHourRule).close === 'string',
  );
  return rules.length ? rules : DEFAULT_BUSINESS_HOURS;
}

/**
 * Evaluates the organization's opening hours in its own timezone, so a
 * business in Dhaka and one in Berlin both get correct answers from a single
 * UTC server (spec sections 6, 19 and 24).
 */
export function isWithinBusinessHours(
  businessHours: unknown,
  timezone = 'UTC',
  at: Date = new Date(),
): boolean {
  const rules = parseBusinessHours(businessHours);
  const local = localParts(at, timezone);
  const rule = rules.find((r) => r.day === local.weekday);

  if (!rule || !rule.enabled) return false;

  const now = local.hour * 60 + local.minute;
  const open = toMinutes(rule.open);
  const close = toMinutes(rule.close);

  if (open === null || close === null) return false;
  // Overnight shifts (e.g. 22:00–02:00) wrap past midnight.
  if (close <= open) return now >= open || now < close;
  return now >= open && now < close;
}

function toMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

interface LocalParts {
  weekday: number;
  hour: number;
  minute: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function localParts(date: Date, timezone: string): LocalParts {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const weekdayLabel = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    return {
      weekday: Math.max(0, WEEKDAYS.indexOf(weekdayLabel)),
      // Intl renders midnight as "24" in some locales/runtimes.
      hour: hour === 24 ? 0 : hour,
      minute,
    };
  } catch {
    return { weekday: date.getUTCDay(), hour: date.getUTCHours(), minute: date.getUTCMinutes() };
  }
}

export function formatBusinessHoursSummary(businessHours: unknown): string {
  const rules = parseBusinessHours(businessHours);
  const open = rules.filter((r) => r.enabled);
  if (!open.length) return 'No opening hours set';
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return open.map((r) => `${names[r.day]} ${r.open}–${r.close}`).join(', ');
}
