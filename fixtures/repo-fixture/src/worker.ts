export async function processJob(jobId: string): Promise<void> {
  // BUG-002: Unhandled Promise rejection - async operation not caught or returned
  Promise.reject(new Error(`Failed to process job ${jobId}`));
}
