// Version-keyed state for the community update reminder. The dialog shows
// once per release version: any dismissal records the version as SEEN and the
// reminder collapses to a compact strip above the nav rail's account row.
// Confirming the update records the version as UPDATED, which retires both
// surfaces until a newer version ships. Mirrors the whats-new highlight
// pattern (see ./whats-new.ts).

export const UPDATE_REMINDER_SEEN_STORAGE_KEY = 'od-update-reminder-seen-version';
export const UPDATE_REMINDER_UPDATED_STORAGE_KEY = 'od-update-reminder-updated-version';

export function readSeenUpdateReminderVersion(
  storage: Pick<Storage, 'getItem'> = window.localStorage,
): string | null {
  try {
    const value = storage.getItem(UPDATE_REMINDER_SEEN_STORAGE_KEY);
    return value != null && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function markUpdateReminderSeen(
  version: string,
  storage: Pick<Storage, 'setItem'> = window.localStorage,
): void {
  try {
    storage.setItem(UPDATE_REMINDER_SEEN_STORAGE_KEY, version);
  } catch {
    // Private-mode storage failures just mean the reminder may show again.
  }
}

export function readUpdatedUpdateReminderVersion(
  storage: Pick<Storage, 'getItem'> = window.localStorage,
): string | null {
  try {
    const value = storage.getItem(UPDATE_REMINDER_UPDATED_STORAGE_KEY);
    return value != null && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function markUpdateReminderUpdated(
  version: string,
  storage: Pick<Storage, 'setItem'> = window.localStorage,
): void {
  try {
    storage.setItem(UPDATE_REMINDER_UPDATED_STORAGE_KEY, version);
  } catch {
    // Private-mode storage failures just mean the strip may show again.
  }
}
