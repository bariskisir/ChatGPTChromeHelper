/** Small background-event helpers for fire-and-forget Chrome listeners. */

/** Runs a background task and logs failures without breaking Chrome event handlers. */
export function runBackgroundTask(task: Promise<unknown> | unknown, label: string): void {
  Promise.resolve(task).catch((error: unknown) => {
    console.error(`${label} failed.`, error);
  });
}
