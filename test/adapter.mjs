// Runs queries.js against node's built-in SQLite, so the exact SQL the browser
// executes is what the tests exercise. No dependencies.

import { DatabaseSync } from 'node:sqlite'
import * as Q from '../js/queries.js'

export function freshDb() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')

  const q = {
    all: (sql, bind = []) => db.prepare(sql).all(...bind),
    one: (sql, bind = []) => db.prepare(sql).get(...bind) ?? null,
    value: (sql, bind = []) => {
      const row = db.prepare(sql).get(...bind)
      return row === undefined ? undefined : Object.values(row)[0]
    },
    run: (sql, bind = []) => void db.prepare(sql).run(...bind),
    exec: (sql) => db.exec(sql),
    insert: (sql, bind = []) => Number(db.prepare(sql).run(...bind).lastInsertRowid),
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

  Q.migrate(q)
  return q
}

/** A contact with a cadence whose last interaction was `lastSeen`. */
export function tracked(q, name, cadence, lastSeen, created = '2020-01-01') {
  const id = q.insert(
    'INSERT INTO contacts (name, cadence_days, created_at) VALUES (?, ?, ?)',
    [name, cadence, created],
  )
  if (lastSeen) log(q, id, 'call', '', lastSeen)
  return id
}

export function log(q, contactId, kind, body, when) {
  q.run(
    'INSERT INTO interactions (contact_id, kind, body, happened_at) VALUES (?, ?, ?, ?)',
    [contactId, kind, body, when],
  )
}

export const dueNames = (q, day) =>
  Q.splitDue(Q.cadenced(q, day)).due.map((r) => r.name)
