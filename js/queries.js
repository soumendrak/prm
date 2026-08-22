// Every SQL statement in the app.
//
// Written against a tiny `q` interface (all/value/run/insert/tx) so the exact
// same code runs against sqlite-wasm in the browser worker and against
// node:sqlite in the tests. Dates are passed in rather than read from `now()`
// wherever due-ness is computed, so the logic is testable without waiting for
// the calendar.

export const MIGRATIONS = [
  `CREATE TABLE contacts (
     id            INTEGER PRIMARY KEY,
     name          TEXT NOT NULL,
     email         TEXT,
     phone         TEXT,
     company       TEXT,
     title         TEXT,
     birthday      TEXT,
     cadence_days  INTEGER,
     snoozed_until TEXT,
     notes         TEXT,
     archived      INTEGER NOT NULL DEFAULT 0,
     created_at    TEXT NOT NULL
   );
   CREATE TABLE interactions (
     id          INTEGER PRIMARY KEY,
     contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
     kind        TEXT NOT NULL CHECK (kind IN ('note','call','meet','email','message')),
     body        TEXT,
     happened_at TEXT NOT NULL
   );
   CREATE TABLE tags (
     id   INTEGER PRIMARY KEY,
     name TEXT NOT NULL UNIQUE
   );
   CREATE TABLE contact_tags (
     contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
     tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
     PRIMARY KEY (contact_id, tag_id)
   );
   CREATE INDEX idx_interactions_contact ON interactions(contact_id, happened_at DESC);
   CREATE INDEX idx_contacts_active ON contacts(archived, name);`,
]

export const KINDS = ['note', 'call', 'meet', 'email', 'message']

export function migrate(q) {
  const at = q.value('PRAGMA user_version')
  for (let v = at; v < MIGRATIONS.length; v++) {
    q.tx(() => {
      q.exec(MIGRATIONS[v])
      q.exec(`PRAGMA user_version = ${v + 1}`)
    })
  }
}

/** Today in the *device's* timezone. Bare 'now' is UTC, which would misdate
 *  anything recorded during the local-vs-UTC offset window. */
export const today = (q) => q.value("SELECT date('now','localtime')")

const blank = (s) => {
  const t = (s ?? '').trim()
  return t === '' ? null : t
}

// ---------------------------------------------------------------- contacts

const LIST_SQL = `
SELECT c.id, c.name, c.email, c.company, c.title,
       (SELECT group_concat(t.name, ', ')
          FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
         WHERE ct.contact_id = c.id) AS tags
  FROM contacts c
 WHERE c.archived = ?
   AND (? = '' OR c.name LIKE '%' || ? || '%'
                OR ifnull(c.email, '')   LIKE '%' || ? || '%'
                OR ifnull(c.company, '') LIKE '%' || ? || '%'
                OR ifnull(c.title, '')   LIKE '%' || ? || '%'
                OR ifnull(c.notes, '')   LIKE '%' || ? || '%'
                OR EXISTS (SELECT 1 FROM interactions i
                            WHERE i.contact_id = c.id
                              AND ifnull(i.body, '') LIKE '%' || ? || '%'))
   AND (? = '' OR EXISTS (SELECT 1
                            FROM contact_tags ct2 JOIN tags t2 ON t2.id = ct2.tag_id
                           WHERE ct2.contact_id = c.id AND t2.name = ?))
 ORDER BY c.name COLLATE NOCASE`

export function listContacts(q, { search = '', tag = '', archived = false } = {}) {
  const s = search.trim()
  // One guard bind plus one per searched column.
  return q.all(LIST_SQL, [archived ? 1 : 0, s, s, s, s, s, s, s, tag, tag])
}

export const allTags = (q) => q.all('SELECT name FROM tags ORDER BY name').map((r) => r.name)

export const getContact = (q, id) =>
  q.one(
    `SELECT id, name, email, phone, company, title, birthday,
            cadence_days, snoozed_until, notes, archived
       FROM contacts WHERE id = ?`,
    [id],
  )

