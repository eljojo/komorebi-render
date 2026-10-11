// The job table. SQLite (node:sqlite) rather than JSON files because the CLI, the worker and the API are separate
// processes on one file: WAL and busy_timeout give them atomic, concurrent writes; the state machine below is guarded in SQL
// (every transition names the state it leaves), so two writers cannot both win a race.
import { DatabaseSync } from 'node:sqlite';
import { folderName } from './spec.js';
import { SEGMENT_SECONDS } from './exporter.js';
import { resolveQuality } from './quality.js';

export class StoreError extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  state TEXT NOT NULL,
  spec TEXT NOT NULL,
  quality TEXT NOT NULL,
  folder_name TEXT NOT NULL DEFAULT '',
  folder TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  seg_done INTEGER NOT NULL DEFAULT 0,
  seg_base INTEGER NOT NULL DEFAULT 0,
  seg_total INTEGER NOT NULL,
  last_line TEXT,
  result TEXT,
  error TEXT,
  pid INTEGER,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  blocked TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);`;

const hydrate = (row) => (row ? {
  ...row,
  spec: JSON.parse(row.spec),
  quality: JSON.parse(row.quality),
  result: row.result === null ? null : JSON.parse(row.result),
  cancel_requested: row.cancel_requested === 1,
} : null);

export function openStore(path, { now = () => new Date().toISOString() } = {}) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const get = (id) => hydrate(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
  const must = (id) => { const j = get(id); if (!j) throw new StoreError(`no job ${id}`); return j; };
  const move = (id, from, sql, params, what) => {
    const r = db.prepare(`UPDATE jobs SET ${sql} WHERE id = ? AND state = ?`).run(...params, id, from);
    if (r.changes !== 1) throw new StoreError(`job ${id} is not ${from}${what ? ` (cannot ${what})` : ''}`);
  };

  return {
    get,
    close: () => db.close(),

    create(spec) {
      const at = now();
      db.exec('BEGIN IMMEDIATE');
      try {
        const { lastInsertRowid } = db.prepare('INSERT INTO jobs (state, spec, quality, created_at, seg_total) VALUES (?, ?, ?, ?, ?)')
          .run('queued', JSON.stringify(spec), JSON.stringify(resolveQuality(spec)), at, Math.ceil(spec.seconds / SEGMENT_SECONDS));
        const id = Number(lastInsertRowid);
        db.prepare('UPDATE jobs SET folder_name = ? WHERE id = ?').run(folderName({ id, createdAt: at, spec }), id);
        db.exec('COMMIT');
        return get(id);
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },

    list({ state } = {}) {
      const rows = state ? db.prepare('SELECT * FROM jobs WHERE state = ? ORDER BY id DESC').all(state) : db.prepare('SELECT * FROM jobs ORDER BY id DESC').all();
      return rows.map(hydrate);
    },

    nextQueued: () => hydrate(db.prepare("SELECT * FROM jobs WHERE state = 'queued' ORDER BY id LIMIT 1").get()),

    // false when someone else (a cancel) took the job first
    start(id, { folder, base = 0 }) {
      const r = db.prepare("UPDATE jobs SET state = 'running', started_at = ?, finished_at = NULL, folder = ?, seg_base = ?, seg_done = ?, blocked = NULL, error = NULL, pid = NULL, attempts = attempts + 1 WHERE id = ? AND state = 'queued'")
        .run(now(), folder, base, base, id);
      return r.changes === 1;
    },
    setPid: (id, pid) => db.prepare('UPDATE jobs SET pid = ? WHERE id = ?').run(pid, id),
    progress: (id, { done, total, line }) => db.prepare('UPDATE jobs SET seg_done = ?, seg_total = COALESCE(?, seg_total), last_line = COALESCE(?, last_line) WHERE id = ?').run(done, total ?? null, line ?? null, id),

    finish: (id, result) => move(id, 'running', "state = 'done', finished_at = ?, result = ?, pid = NULL", [now(), JSON.stringify(result)], 'finish'),
    fail: (id, error) => move(id, 'running', "state = 'failed', finished_at = ?, error = ?, pid = NULL", [now(), error], 'fail'),
    cancelled: (id) => move(id, 'running', "state = 'cancelled', finished_at = ?, pid = NULL", [now()], 'cancel'),
    release: (id) => move(id, 'running', "state = 'queued', pid = NULL, cancel_requested = 0", [], 'release'),

    // queued: cancelled at once. running: asked here, done by whoever owns the child (the worker polls for it).
    requestCancel(id) {
      const j = must(id);
      if (j.state === 'queued') { move(id, 'queued', "state = 'cancelled', finished_at = ?", [now()], 'cancel'); return 'cancelled'; }
      if (j.state === 'running') { db.prepare('UPDATE jobs SET cancel_requested = 1 WHERE id = ?').run(id); return 'requested'; }
      throw new StoreError(`job ${id} is already ${j.state}`);
    },

    block: (id, reason) => db.prepare("UPDATE jobs SET blocked = ? WHERE id = ? AND state = 'queued'").run(reason, id),

    // Start-up: whatever was running died with the last process. It goes back in the queue, and the exporter resumes it from its
    // last committed segment; a cancel that was already asked for is honoured instead. Returns the rows as they were (pids included).
    requeueRunning() {
      const rows = db.prepare("SELECT * FROM jobs WHERE state = 'running' ORDER BY id").all().map(hydrate);
      for (const j of rows) {
        if (j.cancel_requested) move(j.id, 'running', "state = 'cancelled', finished_at = ?, pid = NULL", [now()], 'cancel');
        else move(j.id, 'running', "state = 'queued', pid = NULL", [], 'requeue');
      }
      return rows;
    },
  };
}
