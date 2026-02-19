/**
 * Shared formatting utilities
 */

/**
 * Format milliseconds as human-readable duration
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${String(days)}d ${String(hours % 24)}h`;
  }
  if (hours > 0) {
    return `${String(hours)}h ${String(minutes % 60)}m`;
  }
  if (minutes > 0) {
    return `${String(minutes)}m ${String(seconds % 60)}s`;
  }
  return `${String(seconds)}s`;
}

/**
 * Format bytes as human-readable size
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${String(Math.round((bytes / 1024) * 10) / 10)} KB`;
  }
  return `${String(Math.round((bytes / (1024 * 1024)) * 10) / 10)} MB`;
}
