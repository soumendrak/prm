import { test } from 'node:test'
import assert from 'node:assert/strict'

import { plan, parseCsv } from '../js/csv.js'
import * as Q from '../js/queries.js'
import { freshDb } from './adapter.mjs'

/** Current Google Contacts export shape. */
const NEW_FORMAT = `First Name,Middle Name,Last Name,Organization Name,Organization Title,Birthday,Notes,Labels,E-mail 1 - Label,E-mail 1 - Value,Phone 1 - Label,Phone 1 - Value
Ada,,Lovelace,Analytical Engines,Countess,1815-12-10,Met at the Royal Society,* myContacts ::: Friends,Home,ada@math.org ::: ada.alt@math.org,Mobile,+44 20 7946 0000
Grace,Brewster,Hopper,US Navy,Rear Admiral,--12-09,,Work,grace@navy.mil,,
,,,,,,,,,,,
Nikola,,Tesla,,,,,starred,,,,
`

/** Pre-2022 export: full `Name`, `Organization 1 - *`, `Group Membership`. */
const OLD_FORMAT = `Name,Given Name,Family Name,Birthday,Notes,Group Membership,E-mail 1 - Type,E-mail 1 - Value,Phone 1 - Type,Phone 1 - Value,Organization 1 - Name,Organization 1 - Title
Ada Lovelace,Ada,Lovelace,1815-12-10,,* myContacts,Home,ada@math.org,Mobile,555-0100,Analytical Engines,Countess
`

const importable = (rows) => rows.filter((r) => !r.skip)

test('quoted fields with commas and newlines survive', () => {
  const rows = parseCsv('a,b\n"x, y","line1\nline2"\n')
  assert.deepEqual(rows[1], ['x, y', 'line1\nline2'])
})

test('escaped double quotes are unescaped', () => {
  assert.deepEqual(parseCsv('a\n"say ""hi"""\n')[1], ['say "hi"'])
})

test('parses the current export format', () => {
  const rows = plan(NEW_FORMAT)
  assert.deepEqual(
    rows.map((r) => r.name),
    ['Ada Lovelace', 'Grace Brewster Hopper', '', 'Nikola Tesla'],
  )

  const ada = rows[0]
  assert.equal(ada.email, 'ada@math.org') // first of the ::: list
  assert.equal(ada.phone, '+44 20 7946 0000')
  assert.equal(ada.company, 'Analytical Engines')
  assert.equal(ada.title, 'Countess')
  assert.equal(ada.notes, 'Met at the Royal Society')
  assert.deepEqual(ada.tags, ['friends']) // "* myContacts" dropped

  // Year-less birthdays survive rather than being discarded.
  assert.equal(rows[1].birthday, '--12-09')
  // Only system labels means no tags, not a junk one.
  assert.deepEqual(rows[3].tags, [])
})

test('parses the legacy export format', () => {
  const ada = plan(OLD_FORMAT)[0]
  assert.equal(ada.name, 'Ada Lovelace')
  assert.equal(ada.company, 'Analytical Engines')
  assert.equal(ada.title, 'Countess')
  assert.equal(ada.email, 'ada@math.org')
  assert.deepEqual(ada.tags, [])
})

test('nameless rows are skipped, not imported blank', () => {
  const rows = plan(NEW_FORMAT)
  assert.equal(rows[2].skip, 'no name')
  assert.equal(importable(rows).length, 3)
})

test('existing contacts are skipped by email, then by name', () => {
  const existing = { emails: new Set(['ada@math.org']), names: new Set(['nikola tesla']) }
  const rows = plan(NEW_FORMAT, existing)
  assert.equal(rows[0].skip, 'already saved')
  assert.equal(rows[1].skip, null)
  assert.equal(rows[3].skip, 'already saved') // no email, matched on name
})

test('duplicates inside one file are caught, case-insensitively', () => {
  const rows = plan(
    'First Name,Last Name,E-mail 1 - Value\n' +
      'Ada,Lovelace,ada@math.org\n' +
      'Ada,Lovelace,ADA@MATH.ORG\n' +
      'Nikola,Tesla,\n' +
      'Nikola,Tesla,\n',
  )
  assert.deepEqual(
    rows.map((r) => r.skip),
    [null, 'duplicate in file', null, 'duplicate in file'],
  )
})

test('a file that is not a contacts export says so', () => {
  assert.throws(() => plan('foo,bar\n1,2\n'), /no name column/)
})

test('a byte order mark does not hide the first column', () => {
  const rows = plan('﻿First Name,Last Name,E-mail 1 - Value\nAda,Lovelace,ada@math.org\n')
  assert.equal(rows[0].name, 'Ada Lovelace')
})

test('importing writes the rows, and re-importing adds nothing', () => {
  const q = freshDb()

  const first = plan(NEW_FORMAT, Q.existing(q))
  assert.equal(Q.importRows(q, first), 3)

  const stored = Q.listContacts(q, {})
  assert.deepEqual(
    stored.map((r) => r.name),
    ['Ada Lovelace', 'Grace Brewster Hopper', 'Nikola Tesla'],
  )
  // Google labels became tags.
  assert.deepEqual(Q.contactTags(q, stored.find((r) => r.name === 'Ada Lovelace').id), ['friends'])

  const second = plan(NEW_FORMAT, Q.existing(q))
  assert.equal(importable(second).length, 0, 'second import must be a no-op')
  assert.equal(Q.importRows(q, second), 0)
  assert.equal(Q.listContacts(q, {}).length, 3)
})

test('imported contacts have no cadence, so nothing nags immediately', () => {
  const q = freshDb()
  Q.importRows(q, plan(NEW_FORMAT, Q.existing(q)))
  assert.deepEqual(Q.cadenced(q, '2030-01-01'), [])
})
