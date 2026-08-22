// The database lives here, not on the main thread.
//
// OPFS synchronous access handles — the only way to persist SQLite without
// COOP/COEP headers — exist solely inside Workers. Keeping every query here
// also keeps the UI thread free.

import sqlite3InitModule from '../vendor/sqlite3.mjs'
import * as Q from './queries.js'
import { plan } from './csv.js'

const FILE = '/prm.sqlite3'

let db = null
let pool = null

/** The little interface queries.js is written against.
 *  sqlite-wasm throws "no bindable parameters" if given a bind list for a
 *  statement that takes none, so empty binds are omitted rather than passed. */
const args = (sql, bind, extra) =>
  bind && bind.length ? { sql, bind, ...extra } : { sql, ...extra }

const q = {
  all: (sql, bind) => db.exec(args(sql, bind, { rowMode: 'object', returnValue: 'resultRows' })),
  one: (sql, bind) => q.all(sql, bind)[0] ?? null,
  value: (sql, bind) => (bind && bind.length ? db.selectValue(sql, bind) : db.selectValue(sql)),
  run: (sql, bind) => void db.exec(args(sql, bind)),
  exec: (sql) => void db.exec(sql),
  insert: (sql, bind) => {
    db.exec(args(sql, bind))
    return db.selectValue('SELECT last_insert_rowid()')
  },
  tx(fn) {
    db.exec('BEGIN')
    try {
      const out = fn()
      db.exec('COMMIT')
      return out
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  },
}

async function boot() {
  const sqlite3 = await sqlite3InitModule()
  pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'prm' })
  db = new pool.OpfsSAHPoolDb(FILE)
  db.exec('PRAGMA foreign_keys = ON')
  Q.migrate(q)
}

/** Everything the UI is allowed to ask for. */
const API = {
  today: () => Q.today(q),
  counts: () => Q.counts(q),

  home: () => {
    const day = Q.today(q)
    return { day, ...Q.splitDue(Q.cadenced(q, day)) }
  },

  listContacts: (filter) => ({
    rows: Q.listContacts(q, filter),
    tags: Q.allTags(q),
  }),

  getContact: (id) => {
    const contact = Q.getContact(q, id)
    if (!contact) return null
    return {
      contact,
      tags: Q.contactTags(q, id),
      timeline: Q.timeline(q, id),
      today: Q.today(q),
    }
  },

  saveContact: (form) => Q.saveContact(q, form),
  toggleArchived: (id) => Q.toggleArchived(q, id),
  deleteContact: (id) => Q.deleteContact(q, id),

  saveInteraction: (form) => Q.saveInteraction(q, form),
  deleteInteraction: (id) => Q.deleteInteraction(q, id),
  interactionOwner: (id) => Q.interactionOwner(q, id),

  touch: (id) => Q.touch(q, id),
  snooze: (id, days) => Q.snooze(q, id, days),

  planImport: (text) => plan(text, Q.existing(q)),
  runImport: (rows) => Q.importRows(q, rows),

  exportDb: () => pool.exportFile(FILE),
  importDb: async (bytes) => {
    db.close()
    await pool.importDb(FILE, bytes)
    db = new pool.OpfsSAHPoolDb(FILE)
    db.exec('PRAGMA foreign_keys = ON')
    Q.migrate(q)
    return Q.counts(q)
  },
  wipe: async () => {
    db.close()
    await pool.wipeFiles()
    db = new pool.OpfsSAHPoolDb(FILE)
    db.exec('PRAGMA foreign_keys = ON')
    Q.migrate(q)
  },
}

const ready = boot()

self.onmessage = async ({ data: { id, op, args } }) => {
  try {
    await ready
    const fn = API[op]
    if (!fn) throw new Error(`unknown operation: ${op}`)
    const result = await fn(...(args ?? []))
    self.postMessage({ id, ok: true, result })
  } catch (e) {
    self.postMessage({ id, ok: false, error: e?.message ?? String(e) })
  }
}
