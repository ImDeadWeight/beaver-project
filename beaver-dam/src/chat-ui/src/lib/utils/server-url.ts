import { Capacitor } from '@capacitor/core';
import { CONFIG_LOCALSTORAGE_KEY } from '$lib/constants/storage';
import { SETTINGS_KEYS } from '$lib/constants/settings-keys';

/** True when the app is running inside the Capacitor Android shell. */
export function isCapacitorAndroid(): boolean {
	return Capacitor.isNativePlatform();
}

/** True when running inside the Beaver Log Windows Electron app. */
export function isElectronLog(): boolean {
	return typeof window !== 'undefined' &&
		!!(window as Window & { beaverLogAPI?: unknown }).beaverLogAPI;
}

/**
 * Returns the user-configured server base URL when running inside a native
 * shell (Capacitor Android or Beaver Log Windows), where relative fetch paths
 * resolve to the local WebView/file-server origin rather than the llama server.
 * On plain web the function returns '' so existing relative-path behaviour is
 * preserved.
 *
 * Reads directly from localStorage to avoid a circular dependency with the
 * settings store (which itself calls services that use apiFetch).
 */
export function getServerBaseUrl(): string {
	if (!Capacitor.isNativePlatform() && !isElectronLog()) return '';
	try {
		const raw = localStorage.getItem(CONFIG_LOCALSTORAGE_KEY);
		const cfg = JSON.parse(raw || '{}') as Record<string, unknown>;
		const url = cfg[SETTINGS_KEYS.SERVER_URL];
		if (typeof url === 'string' && url.trim()) {
			const trimmed = url.trim().replace(/\/$/, '');
			// 0.0.0.0 is a server bind address, not a valid client destination —
			// treat it as unconfigured so auto-discovery runs on next launch.
			if (trimmed.includes('0.0.0.0')) return '';
			return trimmed;
		}
	} catch {
		// fall through
	}
	return '';
}
