/** Campaign start: the expeditions' situation at the start of play. */
export const CAMPAIGN_START_UTC = Date.UTC(2000, 3, 17, 6, 0, 0); // 17 APR 2000 06:00

/** Real seconds -> campaign hours at 1x speed. */
export const CAMPAIGN_HOURS_PER_SECOND = 0.5;

export const SPEEDS = [0, 1, 2, 4] as const;
export type SpeedSetting = (typeof SPEEDS)[number];

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const pad2 = (n: number): string => (n < 10 ? '0' : '') + n;

export function campaignDate(hours: number): Date {
  return new Date(CAMPAIGN_START_UTC + hours * 3600_000);
}

/** e.g. "17 APR 2000 · 06:00" */
export function formatCampaignTime(hours: number): string {
  const d = campaignDate(hours);
  return `${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

export function formatCampaignDate(hours: number): string {
  const d = campaignDate(hours);
  return `${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Day number of the expedition (day 1 = first day). */
export function campaignDay(hours: number): number {
  return Math.floor(hours / 24) + 1;
}

/** "3h 20m" style duration. */
export function formatDuration(hours: number): string {
  const totalMin = Math.max(0, Math.round(hours * 60));
  const d = Math.floor(totalMin / (60 * 24));
  const h = Math.floor((totalMin % (60 * 24)) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${pad2(m)}m`;
  return `${m}m`;
}

/** mm:ss for battle clocks. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}
