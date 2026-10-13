import { api } from '../api';

/** Preferences are owned by the current application's SQLite metadata. */
export async function loadPreference<T>(key: string, fallback: T): Promise<T> {
  return (await api.getSetting<T>(key)) ?? fallback;
}
