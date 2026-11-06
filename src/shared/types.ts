export type EntryType = 'word' | 'phrase' | 'sentence';
export type Rating = 'forgot' | 'hard' | 'remember';
export type EntryStatus = 'learning' | 'mastered';

export interface Source { title: string; url: string }
export interface Analysis {
  term: string;
  type: EntryType;
  phonetic: string;
  partOfSpeech: string;
  meaning: string;
  contextTranslation: string;
  example: { en: string; zh: string };
  technicalNote: string;
  sentenceAnalysis?: { skeleton: string; chunks: { text: string; role: string; meaning: string }[] };
}
export interface Entry extends Analysis {
  id: string;
  context: string;
  source: Source;
  createdAt: number;
  updatedAt: number;
  nextReviewAt: number;
  interval: number;
  streak: number;
  reviewCount: number;
  lastReviewedAt: number | null;
  status: EntryStatus;
  favorite: boolean;
}
export interface Settings {
  apiStyle: 'openai' | 'anthropic';
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
  autoSave: boolean;
  selectionMode: 'button' | 'auto';
  technicalPriority: boolean;
  dailyGoal: number;
  masteryTarget: number;
}
export interface ReviewLog { id: string; entryId: string; rating: Rating; at: number }
export interface Story { id: string; date: string; title: string; english: string; chinese: string; entryIds: string[] }
export interface AppState {
  schemaVersion: 1;
  entries: Entry[];
  settings: Settings;
  reviews: ReviewLog[];
  stories: Story[];
}
export interface AnalyzePayload { text: string; context: string; source: Source }
export interface ModelOption { id: string; name: string }
export type Request =
  | { type: 'GET_STATE' }
  | { type: 'GET_PUBLIC_SETTINGS' }
  | { type: 'SAVE_SETTINGS'; settings: Settings }
  | { type: 'TEST_CONNECTION'; settings: Settings }
  | { type: 'GET_MODELS'; settings: Settings }
  | { type: 'ANALYZE'; payload: AnalyzePayload }
  | { type: 'SAVE_ENTRY'; analysis: Analysis; payload: AnalyzePayload }
  | { type: 'REVIEW'; id: string; rating: Rating }
  | { type: 'UPDATE_ENTRY'; id: string; patch: Partial<Pick<Entry, 'favorite' | 'status'>> }
  | { type: 'DELETE_ENTRY'; id: string }
  | { type: 'IMPORT'; data: unknown }
  | { type: 'LOAD_EXAMPLES' }
  | { type: 'GENERATE_STORY'; entryIds: string[] }
  | { type: 'OPEN_APP'; page?: string };
export type Response<T = unknown> = { ok: true; data: T } | { ok: false; error: string };
export interface AnalyzeResult { analysis: Analysis; entry: Entry | null }
export type PublicSettings = Pick<Settings, 'enabled' | 'autoSave' | 'selectionMode'>;
export interface StorageAdapter {
  get(): Promise<AppState | undefined>;
  set(state: AppState): Promise<void>;
}
