import 'dotenv/config';
import { initDb, getDb } from './db/connection.js';
import { startPaymentSweeps } from './modules/payments/sweep.js';
import { startJobRunner } from './jobs/runner.js';

// Dedicated background process: jobs (hosted provider reviews) and payment sweeps.
// The API process runs the same loops unless RUN_JOBS_IN_API=false; SKIP LOCKED keeps them from colliding.
initDb();
const db = getDb();
console.log(`[Worker] Starting worker ${process.pid}`);
startPaymentSweeps(db);
startJobRunner(db, { workerId: `worker-${process.pid}` });

import './modules/wallet/wallet.service.js'; // registers the wallet balance check hook
