import type { AppState, Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
  apiStyle: 'openai',
  apiBaseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-chat',
  enabled: true,
  autoSave: true,
  selectionMode: 'button',
  technicalPriority: true,
  dailyGoal: 10,
  masteryTarget: 4,
};

export function emptyState(): AppState {
  return { schemaVersion: 1, entries: [], settings: { ...DEFAULT_SETTINGS }, reviews: [], stories: [] };
}
