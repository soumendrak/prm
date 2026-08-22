// vCard, both directions.
//
// Reads what address books actually emit — 2.1, 3.0 and 4.0, folded lines,
// grouped properties (`item1.TEL`), quoted-printable — and writes 3.0, the one
// version every phone, Google Contacts and Nextcloud will import without
// complaint.

const CRLF = '\r\n'

// ---------------------------------------------------------------- reading

/** Splits on `sep`, honouring backslash escapes and double-quoted runs. */
function splitTop(s, sep) {
  const out = ['']
  let quoted = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') { out[out.length - 1] += c + (s[i + 1] ?? ''); i++ }
    else if (c === '"') { quoted = !quoted; out[out.length - 1] += c }
    else if (c === sep && !quoted) out.push('')
    else out[out.length - 1] += c
  }
  return out
}

/** `\n` is a newline; every other escape is the character itself. */
const unescape = (v) => v.replace(/\\(.)/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c))

/** ponytail: decodes `=XX` only. 2.1 soft line breaks (a trailing `=`) are not
 *  rejoined — no exporter still in use writes them. */
function decodeQp(s, charset) {
  const bytes = []
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      bytes.push(s.charCodeAt(i) & 0xff)
    }
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(new Uint8Array(bytes))
  } catch {
    return new TextDecoder().decode(new Uint8Array(bytes))
  }
}

/** `item1.TEL;TYPE=CELL:+44…` → `{name, params, value}`, or null if unparseable. */
function contentLine(line) {
  let i = 0
  let quoted = false
  for (; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted
    else if (line[i] === ':' && !quoted) break
  }
  if (i >= line.length) return null

  const [prop, ...rest] = splitTop(line.slice(0, i), ';')
  const params = {}
  for (const p of rest) {
    const eq = p.indexOf('=')
    // vCard 2.1 writes bare parameter values: `TEL;CELL:` means `TYPE=CELL`.
    const key = (eq === -1 ? 'type' : p.slice(0, eq)).trim().toLowerCase()
    const val = (eq === -1 ? p : p.slice(eq + 1)).trim().replace(/^"|"$/g, '')
    params[key] = params[key] ? `${params[key]},${val}` : val
  }

  let value = line.slice(i + 1)
  if ((params.encoding ?? '').toLowerCase().includes('quoted-printable')) {
    value = decodeQp(value, params.charset)
  }
  // A group prefix (`item1.`) is presentation, not identity.
  return { name: prop.split('.').pop().trim().toUpperCase(), params, value }
}

/** `19850512`, `1985-05-12`, `--0512` → the shape the rest of the app stores. */
function birthday(v) {
  const s = v.trim()
  let m
  if ((m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`
  if ((m = s.match(/^--(\d{2})-?(\d{2})/))) return `--${m[1]}-${m[2]}`
  return s || null
}

/** `Lovelace;Ada;;Ms.;` → `Ada Lovelace`. */
function fromN(value) {
  const [last, first, middle] = splitTop(value, ';').map(unescape)
  return [first, middle, last].map((s) => (s ?? '').trim()).filter(Boolean).join(' ')
}

const preferred = (params) => (params.pref !== undefined || /pref/i.test(params.type ?? '') ? 0 : 1)

/**
 * Every VCARD block in `text`, as the rows `import.js` dedupes.
 * Malformed cards are skipped rather than aborting the file.
 */
export function vcardRows(text) {
  // Unfolding must happen before anything is split into lines: a folded line
  // continues on the next physical line, indented by one space or tab.
  const lines = text.replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n')

  const rows = []
  let card = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (/^BEGIN:VCARD$/i.test(trimmed)) {
      card = { emails: [], phones: [], tags: [] }
      continue
    }
    if (!card) continue
    if (/^END:VCARD$/i.test(trimmed)) {
      rows.push(finish(card))
      card = null
      continue
    }
    if (!trimmed) continue

    const cl = contentLine(line)
    if (!cl) continue
    const { name, params, value } = cl
    const v = unescape(value).trim()

    switch (name) {
      case 'FN': if (v) card.fn = v; break
      case 'N': if (!card.n) card.n = fromN(value); break
      case 'EMAIL': if (v) card.emails.push([preferred(params), v]); break
      case 'TEL': if (v) card.phones.push([preferred(params), v]); break
      case 'ORG': if (v) card.company = splitTop(value, ';').map(unescape)[0].trim() || null; break
      case 'TITLE': case 'ROLE': if (v && !card.title) card.title = v; break
      case 'BDAY': if (v) card.birthday = birthday(v); break
      case 'NOTE': if (v) card.notes = card.notes ? `${card.notes}\n${v}` : v; break
      case 'CATEGORIES':
        for (const t of splitTop(value, ',').map(unescape)) {
          const tag = t.trim().toLowerCase()
          if (tag && !card.tags.includes(tag)) card.tags.push(tag)
        }
        break
    }
  }
  // A file that was cut off mid-card still yields what it managed to say.
  if (card) rows.push(finish(card))
  return rows
}

/** Lowest preference rank wins; ties keep file order. */
const best = (pairs) => (pairs.length ? pairs.slice().sort((a, b) => a[0] - b[0])[0][1] : null)

const finish = (card) => ({
  name: card.fn || card.n || '',
  email: best(card.emails),
  phone: best(card.phones),
  company: card.company ?? null,
  title: card.title ?? null,
  birthday: card.birthday ?? null,
  notes: card.notes ?? null,
  tags: card.tags,
})

// ---------------------------------------------------------------- writing

const escape = (v) =>
  String(v).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1')

/** Lines are limited to 75 octets, so fold on encoded length, not characters. */
function fold(line) {
  const enc = new TextEncoder()
  if (enc.encode(line).length <= 75) return line
  const out = []
  let cur = ''
  let len = 0
  for (const ch of line) {
    const n = enc.encode(ch).length
    if (len + n > 74) { out.push(cur); cur = ' '; len = 1 }
    cur += ch
    len += n
  }
  out.push(cur)
  return out.join(CRLF)
}

/** ponytail: last word is the surname. FN carries the real name; N is a hint
 *  that address books use for sorting, and no split is right for every name. */
function toN(name) {
  const parts = name.trim().split(/\s+/)
  const last = parts.length > 1 ? parts.pop() : ''
  return `${escape(last)};${escape(parts.join(' '))};;;`
}

/** vCard 3.0 for a list of contact rows. Contacts with no name are skipped. */
export function toVcard(rows) {
  const out = []
  for (const r of rows) {
    const name = (r.name ?? '').trim()
    if (!name) continue
    const lines = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'PRODID:-//PRM//EN',
      `N:${toN(name)}`,
      `FN:${escape(name)}`,
    ]
    if (r.email) lines.push(`EMAIL;TYPE=INTERNET:${escape(r.email)}`)
    if (r.phone) lines.push(`TEL;TYPE=VOICE:${escape(r.phone)}`)
    if (r.company || r.title) lines.push(`ORG:${escape(r.company ?? '')}`)
    if (r.title) lines.push(`TITLE:${escape(r.title)}`)
    if (r.birthday) lines.push(`BDAY:${escape(r.birthday)}`)
    if (r.notes) lines.push(`NOTE:${escape(r.notes)}`)
    // Sorted so re-exporting an unchanged database produces an identical file.
    if (r.tags) lines.push(`CATEGORIES:${r.tags.split(',').sort().join(',')}`)
    lines.push('END:VCARD')
    out.push(lines.map(fold).join(CRLF))
  }
  return out.length ? out.join(CRLF) + CRLF : ''
}
