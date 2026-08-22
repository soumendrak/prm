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

  // How two people know each other. One row per pair, stored with the smaller
  // id first so the primary key does the deduping.
  //
  // ponytail: one shared label, so it reads the same from either side ("met at
  // Priya's wedding", "cousins"). Directional pairs ("manager"/"report") would
  // need a second label column and a side to hang it on; add that when a label
  // actually needs to differ per direction.
  `CREATE TABLE relations (
     a_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
     b_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
     label TEXT,
     PRIMARY KEY (a_id, b_id)
   );
   CREATE INDEX idx_relations_b ON relations(b_id);`,
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

/** Adds one tag to a contact. A tag they already carry is left alone. */
function addTag(q, contactId, name) {
  q.run('INSERT OR IGNORE INTO tags (name) VALUES (?)', [name])
  q.run(
    `INSERT OR IGNORE INTO contact_tags (contact_id, tag_id)
     VALUES (?, (SELECT id FROM tags WHERE name = ?))`,
    [contactId, name],
  )
}

function setTags(q, contactId, raw) {
  q.run('DELETE FROM contact_tags WHERE contact_id = ?', [contactId])
  for (const name of parseTags(raw)) addTag(q, contactId, name)
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

// ---------------------------------------------------------------- birthdays

/**
 * Whose birthday falls within `within` days of `day`.
 *
 * Birthdays are stored as either `YYYY-MM-DD` or Google's year-less
 * `--MM-DD`, so the last five characters are the only part that is always
 * there and always comparable.
 *
 * 29 February in a non-leap year lands on 1 March, which is what SQLite's
 * date() does with it and what most people do with it too.
 */
const BIRTHDAY_SQL = `
WITH shape AS (
    SELECT id, name, birthday, substr(birthday, -5) AS md
      FROM contacts
     WHERE archived = 0
       AND substr(ifnull(birthday, ''), -5) GLOB '[0-9][0-9]-[0-9][0-9]'
),
next AS (
    SELECT id, name, birthday,
           CASE WHEN date(strftime('%Y', ?) || '-' || md) >= date(?)
                THEN date(strftime('%Y', ?) || '-' || md)
                ELSE date(strftime('%Y', ?, '+1 year') || '-' || md)
           END AS on_day
      FROM shape
)
SELECT id, name, on_day,
       CAST(julianday(on_day) - julianday(?) AS INTEGER) AS days_away,
       CASE WHEN substr(birthday, 1, 4) GLOB '[0-9][0-9][0-9][0-9]'
            THEN CAST(strftime('%Y', on_day) AS INTEGER)
                 - CAST(substr(birthday, 1, 4) AS INTEGER)
       END AS turning
  FROM next
 WHERE julianday(on_day) - julianday(?) <= ?
 ORDER BY on_day, name COLLATE NOCASE`

/** Far enough ahead to buy a card, close enough to still be Today's problem. */
export const BIRTHDAY_WINDOW = 30

export const birthdays = (q, day, within = BIRTHDAY_WINDOW) =>
  q.all(BIRTHDAY_SQL, [day, day, day, day, day, day, within])

// ---------------------------------------------------------------- relations

/** Smaller id first, so a pair has exactly one row however it was entered. */
const pair = (a, b) => (a < b ? [a, b] : [b, a])

/** Both directions of the edge, from `id`'s point of view. */
export const relations = (q, id) =>
  q.all(
    `SELECT c.id, c.name, c.archived, r.label
       FROM relations r
       JOIN contacts c
         ON c.id = CASE WHEN r.a_id = ? THEN r.b_id ELSE r.a_id END
      WHERE r.a_id = ? OR r.b_id = ?
      ORDER BY c.name COLLATE NOCASE`,
    [id, id, id],
  )

export function saveRelation(q, aId, bId, label) {
  const a = Number(aId)
  const b = Number(bId)
  if (!Number.isInteger(a) || !Number.isInteger(b) || !b) {
    throw new Error('Pick who they are connected to.')
  }
  if (a === b) throw new Error('Someone cannot be connected to themselves.')
  if (!q.value('SELECT count(*) FROM contacts WHERE id = ?', [b])) {
    throw new Error('That contact no longer exists.')
  }
  // Re-adding an existing pair edits its label rather than failing.
  q.run(
    `INSERT INTO relations (a_id, b_id, label) VALUES (?, ?, ?)
     ON CONFLICT (a_id, b_id) DO UPDATE SET label = excluded.label`,
    [...pair(a, b), blank(label)],
  )
}

export const deleteRelation = (q, aId, bId) =>
  q.run('DELETE FROM relations WHERE a_id = ? AND b_id = ?', pair(Number(aId), Number(bId)))

/** Candidates for the connection picker on a contact page.
 *  ponytail: every active contact, in one list. Swap for a search box if you
 *  ever have enough people for the dropdown to feel slow. */
export const others = (q, id) =>
  q.all(
    `SELECT id, name FROM contacts
      WHERE archived = 0 AND id <> ? ORDER BY name COLLATE NOCASE`,
    [id],
  )

// ---------------------------------------------------------------- import

/** The contact fields an import may fill in on someone already saved. */
export const MERGE_FIELDS = ['email', 'phone', 'company', 'title', 'birthday', 'notes']

/** Everything already stored, so dedupe is not a query per row. */
export function existing(q) {
  const rows = q.all(`SELECT id, name, ${MERGE_FIELDS.join(', ')} FROM contacts`)
  const emails = new Map()
  const names = new Map()
  for (const r of rows) {
    if (r.email) emails.set(r.email.trim().toLowerCase(), r)
    const name = r.name.trim().toLowerCase()
    // A name two contacts share cannot identify either: null means "ambiguous".
    names.set(name, names.has(name) ? null : r)
  }
  return { emails, names }
}

/**
 * Insert the rows a plan marked new and fill the gaps it marked mergeable.
 * All or nothing. Merging only ever fills blanks — nothing stored is replaced.
 */
export function importRows(q, rows) {
  const wanted = rows.filter((r) => !r.skip)
  const added = wanted.filter((r) => !r.merge)
  const updated = wanted.filter((r) => r.merge)

  q.tx(() => {
    for (const row of added) {
      const id = q.insert(
        `INSERT INTO contacts (name, email, phone, company, title, birthday, notes,
                               created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, date('now','localtime'))`,
        [row.name, row.email, row.phone, row.company, row.title, row.birthday, row.notes],
      )
      setTags(q, id, row.tags.join(','))
    }
    for (const row of updated) {
      // Only known columns reach the statement — `fills` crossed a worker boundary.
      const fields = (row.fills ?? []).filter((f) => MERGE_FIELDS.includes(f))
      if (fields.length) {
        q.run(
          `UPDATE contacts SET ${fields.map(setter).join(', ')} WHERE id = ?`,
          [...fields.map((f) => row[f]), row.merge],
        )
      }
      for (const name of parseTags(row.tags.join(','))) addTag(q, row.merge, name)
    }
  })
  return { added: added.length, updated: updated.length }
}

/** Notes are appended, so an imported profile link joins what you wrote. */
const setter = (f) =>
  f === 'notes' ? `notes = trim(coalesce(notes || char(10), '') || ?)` : `${f} = ?`

export const counts = (q) => ({
  contacts: q.value('SELECT count(*) FROM contacts WHERE archived = 0'),
  archived: q.value('SELECT count(*) FROM contacts WHERE archived = 1'),
  interactions: q.value('SELECT count(*) FROM interactions'),
})

/** Active contacts, flattened for vCard export. Tags become CATEGORIES. */
export const exportContacts = (q) =>
  q.all(`
    SELECT c.name, c.email, c.phone, c.company, c.title, c.birthday, c.notes,
           (SELECT group_concat(t.name, ',')
              FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
             WHERE ct.contact_id = c.id) AS tags
      FROM contacts c
     WHERE c.archived = 0
     ORDER BY c.name COLLATE NOCASE`)
