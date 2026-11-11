import { describe, expect, it } from 'vitest';
import { formatLocalFileTimestamp } from './fileTimestamp';

describe('local file timestamp', () => {
  it.each([
    [new Date(2026, 10, 11, 17, 33, 0, 714), '2026-11-11_17-33-00-714'],
    [new Date(2027, 0, 1, 0, 2, 3, 4), '2027-01-01_00-02-03-004'],
  ])('formats the local calendar and clock without UTC markers or forbidden filename characters', (date, expected) => {
    expect(formatLocalFileTimestamp(date)).toBe(expected);
  });
});
