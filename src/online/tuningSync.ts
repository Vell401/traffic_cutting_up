import { applyTuning, type GlobalTuning } from '../sim/tuning';

/** Online tuning belongs exclusively to welcome/tuning messages, never a late HTTP response. */
export async function syncHttpTuning(api: string, online: boolean): Promise<void> {
  if (online) return;
  try {
    const response = await fetch(`${api}/tuning`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (response.ok) applyTuning(await response.json() as GlobalTuning);
  } catch { /* Offline solo keeps the shipped defaults or the last successful settings. */ }
}
