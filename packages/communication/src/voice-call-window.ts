/**
 * When an outbound AI call may ring someone: 09:00–20:00 in the recipient's
 * local time, judged from the phone's country code. Countries spanning several
 * zones are checked in every one of their main zones (a call is placed only
 * when it is within hours everywhere the number could be). An unrecognised
 * country is not guessed at: the caller decides (see `known`).
 */
const ZONES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['1', ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles']],
  ['7', ['Europe/Moscow']],
  ['20', ['Africa/Cairo']],
  ['27', ['Africa/Johannesburg']],
  ['31', ['Europe/Amsterdam']],
  ['33', ['Europe/Paris']],
  ['34', ['Europe/Madrid']],
  ['39', ['Europe/Rome']],
  ['44', ['Europe/London']],
  ['49', ['Europe/Berlin']],
  ['52', ['America/Mexico_City']],
  ['55', ['America/Sao_Paulo']],
  ['60', ['Asia/Kuala_Lumpur']],
  ['61', ['Australia/Perth', 'Australia/Sydney']],
  ['62', ['Asia/Jakarta']],
  ['63', ['Asia/Manila']],
  ['64', ['Pacific/Auckland']],
  ['65', ['Asia/Singapore']],
  ['66', ['Asia/Bangkok']],
  ['81', ['Asia/Tokyo']],
  ['82', ['Asia/Seoul']],
  ['86', ['Asia/Shanghai']],
  ['90', ['Europe/Istanbul']],
  ['91', ['Asia/Kolkata']],
  ['92', ['Asia/Karachi']],
  ['94', ['Asia/Colombo']],
  ['234', ['Africa/Lagos']],
  ['254', ['Africa/Nairobi']],
  ['353', ['Europe/Dublin']],
  ['880', ['Asia/Dhaka']],
  ['966', ['Asia/Riyadh']],
  ['971', ['Asia/Dubai']],
  ['974', ['Asia/Qatar']],
  ['977', ['Asia/Kathmandu']],
];

export const VOICE_CALL_WINDOW = { startHour: 9, endHour: 20 } as const;

export interface VoiceCallWindowDecision {
  readonly known: boolean;
  readonly allowed: boolean;
  /** e.g. "21:40 Asia/Kolkata" (the zone that failed, or the first zone). */
  readonly localTime: string;
  readonly window: string;
}

function zonesFor(e164: string): readonly string[] | null {
  const digits = e164.replace(/[^0-9]/g, '');
  // Longest country code first (3, then 2, then 1 digits).
  for (const length of [3, 2, 1]) {
    const match = ZONES.find(([code]) => code.length === length && digits.startsWith(code));
    if (match) return match[1];
  }
  return null;
}

function localHourMinute(zone: string, at: Date): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(at);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  return { hour, minute };
}

export function evaluateVoiceCallWindow(e164: string, at: Date = new Date()): VoiceCallWindowDecision {
  const window = `${String(VOICE_CALL_WINDOW.startHour).padStart(2, '0')}:00–${VOICE_CALL_WINDOW.endHour}:00 local`;
  const zones = zonesFor(e164);
  if (zones === null) return { known: false, allowed: true, localTime: 'unknown', window };
  for (const zone of zones) {
    const { hour, minute } = localHourMinute(zone, at);
    const clock = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${zone}`;
    if (hour < VOICE_CALL_WINDOW.startHour || hour >= VOICE_CALL_WINDOW.endHour) {
      return { known: true, allowed: false, localTime: clock, window };
    }
  }
  const first = localHourMinute(zones[0]!, at);
  return {
    known: true,
    allowed: true,
    localTime: `${String(first.hour).padStart(2, '0')}:${String(first.minute).padStart(2, '0')} ${zones[0]}`,
    window,
  };
}
