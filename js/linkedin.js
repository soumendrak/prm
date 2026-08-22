// LinkedIn's "Connections.csv" export, as import rows.
//
// The file starts with a "Notes:" preamble LinkedIn adds for humans, then the
// real header. Most rows have no email — LinkedIn only shares one when the
// connection opted in — so these merge onto existing contacts by name.

/** RFC 4180 rows: quoted fields may hold commas, newlines and `""` escapes. */
export function csvRows(text) {
  const s = text.replace(/\r\n?/g, '\n')
  const rows = []
  let row = ['']
  let quoted = false
  const push = (c) => { row[row.length - 1] += c }

  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      if (c !== '"') push(c)
      else if (s[i + 1] === '"') { push('"'); i++ }
      else quoted = false
    } else if (c === '"' && row[row.length - 1] === '') quoted = true
    else if (c === ',') row.push('')
    else if (c === '\n') { rows.push(row); row = [''] }
    else push(c)
  }
  if (row.length > 1 || row[0] !== '') rows.push(row)
  return rows
}

/** True if `text` looks like a connections export rather than a vCard. */
export const isLinkedin = (text) => /^\s*"?first name"?\s*,/im.test(text.slice(0, 4000))

/**
 * Every connection in `text`, as the rows `import.js` dedupes.
 * The profile URL becomes a note — it is the one thing only LinkedIn knows.
 */
export function linkedinRows(text) {
  const rows = csvRows(text)
  const h = rows.findIndex((r) => /^\s*first name\s*$/i.test(r[0] ?? ''))
  if (h === -1) throw new Error('This CSV has no "First Name" column.')

  const cols = rows[h].map((c) => c.trim().toLowerCase())
  const out = []
  for (const r of rows.slice(h + 1)) {
    const at = (name) => (r[cols.indexOf(name)] ?? '').trim() || null
    const name = [at('first name'), at('last name')].filter(Boolean).join(' ')
    // A trailing blank line is a row of one empty field, not a nameless person.
    if (!name && r.length < 2) continue
    out.push({
      name,
      email: at('email address'),
      phone: null,
      company: at('company'),
      title: at('position'),
      birthday: null,
      notes: at('url'),
      tags: ['linkedin'],
    })
  }
  return out
}
