/** Installed only by CLI operations. The library never intercepts application signals. */
export function installShutdown(
  controller: AbortController,
  report: (message: string) => void,
): () => void {
  let stopping = false;
  const stop = (code: number, message: string) => {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    report(
      message +
        "; stopping queues, closing browser and releasing owned locks safely...",
    );
    controller.abort(new Error(message));
  };
  const interrupt = () => stop(130, "Interrupted (SIGINT)");
  const terminate = () => stop(143, "Terminated (SIGTERM)");
  // On fatal errors, abort work, drain in-flight operations and then exit; do not resume normal work.
  const fatal = () => stop(1, "Fatal error");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
  return () => {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    process.off("uncaughtException", fatal);
    process.off("unhandledRejection", fatal);
  };
}
