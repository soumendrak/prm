import { test } from 'node:test'
import assert from 'node:assert/strict'

import { plan, markNew } from '../js/import.js'
import * as Q from '../js/queries.js'
import { freshDb } from './adapter.mjs'

/** A vCard file built from `FN` / `EMAIL` pairs; '' means the card has no name. */
const vcf = (...people) =>
  people
    .map(([name, email]) =>
      ['BEGIN:VCARD', 'VERSION:3.0', name && `FN:${name}`, email && `EMAIL:${email}`, 'END:VCARD']
        .filter(Boolean)
        .join('\r\n'),
    )
    .join('\r\n') + '\r\n'

const skips = (rows) => rows.map((r) => r.skip)

test('nameless cards are skipped, not imported blank', () => {
  const rows = plan(vcf(['Ada Lovelace', 'ada@math.org'], ['', 'nobody@x.org']))
  assert.deepEqual(skips(rows), [null, 'no name'])
})

test('existing contacts are skipped by email, then by name', () => {
  const existing = { emails: new Set(['ada@math.org']), names: new Set(['nikola tesla']) }
  const rows = plan(
    vcf(['Ada Lovelace', 'ada@math.org'], ['Grace Hopper', 'grace@navy.mil'], ['Nikola Tesla', '']),
    existing,
  )
  assert.deepEqual(skips(rows), ['already saved', null, 'already saved'])
})

test('duplicates inside one file are caught, case-insensitively', () => {
  const rows = plan(
    vcf(
      ['Ada Lovelace', 'ada@math.org'],
      ['Ada L', 'ADA@MATH.ORG'], // same email, different name
      ['Nikola Tesla', ''],
      ['nikola tesla', ''], // no email, so matched on name
    ),
  )
  assert.deepEqual(skips(rows), [null, 'duplicate in file', null, 'duplicate in file'])
})

test('a differently-named person with no email is still new', () => {
  const rows = markNew([{ name: 'Ada', email: null }, { name: 'Grace', email: null }])
  assert.deepEqual(skips(rows), [null, null])
})

test('a file that is not a vCard says so, and says what to export instead', () => {
  assert.throws(() => plan('First Name,Last Name\nAda,Lovelace\n'), /does not look like a vCard/)
  assert.throws(() => plan(''), /does not look like a vCard/)
})

test('a UTF-16 file is reported rather than imported as mojibake', () => {
  assert.throws(() => plan('￾BEGIN:VCARD'), /UTF-16/)
})

test('a byte order mark does not hide the first line', () => {
  assert.equal(plan('﻿' + vcf(['Ada Lovelace', 'ada@math.org']))[0].name, 'Ada Lovelace')
})

test('importing writes the rows, and re-importing adds nothing', () => {
  const q = freshDb()
  const file = vcf(['Ada Lovelace', 'ada@math.org'], ['Grace Hopper', 'grace@navy.mil'])

  assert.equal(Q.importRows(q, plan(file, Q.existing(q))), 2)
  assert.deepEqual(
    Q.listContacts(q, {}).map((r) => r.name),
    ['Ada Lovelace', 'Grace Hopper'],
  )

  const second = plan(file, Q.existing(q))
  assert.equal(Q.importRows(q, second), 0, 'second import must be a no-op')
  assert.equal(Q.listContacts(q, {}).length, 2)
})

test('imported contacts have no cadence, so nothing nags immediately', () => {
  const q = freshDb()
  Q.importRows(q, plan(vcf(['Ada Lovelace', 'ada@math.org']), Q.existing(q)))
  assert.deepEqual(Q.cadenced(q, '2030-01-01'), [])
})
