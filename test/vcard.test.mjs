import { test } from 'node:test'
import assert from 'node:assert/strict'

import { vcardRows, toVcard } from '../js/vcard.js'
import { plan } from '../js/import.js'
import * as Q from '../js/queries.js'
import { freshDb } from './adapter.mjs'

/** What Google Contacts' "vCard (for iOS Contacts)" export looks like. */
const GOOGLE = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Ada Lovelace',
  'N:Lovelace;Ada;;;',
  'EMAIL;TYPE=INTERNET;TYPE=HOME:ada@math.org',
  'EMAIL;TYPE=INTERNET;TYPE=WORK:ada.alt@math.org',
  'TEL;TYPE=CELL:+44 20 7946 0000',
  'ORG:Analytical Engines;Research',
  'TITLE:Countess',
  'BDAY:1815-12-10',
  'NOTE:Met at the Royal Society',
  'CATEGORIES:Friends,Math',
  'END:VCARD',
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Grace Hopper',
  'EMAIL;TYPE=INTERNET:grace@navy.mil',
  'BDAY:--12-09',
  'END:VCARD',
].join('\r\n')

test('reads a Google vCard export', () => {
  const [ada, grace] = vcardRows(GOOGLE)
  assert.equal(ada.name, 'Ada Lovelace')
  assert.equal(ada.email, 'ada@math.org') // first wins when none is preferred
  assert.equal(ada.phone, '+44 20 7946 0000')
  assert.equal(ada.company, 'Analytical Engines') // ORG's first component only
  assert.equal(ada.title, 'Countess')
  assert.equal(ada.birthday, '1815-12-10')
  assert.equal(ada.notes, 'Met at the Royal Society')
  assert.deepEqual(ada.tags, ['friends', 'math'])
  assert.equal(grace.birthday, '--12-09') // year-less, which is what Google writes
})

test('N supplies the name when FN is missing', () => {
  const [r] = vcardRows('BEGIN:VCARD\r\nN:Hopper;Grace;Brewster;;\r\nEND:VCARD')
  assert.equal(r.name, 'Grace Brewster Hopper')
})

test('PREF picks the email, whatever order they came in', () => {
  const [r] = vcardRows(
    ['BEGIN:VCARD', 'FN:A', 'EMAIL:second@x.org', 'EMAIL;PREF=1:first@x.org', 'END:VCARD'].join('\n'),
  )
  assert.equal(r.email, 'first@x.org')
})

test('folded lines are rejoined before parsing', () => {
  const [r] = vcardRows('BEGIN:VCARD\r\nNOTE:one two\r\n  three\r\nFN:A\r\nEND:VCARD')
  assert.equal(r.notes, 'one two three')
})

test('escapes are unescaped, and separators inside values are kept', () => {
  const [r] = vcardRows('BEGIN:VCARD\nFN:Smith\\, Jr.\nNOTE:a\\nb\;c\nEND:VCARD')
  assert.equal(r.name, 'Smith, Jr.')
  assert.equal(r.notes, 'a\nb;c')
})

test('grouped properties and vCard 2.1 bare parameters are understood', () => {
  const [r] = vcardRows('BEGIN:VCARD\nFN:A\nitem1.TEL;CELL:555\nEND:VCARD')
  assert.equal(r.phone, '555')
})

test('quoted-printable values decode as UTF-8', () => {
  const [r] = vcardRows(
    'BEGIN:VCARD\nFN;ENCODING=QUOTED-PRINTABLE;CHARSET=UTF-8:Jos=C3=A9\nEND:VCARD',
  )
  assert.equal(r.name, 'José')
})

test('vCard 4.0 date shapes normalise', () => {
  const at = (v) => vcardRows(`BEGIN:VCARD\nFN:A\nBDAY:${v}\nEND:VCARD`)[0].birthday
  assert.equal(at('19851210'), '1985-12-10')
  assert.equal(at('--1209'), '--12-09')
})

test('a truncated file yields what it managed to say', () => {
  const [r] = vcardRows('BEGIN:VCARD\nFN:Ada Lovelace\nEMAIL:ada@math.org')
  assert.equal(r.name, 'Ada Lovelace')
})

test('a .vcf is routed to the vCard parser, and deduped like any import', () => {
  const q = freshDb()
  const first = plan(GOOGLE, Q.existing(q))
  assert.equal(first.filter((r) => !r.skip).length, 2)
  Q.importRows(q, first)

  const second = plan(GOOGLE, Q.existing(q))
  assert.deepEqual(
    second.map((r) => r.skip),
    ['already saved', 'already saved'],
  )
})

test('imported vCard rows land as real contacts', () => {
  const q = freshDb()
  Q.importRows(q, plan(GOOGLE, Q.existing(q)))
  const ada = Q.listContacts(q).find((r) => r.name === 'Ada Lovelace')
  assert.equal(Q.getContact(q, ada.id).birthday, '1815-12-10')
  assert.deepEqual(Q.contactTags(q, ada.id), ['friends', 'math'])
})

// ---------------------------------------------------------------- writing

test('export round-trips back through the parser', () => {
  const q = freshDb()
  Q.saveContact(q, {
    name: 'Ada Lovelace',
    email: 'ada@math.org',
    phone: '+44 20 7946 0000',
    company: 'Analytical Engines',
    title: 'Countess',
    birthday: '1815-12-10',
    notes: 'Two lines;\nwith, punctuation',
    tags: 'math, friend',
  })
  const [back] = vcardRows(toVcard(Q.exportContacts(q)))
  assert.equal(back.name, 'Ada Lovelace')
  assert.equal(back.email, 'ada@math.org')
  assert.equal(back.phone, '+44 20 7946 0000')
  assert.equal(back.company, 'Analytical Engines')
  assert.equal(back.title, 'Countess')
  assert.equal(back.birthday, '1815-12-10')
  assert.equal(back.notes, 'Two lines;\nwith, punctuation')
  assert.deepEqual(back.tags, ['friend', 'math'])
})

test('archived contacts are left out of the export', () => {
  const q = freshDb()
  const id = Q.saveContact(q, { name: 'Ada Lovelace' })
  Q.saveContact(q, { name: 'Grace Hopper' })
  Q.toggleArchived(q, id)
  assert.deepEqual(
    Q.exportContacts(q).map((r) => r.name),
    ['Grace Hopper'],
  )
})

test('long values are folded to 75 octets and survive the round trip', () => {
  const notes = 'ünïcödé '.repeat(40).trim()
  const vcf = toVcard([{ name: 'Ada', notes }])
  const encoder = new TextEncoder()
  for (const line of vcf.split('\r\n')) {
    assert.ok(encoder.encode(line).length <= 75, `line too long: ${line.length}`)
  }
  assert.equal(vcardRows(vcf)[0].notes, notes)
})

test('a nameless row is not written out', () => {
  assert.equal(toVcard([{ name: '  ' }, { name: null }]), '')
})
