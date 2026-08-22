// Contact import: turns a picked file into rows, then decides which are new.

import { vcardRows } from './vcard.js'

const norm = (s) => (s ?? '').trim().toLowerCase()

/**
 * Marks each row with `skip` — the reason it will not be imported, or null.
 *
 * Deduping is by email first (the reliable key), then exact name — against
 * both what is already stored and rows earlier in this same file.
 */
export function markNew(rows, existing = { emails: new Set(), names: new Set() }) {
  const seenEmails = new Set()
  const seenNames = new Set()

  for (const row of rows) {
    const keyEmail = row.email ? norm(row.email) : null
    const keyName = norm(row.name)

    let skip = null
    if (!row.name) skip = 'no name'
    else if (keyEmail) {
      if (existing.emails.has(keyEmail)) skip = 'already saved'
      else if (seenEmails.has(keyEmail)) skip = 'duplicate in file'
    } else if (existing.names.has(keyName)) skip = 'already saved'
    else if (seenNames.has(keyName)) skip = 'duplicate in file'

    if (!skip) {
      if (keyEmail) seenEmails.add(keyEmail)
      seenNames.add(keyName)
    }
    row.skip = skip
  }
  return rows
}

/** Parse a picked vCard file into import rows. Nothing is written by this. */
export function plan(text, existing) {
  // A UTF-16 file decodes to mojibake rather than failing, so check the BOM.
  if (text.charCodeAt(0) === 0xfffe || text.charCodeAt(0) === 0xfeff0000) {
    throw new Error('This file is UTF-16. Re-export it as UTF-8.')
  }
  const clean = text.replace(/^﻿/, '')
  if (!/^\s*BEGIN:VCARD/i.test(clean.slice(0, 200))) {
    throw new Error(
      'This does not look like a vCard file. In Google Contacts choose ' +
        'Export → vCard, and pick the downloaded .vcf file.',
    )
  }
  return markNew(vcardRows(clean), existing)
}
