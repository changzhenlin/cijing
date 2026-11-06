import type { Entry, Rating } from '../shared/types';

export const DAY_MS = 86_400_000;
export const REMEMBER_INTERVALS = [1, 3, 7, 14, 30, 60] as const;

export function scheduleReview(entry: Entry, rating: Rating, masteryTarget: number, now: number): Entry {
  let streak = entry.streak;
  let interval: number;
  if (rating === 'forgot') {
    streak = 0;
    interval = 10 / (24 * 60);
  } else if (rating === 'hard') {
    interval = 1;
  } else {
    streak += 1;
    interval = REMEMBER_INTERVALS[Math.min(streak - 1, REMEMBER_INTERVALS.length - 1)];
  }
  return {
    ...entry, streak, interval, reviewCount: entry.reviewCount + 1,
    lastReviewedAt: now, updatedAt: now, nextReviewAt: now + interval * DAY_MS,
    status: rating === 'remember' && streak >= masteryTarget ? 'mastered' : 'learning',
  };
}
