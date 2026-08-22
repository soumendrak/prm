// Contact import: turns a picked file into rows, then decides which are new,
// which fill gaps in someone already saved, and which are nothing at all.

import { vcardRows } from './vcard.js'
import { isLinkedin, linkedinRows } from './linkedin.js'
import { MERGE_FIELDS } from './queries.js'

const norm = (s) => (s ?? '').trim().toLowerCase()
const blank = (v) => v === null || v === undefined || String(v).trim() === ''

/** The fields this row could add to `contact`, which merging leaves untouched. */
function fills(row, contact) {
  return MERGE_FIELDS.filter((f) => {
    if (blank(row[f])) return false
    // Notes are appended rather than replaced, so "already there" is the test.
    if (f === 'notes') return !(contact.notes ?? '').includes(row.notes.trim())
    return blank(contact[f])
  })
}

/**
 * Marks each row with `skip` — the reason it will not be imported, or null —
 * and, when it matches someone already saved, `merge` (their id) plus `fills`
 * (the blank fields it can complete).
 *
 * Matching is by email first (the reliable key), falling back to exact name,
 * against both what is already stored and rows earlier in this same file. A
 * name held by two contacts matches neither: the file cannot say which.
 */
export function markNew(rows, existing = { emails: new Map(), names: new Map() }) {
  const seenEmails = new Set()
  const seenNames = new Set()

  for (const row of rows) {
    const keyEmail = row.email ? norm(row.email) : null
    const keyName = norm(row.name)
    row.merge = null
    row.fills = []

    let skip = null
    if (!row.name) skip = 'no name'
    else if (keyEmail ? seenEmails.has(keyEmail) : seenNames.has(keyName)) {
      skip = 'duplicate in file'
    } else {
      // `null` is the ambiguous-name marker; `undefined` is simply no match.
      const match = (keyEmail && existing.emails.get(keyEmail)) || existing.names.get(keyName)
      if (match === null) skip = 'already saved'
      else if (match) {
        row.merge = match.id
        row.fills = fills(row, match)
        if (!row.fills.length) skip = 'already saved'
      }
    }

    if (!skip) {
      if (keyEmail) seenEmails.add(keyEmail)
      seenNames.add(keyName)
    }
    row.skip = skip
  }
  return rows
}

/** Parse a picked vCard or LinkedIn CSV into import rows. Nothing is written. */
export function plan(text, existing) {
  // A UTF-16 file decodes to mojibake rather than failing, so check the BOM.
  if (text.charCodeAt(0) === 0xfffe || text.charCodeAt(0) === 0xfeff0000) {
    throw new Error('This file is UTF-16. Re-export it as UTF-8.')
  }
  const clean = text.replace(/^﻿/, '')
  if (/^\s*BEGIN:VCARD/i.test(clean.slice(0, 200))) {
    return markNew(vcardRows(clean), existing)
  }
  if (isLinkedin(clean)) return markNew(linkedinRows(clean), existing)
  throw new Error(
    'This is neither a vCard nor a LinkedIn export. In Google Contacts choose ' +
      'Export → vCard; on LinkedIn choose Get a copy of your data → Connections.',
  )
}
