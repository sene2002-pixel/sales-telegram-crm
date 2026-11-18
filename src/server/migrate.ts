import { makeConfig } from './config';
import { Database } from './infra/database';

async function migrate() {
  const config = makeConfig();
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
  const db = new Database(config);
  try {
    await db.init();
  } finally {
    await db.close();
  }
}
migrate().catch(() => {
  console.error('Database migration failed');
  process.exitCode = 1;
});