export const contactTags = (q, id) =>
  q
    .all(
      `SELECT t.name FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
        WHERE ct.contact_id = ? ORDER BY t.name`,
      [id],
    )
    .map((r) => r.name)

/** Split a comma-separated tag input into normalised, deduped names. */
export function parseTags(raw) {
  const out = []
  for (const part of (raw ?? '').split(',')) {
    const name = part.trim().toLowerCase()
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

function setTags(q, contactId, raw) {
  q.run('DELETE FROM contact_tags WHERE contact_id = ?', [contactId])
  for (const name of parseTags(raw)) {
    q.run('INSERT OR IGNORE INTO tags (name) VALUES (?)', [name])
    q.run(
      `INSERT INTO contact_tags (contact_id, tag_id)
       VALUES (?, (SELECT id FROM tags WHERE name = ?))`,
      [contactId, name],
    )
  }
}

/** Blank means no reminder. Zero or negative would make someone permanently
 *  due, so it is rejected rather than quietly clamped. */
export function parseCadence(raw) {
  const s = (raw ?? '').toString().trim()
  if (s === '') return null
  if (!/^\d+$/.test(s)) throw new Error('Cadence must be a whole number of days.')
  const n = Number(s)
  if (n < 1) throw new Error('Cadence must be at least 1 day.')
  return n
}

export function saveContact(q, form) {
  const name = (form.name ?? '').trim()
  if (!name) throw new Error('Name is required.')
  const cadence = parseCadence(form.cadence_days)
  const cols = [
    name,
    blank(form.email),
    blank(form.phone),
    blank(form.company),
    blank(form.title),
    blank(form.birthday),
    cadence,
    blank(form.notes),
  ]

  return q.tx(() => {
    let id = form.id
    if (id) {
      q.run(
        `UPDATE contacts SET name = ?, email = ?, phone = ?, company = ?, title = ?,
                             birthday = ?, cadence_days = ?, notes = ?
          WHERE id = ?`,
        [...cols, id],
      )
    } else {
      // created_at is supplied, not defaulted: it is the fallback "last
      // contact" date for someone never spoken to, so it has to be local.
      id = q.insert(
        `INSERT INTO contacts (name, email, phone, company, title, birthday,
                               cadence_days, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, date('now','localtime'))`,
        cols,
      )
    }
    setTags(q, id, form.tags)
    return id
  })
}

export function toggleArchived(q, id) {
  q.run('UPDATE contacts SET archived = NOT archived WHERE id = ?', [id])
}

export function deleteContact(q, id) {
  q.run('DELETE FROM contacts WHERE id = ?', [id])
}

// ---------------------------------------------------------------- interactions

/** `YYYY-MM-DD` — the one shape that sorts and compares correctly in SQLite. */
export const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '')

/** Same-day entries tie on happened_at, so id breaks the tie newest-first. */
export const timeline = (q, contactId) =>
  q.all(
    `SELECT id, contact_id, kind, body, happened_at FROM interactions
      WHERE contact_id = ? ORDER BY happened_at DESC, id DESC`,
    [contactId],
  )

export function saveInteraction(q, form) {
  if (!KINDS.includes(form.kind)) throw new Error('Unknown interaction kind.')
  const when = (form.happened_at ?? '').trim() || today(q)
  if (!isIsoDate(when)) throw new Error('Date must be YYYY-MM-DD.')

  if (form.id) {
    q.run('UPDATE interactions SET kind = ?, body = ?, happened_at = ? WHERE id = ?', [
      form.kind,
      blank(form.body),
      when,
      form.id,
    ])
    return form.id
  }
  return q.insert(
    'INSERT INTO interactions (contact_id, kind, body, happened_at) VALUES (?, ?, ?, ?)',
    [form.contact_id, form.kind, blank(form.body), when],
  )
}

export const deleteInteraction = (q, id) =>
  q.run('DELETE FROM interactions WHERE id = ?', [id])

export const interactionOwner = (q, id) =>
  q.value('SELECT contact_id FROM interactions WHERE id = ?', [id]) ?? null

// ---------------------------------------------------------------- keep in touch

/** Due-ness is derived, never stored: last interaction + cadence, versus the
 *  date passed in. A snooze can only ever push someone further out. */
const DUE_SQL = `
WITH last AS (
    SELECT contact_id, max(happened_at) AS at FROM interactions GROUP BY contact_id
),
due AS (
    SELECT c.id, c.name, c.cadence_days, c.snoozed_until,
           l.at IS NOT NULL AS has_history,
           date(coalesce(l.at, c.created_at)) AS since,
           date(coalesce(l.at, c.created_at), '+' || c.cadence_days || ' days') AS due_on
      FROM contacts c LEFT JOIN last l ON l.contact_id = c.id
     WHERE c.archived = 0 AND c.cadence_days IS NOT NULL
)
SELECT id, name, cadence_days, has_history,
       max(due_on, ifnull(snoozed_until, '')) > due_on AS snoozed,
       CAST(julianday(?) - julianday(max(due_on, ifnull(snoozed_until, ''))) AS INTEGER)
           AS days_overdue,
       CAST(julianday(?) - julianday(since) AS INTEGER) AS days_since
  FROM due
 ORDER BY max(due_on, ifnull(snoozed_until, '')) ASC, name COLLATE NOCASE`

export const cadenced = (q, day) => q.all(DUE_SQL, [day, day])

/** Rows arrive sorted by due date, so the due ones are the front of the list. */
export function splitDue(rows) {
  return {
    due: rows.filter((r) => r.days_overdue >= 0),
    upcoming: rows.filter((r) => r.days_overdue < 0),
  }
}

/** "Logged it" — record the contact and reset the clock in one tap. */
export function touch(q, id) {
  const day = today(q)
  q.tx(() => {
    // 'message' is the most generic of the five kinds; edit it on the contact
    // page if it was really a call.
    q.run(
      "INSERT INTO interactions (contact_id, kind, happened_at) VALUES (?, 'message', ?)",
      [id, day],
    )
    q.run('UPDATE contacts SET snoozed_until = NULL WHERE id = ?', [id])
  })
}

/** 0 days un-snoozes. */
export function snooze(q, id, days) {
  if (!Number.isInteger(days) || days < 0 || days > 365) {
    throw new Error('Snooze must be 0-365 days.')
  }
  const until = days === 0 ? null : q.value("SELECT date('now','localtime', ?)", [`+${days} days`])
  q.run('UPDATE contacts SET snoozed_until = ? WHERE id = ?', [until, id])
}

// ---------------------------------------------------------------- import

/** Everything already stored, so dedupe is not a query per row. */
export function existing(q) {
  return {
    emails: new Set(
      q.all('SELECT lower(email) AS e FROM contacts WHERE email IS NOT NULL').map((r) => r.e),
    ),
    names: new Set(q.all('SELECT lower(name) AS n FROM contacts').map((r) => r.n)),
  }
}

/** Insert the rows a plan marked importable. All or nothing. */
export function importRows(q, rows) {
  const wanted = rows.filter((r) => !r.skip)
  q.tx(() => {
    for (const row of wanted) {
      const id = q.insert(
        `INSERT INTO contacts (name, email, phone, company, title, birthday, notes,
                               created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, date('now','localtime'))`,
        [row.name, row.email, row.phone, row.company, row.title, row.birthday, row.notes],
      )
      setTags(q, id, row.tags.join(','))
    }
  })
  return wanted.length
}

export const counts = (q) => ({
  contacts: q.value('SELECT count(*) FROM contacts WHERE archived = 0'),
  archived: q.value('SELECT count(*) FROM contacts WHERE archived = 1'),
  interactions: q.value('SELECT count(*) FROM interactions'),
})
