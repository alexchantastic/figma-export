export interface ProgressEvent {
  phase:
    "auth" | "api" | "discovery" | "manifest" | "file" | "browser" | "download";
  message: string;
}
export type ProgressReporter = (event: ProgressEvent) => void;
/** CLI-only presentation; library operations stay silent unless a reporter is supplied. */
export function createProgressLogger(
  write: (line: string) => void,
  intervalMs = 15_000,
): { report: ProgressReporter; stop(): void } {
  let current: ProgressEvent | undefined;
  let started = Date.now();
  const report: ProgressReporter = (event) => {
    current = event;
    started = Date.now();
    write(
      "[" +
        new Date().toLocaleTimeString("en-GB") +
        "] " +
        event.message.replace(/\p{Cc}/gu, " "),
    );
  };
  const timer = setInterval(() => {
    if (current)
      write(
        "Still working (" +
          Math.floor((Date.now() - started) / 1000) +
          "s): " +
          current.message.replace(/\p{Cc}/gu, " "),
      );
  }, intervalMs);
  timer.unref();
  return {
    report,
    stop() {
      clearInterval(timer);
    },
  };
}
