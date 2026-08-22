import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as Q from '../js/queries.js'
import { freshDb } from './adapter.mjs'

// ---------------------------------------------------------------- birthdays

const withBirthdays = (...pairs) => {
  const q = freshDb()
  const ids = {}
  for (const [name, birthday] of pairs) ids[name] = Q.saveContact(q, { name, birthday })
  return { q, ids }
}

const upcoming = (q, day, within) =>
  Q.birthdays(q, day, within).map((r) => `${r.name} ${r.on_day} ${r.days_away}`)

test('birthdays are found by month and day, whatever the year', () => {
  const { q } = withBirthdays(
    ['Dated', '1985-03-01'],
    ['Year-less', '--03-05'], // what Google writes when the year is unknown
    ['Bare', '03-09'],
  )
  assert.deepEqual(upcoming(q, '2026-03-01', 30), [
    'Dated 2026-03-01 0',
    'Year-less 2026-03-05 4',
    'Bare 2026-03-09 8',
  ])
})

test('a birthday already past this year rolls to next year', () => {
  const { q } = withBirthdays(['Ada', '1815-12-10'])
  assert.deepEqual(upcoming(q, '2026-12-11', 400), ['Ada 2027-12-10 364'])
})

test('only birthdays inside the window are returned', () => {
  const { q } = withBirthdays(['Near', '--03-10'], ['Far', '--06-10'])
  assert.deepEqual(
    Q.birthdays(q, '2026-03-01', 30).map((r) => r.name),
    ['Near'],
  )
  assert.equal(Q.birthdays(q, '2026-03-01').length, 1) // default window
})

test('turning is the age reached, and null without a birth year', () => {
  const { q } = withBirthdays(['Dated', '1985-03-05'], ['Year-less', '--03-05'])
  const [dated, yearless] = Q.birthdays(q, '2026-03-01', 30)
  assert.equal(dated.turning, 41)
  assert.equal(yearless.turning, null)
})

test('29 February lands on 1 March in a year that has no 29th', () => {
  const { q } = withBirthdays(['Leapling', '2000-02-29'])
  assert.equal(Q.birthdays(q, '2026-02-01', 40)[0].on_day, '2026-03-01')
  assert.equal(Q.birthdays(q, '2028-02-01', 40)[0].on_day, '2028-02-29')
})

test('junk and missing birthdays are ignored, and archived people are hidden', () => {
  const { q } = withBirthdays(['None', null], ['Junk', 'sometime in March'], ['Real', '--03-05'])
  const id = Q.saveContact(q, { name: 'Archived', birthday: '--03-06' })
  Q.toggleArchived(q, id)
  assert.deepEqual(
    Q.birthdays(q, '2026-03-01', 30).map((r) => r.name),
    ['Real'],
  )
})

// ---------------------------------------------------------------- relations

const seed = () => {
  const q = freshDb()
  const ada = Q.saveContact(q, { name: 'Ada Lovelace' })
  const grace = Q.saveContact(q, { name: 'Grace Hopper' })
  return { q, ada, grace }
}

const seen = (q, id) => Q.relations(q, id).map((r) => `${r.name}: ${r.label ?? ''}`)

test('a connection reads the same from both sides', () => {
  const { q, ada, grace } = seed()
  Q.saveRelation(q, ada, grace, 'met at the Royal Society')
  assert.deepEqual(seen(q, ada), ['Grace Hopper: met at the Royal Society'])
  assert.deepEqual(seen(q, grace), ['Ada Lovelace: met at the Royal Society'])
})

test('re-adding a pair edits its label instead of duplicating it', () => {
  const { q, ada, grace } = seed()
  Q.saveRelation(q, ada, grace, 'colleagues')
  Q.saveRelation(q, grace, ada, 'co-authors') // opposite direction, same pair
  assert.deepEqual(seen(q, ada), ['Grace Hopper: co-authors'])
  assert.equal(q.value('SELECT count(*) FROM relations'), 1)
})

test('a blank label is stored as no label', () => {
  const { q, ada, grace } = seed()
  Q.saveRelation(q, ada, grace, '   ')
  assert.equal(Q.relations(q, ada)[0].label, null)
})

test('nonsense links are rejected', () => {
  const { q, ada } = seed()
  assert.throws(() => Q.saveRelation(q, ada, ada, 'me'), /themselves/)
  assert.throws(() => Q.saveRelation(q, ada, '', 'x'), /Pick who/)
  assert.throws(() => Q.saveRelation(q, ada, 9999, 'x'), /no longer exists/)
})

test('removing works from either side', () => {
  const { q, ada, grace } = seed()
  Q.saveRelation(q, ada, grace, 'friends')
  Q.deleteRelation(q, grace, ada)
  assert.deepEqual(seen(q, ada), [])
})

test('deleting a contact takes their connections with them', () => {
  const { q, ada, grace } = seed()
  Q.saveRelation(q, ada, grace, 'friends')
  Q.deleteContact(q, grace)
  assert.deepEqual(seen(q, ada), [])
})

test('the picker offers everyone active except the contact themselves', () => {
  const { q, ada, grace } = seed()
  const archived = Q.saveContact(q, { name: 'Zeno' })
  Q.toggleArchived(q, archived)
  assert.deepEqual(
    Q.others(q, ada).map((r) => r.name),
    ['Grace Hopper'],
  )
  assert.deepEqual(Q.others(q, grace).map((r) => r.name), ['Ada Lovelace'])
})

test('an archived contact keeps their connections and says so', () => {
  const { q, ada, grace } = seed()
  Q.saveRelation(q, ada, grace, 'friends')
  Q.toggleArchived(q, grace)
  assert.deepEqual(
    Q.relations(q, ada).map(({ id, name, archived, label }) => ({ id, name, archived, label })),
    [{ id: grace, name: 'Grace Hopper', archived: 1, label: 'friends' }],
  )
})

test('relations survive a migration of an already-populated database', () => {
  // MIGRATIONS[1] runs against a v1 database, not a fresh one.
  const q = freshDb()
  q.exec('DROP TABLE relations')
  q.exec('PRAGMA user_version = 1')
  Q.migrate(q)
  const ada = Q.saveContact(q, { name: 'Ada Lovelace' })
  const grace = Q.saveContact(q, { name: 'Grace Hopper' })
  Q.saveRelation(q, ada, grace, 'friends')
  assert.deepEqual(seen(q, ada), ['Grace Hopper: friends'])
})
