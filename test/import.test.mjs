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

/** An `existing` map with nothing left to fill in, so every match is a skip. */
const saved = (...people) => ({
  emails: new Map(people.filter((p) => p.email).map((p) => [p.email, p])),
  names: new Map(people.map((p) => [p.name.toLowerCase(), p])),
})

const full = (id, name, email) => ({
  id, name, email, phone: 'x', company: 'x', title: 'x', birthday: 'x', notes: 'x',
})

test('existing contacts are skipped by email, then by name', () => {
  const existing = saved(full(1, 'Ada Lovelace', 'ada@math.org'), full(2, 'Nikola Tesla', null))
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

test('a file that is neither format says so, and says what to export instead', () => {
  assert.throws(() => plan('hello\n'), /neither a vCard nor a LinkedIn export/)
  assert.throws(() => plan(''), /neither a vCard nor a LinkedIn export/)
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

  assert.deepEqual(Q.importRows(q, plan(file, Q.existing(q))), { added: 2, updated: 0 })
  assert.deepEqual(
    Q.listContacts(q, {}).map((r) => r.name),
    ['Ada Lovelace', 'Grace Hopper'],
  )

  const second = plan(file, Q.existing(q))
  assert.deepEqual(Q.importRows(q, second), { added: 0, updated: 0 }, 'must be a no-op')
  assert.equal(Q.listContacts(q, {}).length, 2)
})

test('imported contacts have no cadence, so nothing nags immediately', () => {
  const q = freshDb()
  Q.importRows(q, plan(vcf(['Ada Lovelace', 'ada@math.org']), Q.existing(q)))
  assert.deepEqual(Q.cadenced(q, '2030-01-01'), [])
})

// ---------------------------------------------------------------- LinkedIn

/** A Connections.csv, preamble and all, from `[first, last, company]` triples. */
const csv = (...people) =>
  'Notes:\n"Some of the email addresses are missing."\n\n' +
  'First Name,Last Name,URL,Email Address,Company,Position,Connected On\n' +
  people
    .map(([first, last, company]) =>
      `${first},${last},https://www.linkedin.com/in/${first},,"${company}",Engineer,22 Aug 2026`,
    )
    .join('\n') +
  '\n'

test('a LinkedIn export is recognised without a vCard in sight', () => {
  const rows = plan(csv(['Ada', 'Lovelace', 'Analytical Engines']))
  assert.deepEqual(rows.map((r) => [r.name, r.company, r.title, r.tags]), [
    ['Ada Lovelace', 'Analytical Engines', 'Engineer', ['linkedin']],
  ])
  assert.equal(rows[0].notes, 'https://www.linkedin.com/in/Ada')
})

test('a connection matching a saved contact fills their blanks, and only those', () => {
  const q = freshDb()
  Q.saveContact(q, { name: 'Ada Lovelace', email: 'ada@math.org', company: 'Somewhere Else' })

  const rows = plan(csv(['Ada', 'Lovelace', 'Analytical Engines']), Q.existing(q))
  assert.deepEqual(
    [rows[0].skip, rows[0].fills],
    [null, ['title', 'notes']],
    'company is already filled in, so it is left alone',
  )
  assert.deepEqual(Q.importRows(q, rows), { added: 0, updated: 1 })

  const ada = Q.getContact(q, Q.listContacts(q, {})[0].id)
  assert.equal(ada.company, 'Somewhere Else')
  assert.equal(ada.title, 'Engineer')
  assert.equal(ada.notes, 'https://www.linkedin.com/in/Ada')
  assert.deepEqual(Q.contactTags(q, ada.id), ['linkedin'])
})

test('re-importing the same connections changes nothing', () => {
  const q = freshDb()
  const file = csv(['Ada', 'Lovelace', 'Analytical Engines'], ['Grace', 'Hopper', 'Navy'])

  assert.deepEqual(Q.importRows(q, plan(file, Q.existing(q))), { added: 2, updated: 0 })
  assert.deepEqual(Q.importRows(q, plan(file, Q.existing(q))), { added: 0, updated: 0 })
  assert.equal(Q.listContacts(q, {}).length, 2)
})

test('notes are appended, never overwritten', () => {
  const q = freshDb()
  Q.saveContact(q, { name: 'Ada Lovelace', notes: 'Met at the Royal Society.' })
  Q.importRows(q, plan(csv(['Ada', 'Lovelace', 'Analytical Engines']), Q.existing(q)))

  const ada = Q.getContact(q, Q.listContacts(q, {})[0].id)
  assert.equal(ada.notes, 'Met at the Royal Society.\nhttps://www.linkedin.com/in/Ada')
})

test('a name two contacts share matches neither', () => {
  const q = freshDb()
  Q.saveContact(q, { name: 'Ada Lovelace', email: 'ada@math.org' })
  Q.saveContact(q, { name: 'Ada Lovelace', email: 'ada@work.com' })

  const rows = plan(csv(['Ada', 'Lovelace', 'Analytical Engines']), Q.existing(q))
  assert.deepEqual(skips(rows), ['already saved'])
})

test('quoted commas and newlines survive the CSV', () => {
  const file =
    'First Name,Last Name,Company,Position\n' +
    'Ada,Lovelace,"Babbage, Lovelace & Co","Mathematician\nand Author"\n'
  const [row] = plan(file)
  assert.equal(row.company, 'Babbage, Lovelace & Co')
  assert.equal(row.title, 'Mathematician\nand Author')
})
