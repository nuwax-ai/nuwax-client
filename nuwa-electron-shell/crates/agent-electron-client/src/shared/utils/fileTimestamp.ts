/** Local wall-clock time, sortable and safe in filenames on every desktop platform. */
export function formatLocalFileTimestamp(date = new Date()): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}
