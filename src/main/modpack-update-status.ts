export type ModpackUpdateStatus = {
  state: 'unchecked' | 'checking' | 'current' | 'available' | 'error' | 'updating' | 'not-installed';
  installedVersion: string | null;
  latestVersion: string | null;
  message: string;
};
