// `komorebi-render serve`: the API and the worker loop in one process, one worker. The listen comes first so that a taken port
// stops the start before the worker has touched a job; the worker's own start-up (requeue what was running) follows.
import { createApi, listen } from './api.js';
import { createWorker } from './worker.js';
import { createOutputRootCheck } from './netmount.js';

export async function serve({ store, config, pin, prepare, log = console.log, workerOptions = {} }) {
  const checkOut = workerOptions.checkOut ?? createOutputRootCheck(config.out, { allowLocal: config.allowLocal });
  const worker = createWorker({ store, config, log, prepare, ...workerOptions, checkOut });
  const server = await listen(createApi({ store, config, pin, log, checkOut }), { host: config.host, port: config.port });
  log(`komorebi-render listening on ${config.host}:${server.address().port}`);
  let closing;
  const close = () => {
    if (!closing) {
      server.closeAllConnections();
      closing = new Promise((resolve) => server.close(resolve));
    }
    return closing;
  };
  const finished = worker.run().catch(async (error) => {
    await worker.stop();
    await close();
    throw error;
  });
  finished.catch(() => {});   // the caller awaits `finished`; this only keeps an early failure from being unhandled meanwhile

  // The worker first (a running exporter is stopped and its job goes back in the queue), then the door.
  async function stop() {
    await worker.stop();
    await finished.catch(() => {});
    await close();
  }
  return { server, worker, finished, stop };
}
