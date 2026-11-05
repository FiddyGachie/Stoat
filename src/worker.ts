import 'dotenv/config';
import { initDb, getDb } from './db/connection.js';

const WORKER_ID = `worker-${process.pid}`;
const POLL_INTERVAL_MS = parseInt(process.env.WORKER_POLL_INTERVAL_MS || '2000', 10);
const MAX_ATTEMPTS = parseInt(process.env.WORKER_MAX_ATTEMPTS || '5', 10);

async function claimJob(db: Awaited<ReturnType<typeof getDb>>) {
  const res = await db.query<{
    id: string; type: string; payload: any; attempts: number;
  }>(`
    WITH candidate AS (
      SELECT id FROM jobs
      WHERE status = 'queued' AND run_after <= now()
      ORDER BY priority DESC, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE jobs
    SET status = 'running', locked_at = now(), locked_by = $1, attempts = attempts + 1
    WHERE id IN (SELECT id FROM candidate)
    RETURNING id, type, payload, attempts
  `, [WORKER_ID]);
  return res.rows[0] ?? null;
}

async function markJobDone(db: Awaited<ReturnType<typeof getDb>>, id: string) {
  await db.query(`UPDATE jobs SET status = 'succeeded', completed_at = now() WHERE id = $1`, [id]);
}

async function markJobFailed(db: Awaited<ReturnType<typeof getDb>>, id: string, err: Error, attempts: number) {
  if (attempts >= MAX_ATTEMPTS) {
    await db.query(
      `UPDATE jobs SET status = 'dead', error = $1, completed_at = now() WHERE id = $2`,
      [err.message, id]
    );
    console.error(`[Worker] Job ${id} dead after ${attempts} attempts: ${err.message}`);
  } else {
    const backoffSecs = Math.min(30 * Math.pow(2, attempts - 1), 3600);
    await db.query(
      `UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL,
       run_after = now() + ($1 * interval '1 second'), error = $2 WHERE id = $3`,
      [backoffSecs, err.message, id]
    );
  }
}

async function handleJob(job: { id: string; type: string; payload: any }) {
  console.log(`[Worker] Handling job ${job.id} type=${job.type}`);
  switch (job.type) {
    case 'noop':
      break;
    default:
      throw new Error(`Unknown job type: ${job.type}`);
  }
}

async function runWorker() {
  console.log(`[Worker] Starting worker ${WORKER_ID}`);
  initDb();
  const db = getDb();

  // Reclaim stale locks on startup
  await db.query(
    `UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL
     WHERE status = 'running' AND locked_at < now() - interval '5 minutes'`
  );

  while (true) {
    try {
      const job = await claimJob(db);
      if (job) {
        try {
          await handleJob(job);
          await markJobDone(db, job.id);
          console.log(`[Worker] Job ${job.id} succeeded`);
        } catch (err: unknown) {
          await markJobFailed(db, job.id, err as Error, job.attempts);
        }
      } else {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    } catch (err) {
      console.error('[Worker] Poll error:', err);
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS * 2));
    }
  }
}

runWorker().catch((err) => {
  console.error('[Worker] Fatal:', err);
  process.exit(1);
});
