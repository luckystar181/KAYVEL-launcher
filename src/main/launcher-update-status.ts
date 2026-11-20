export type LauncherUpdateStatus = {
  state: 'unchecked' | 'checking' | 'unavailable' | 'current' | 'available' | 'downloading' | 'installer-open' | 'error';
  installedVersion: string;
  latestVersion: string | null;
  message: string;
};
