import { makeConfig } from './config';
import { createApp } from './http/app';
async function main() {
  const config = makeConfig();
  const { app, services, db } = await createApp(config);
  await app.listen(config.port, config.host);
  if (config.worker) services.worker.start();
  console.log(
    JSON.stringify({
      event: 'server.ready',
      port: config.port,
      database: config.databaseUrl ? 'postgresql' : 'pglite',
      devAuth: config.devAuth,
    }),
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await services.worker.stop();
    await app.close();
    await db.close();
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
