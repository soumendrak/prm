// Google Contacts CSV import.
//
// Google has shipped two CSV shapes: the pre-2022 export (`Name`, `Given
// Name`, `Organization 1 - Name`, `Group Membership`) and the current one
// (`First Name`, `Organization Name`, `Labels`). Fields are looked up by header
// name rather than position, so one code path parses both.

/** Google packs repeated values into one cell separated by ` ::: `. */
const MULTI = ':::'

const H = {
  name: ['name'],
  first: ['first name', 'given name'],
  middle: ['middle name', 'additional name'],
  last: ['last name', 'family name'],
  email: ['e-mail 1 - value', 'email 1 - value'],
  phone: ['phone 1 - value'],
  company: ['organization name', 'organization 1 - name'],
  title: ['organization title', 'organization 1 - title'],
  birthday: ['birthday'],
  notes: ['notes'],
  labels: ['labels', 'group membership'],
}

/** RFC4180-ish: honours quoted fields containing commas and newlines. */
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
    } else if (c === '"') {
      quoted = true
    } else if (c === ',') {
      row.push(field); field = ''
    } else if (c === '\r') {
      // swallow; the \n that follows ends the row
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = ''
    } else {
      field += c
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows
}

const norm = (s) => (s ?? '').trim().toLowerCase()

/** First of Google's ` ::: `-separated values. */
function firstValue(raw) {
  for (const part of (raw ?? '').split(MULTI)) {
    const v = part.trim()
    if (v) return v
  }
  return null
}

/** Google's system labels (`* myContacts`, `starred`) are noise, not tags. */
function labelsToTags(raw) {
  const out = []
  for (const part of (raw ?? '').split(MULTI)) {
    const label = part.trim().replace(/^\*+/, '').trim()
    const lower = label.toLowerCase()
    if (!label || lower === 'mycontacts' || lower === 'starred') continue
    if (!out.includes(lower)) out.push(lower)
  }
  return out
}

/**
 * Decide, per row, whether it will be imported.
 *
 * Deduping is by email first (the reliable key), then exact name — against
 * both what is already stored and rows earlier in this same file.
 */
export function plan(text, existing = { emails: new Set(), names: new Set() }) {
  // A UTF-16 file decodes to mojibake rather than failing, so check the BOM.
  if (text.charCodeAt(0) === 0xfffe || text.charCodeAt(0) === 0xfeff0000) {
    throw new Error('This file is UTF-16. In Google Contacts choose Export → Google CSV.')
  }

  const table = parseCsv(text.replace(/^﻿/, ''))
  if (!table.length) throw new Error('This file is empty.')

  const index = new Map()
  table[0].forEach((h, i) => {
    const key = norm(h)
    if (!index.has(key)) index.set(key, i)
  })

  const cell = (row, aliases) => {
    for (const a of aliases) {
      const i = index.get(a)
      if (i !== undefined && (row[i] ?? '').trim()) return row[i].trim()
    }
    return ''
  }

  const hasNameColumn = [H.name, H.first, H.last].some((a) => a.some((x) => index.has(x)))
  if (!hasNameColumn) {
    throw new Error(
      'This file has no name column, so it does not look like a Google Contacts ' +
        'export. In Google Contacts choose Export → Google CSV.',
    )
  }

  const seenEmails = new Set()
  const seenNames = new Set()
  const out = []

  for (const row of table.slice(1)) {
    // A truly blank line is whitespace; a line of bare commas is a real record
    // with empty fields, and is reported as "no name" rather than dropped.
    if (row.length <= 1 && !(row[0] ?? '').trim()) continue
    const full = cell(row, H.name)
    const name =
      full ||
      [H.first, H.middle, H.last]
        .map((a) => cell(row, a))
        .filter(Boolean)
        .join(' ')

    const email = firstValue(cell(row, H.email))
    const keyEmail = email ? norm(email) : null
    const keyName = norm(name)

    let skip = null
    if (!name) skip = 'no name'
    else if (keyEmail) {
      if (existing.emails.has(keyEmail)) skip = 'already saved'
      else if (seenEmails.has(keyEmail)) skip = 'duplicate in file'
    } else if (existing.names.has(keyName)) skip = 'already saved'
    else if (seenNames.has(keyName)) skip = 'duplicate in file'

    if (!skip) {
      if (keyEmail) seenEmails.add(keyEmail)
      seenNames.add(keyName)
    }

    out.push({
      name,
      email,
      phone: firstValue(cell(row, H.phone)),
      company: cell(row, H.company) || null,
      title: cell(row, H.title) || null,
      // Kept verbatim: Google writes "--05-12" when the year is unknown.
      birthday: cell(row, H.birthday) || null,
      notes: cell(row, H.notes) || null,
      tags: labelsToTags(cell(row, H.labels)),
      skip,
    })
  }
  return out
}
