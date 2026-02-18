/**
 * Job completion notification service for OpenClaw webhook integration
 */

export interface JobCompletionEvent {
  jobId: string;
  sessionKey: string;
  status: "completed" | "failed" | "cancelled";
  elapsedSeconds: number;
  outputSize: number;
  exitCode: number | null;
  errorType: string | null;
}

export interface NotificationConfig {
  webhookUrl: string;
  webhookToken: string;
}

/**
 * Format a human-readable completion message
 */
function formatCompletionMessage(event: JobCompletionEvent): string {
  const statusEmoji =
    event.status === "completed" ? "✅" : event.status === "cancelled" ? "⚪" : "❌";

  const duration = formatDuration(event.elapsedSeconds);
  const outputSize = formatBytes(event.outputSize);

  let message = `🔔 Claude Code Job ${event.status === "completed" ? "Completed" : event.status === "cancelled" ? "Cancelled" : "Failed"}\n\n`;
  message += `Job: ${event.jobId}\n`;
  message += `Session: ${event.sessionKey}\n`;
  message += `Status: ${statusEmoji} ${event.status}\n`;
  message += `Duration: ${duration}\n`;
  message += `Output: ${outputSize}\n`;

  if (event.errorType) {
    message += `Error: ${event.errorType}`;
    if (event.exitCode !== null) {
      message += ` (exit code ${String(event.exitCode)})`;
    }
    message += "\n";
  }

  message += "\nUse claude_code_output to read the results.";

  return message;
}

/**
 * Format seconds as human-readable duration
 */
function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);

  if (mins > 0) {
    return `${String(mins)}m ${String(secs)}s`;
  }
  return `${String(secs)}s`;
}

/**
 * Format bytes as human-readable size
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${String(Math.round((bytes / 1024) * 10) / 10)} KB`;
  }
  return `${String(Math.round((bytes / (1024 * 1024)) * 10) / 10)} MB`;
}

/**
 * Send a job completion notification to OpenClaw via webhook
 */
export async function notifyJobCompletion(
  config: NotificationConfig,
  event: JobCompletionEvent
): Promise<void> {
  const message = formatCompletionMessage(event);

  const response = await fetch(config.webhookUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.webhookToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      sessionKey: `hook:claude-code:${event.sessionKey}`,
      wakeMode: "now",
      deliver: true,
      channel: "last",
    }),
  });

  if (!response.ok) {
    console.log(
      `[claude-code] Notification webhook failed: ${String(response.status)} ${response.statusText}`
    );
  }
}
