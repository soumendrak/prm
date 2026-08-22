import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as Q from '../js/queries.js'
import { freshDb, tracked, log, dueNames } from './adapter.mjs'

const seed = () => {
  const q = freshDb()
  const ada = Q.saveContact(q, {
    name: 'Ada Lovelace',
    email: 'ada@math.org',
    company: 'Analytical Engines',
    tags: 'Math, Friend',
  })
  Q.saveContact(q, { name: 'Grace Hopper', email: 'grace@navy.mil', company: 'US Navy' })
  return { q, ada }
}

const names = (q, filter) => Q.listContacts(q, filter).map((r) => r.name)

test('tags are trimmed, lowercased and deduped', () => {
  assert.deepEqual(Q.parseTags(' Work, friend ,WORK,, '), ['work', 'friend'])
  assert.deepEqual(Q.parseTags('  ,  '), [])
})

test('cadence rejects zero and junk', () => {
  assert.equal(Q.parseCadence(''), null)
  assert.equal(Q.parseCadence(' 90 '), 90)
  for (const bad of ['0', '-5', 'abc', '9.5']) {
    assert.throws(() => Q.parseCadence(bad), undefined, `${bad} should be rejected`)
  }
})

test('only ISO dates are accepted', () => {
  assert.ok(Q.isIsoDate('2026-08-22'))
  for (const bad of ['', '2026-8-22', '22-08-2026', '2026/08/22', '2026-08-22 10:00']) {
    assert.ok(!Q.isIsoDate(bad), `${bad} should be rejected`)
  }
})

test('a contact must have a name', () => {
  const q = freshDb()
  assert.throws(() => Q.saveContact(q, { name: '   ' }), /Name is required/)
})

test('search spans name, email, company and tag filtering composes', () => {
  const { q } = seed()
  assert.deepEqual(names(q, {}), ['Ada Lovelace', 'Grace Hopper'])
  for (const search of ['ada', 'navy.mil', 'Engines']) {
    assert.equal(names(q, { search }).length, 1, `query ${search}`)
  }
  assert.deepEqual(names(q, { tag: 'math' }), ['Ada Lovelace'])
  assert.deepEqual(names(q, { search: 'grace', tag: 'math' }), [])
})

test('search reaches into contact notes and interaction bodies', () => {
  const { q, ada } = seed()
  Q.saveContact(q, { id: ada, name: 'Ada Lovelace', notes: 'owes me a book on pigeons' })
  log(q, ada, 'meet', 'talked about COBOL', '2026-02-02')

  assert.deepEqual(names(q, { search: 'pigeons' }), ['Ada Lovelace'])
  assert.deepEqual(names(q, { search: 'cobol' }), ['Ada Lovelace'])
})

test('archived contacts are hidden until asked for', () => {
  const { q, ada } = seed()
  Q.toggleArchived(q, ada)
  assert.deepEqual(names(q, {}), ['Grace Hopper'])
  assert.deepEqual(names(q, { archived: true }), ['Ada Lovelace'])
})

test('retagging replaces the old set', () => {
  const { q, ada } = seed()
  assert.deepEqual(Q.contactTags(q, ada), ['friend', 'math'])
  Q.saveContact(q, { id: ada, name: 'Ada Lovelace', tags: 'mentor' })
  assert.deepEqual(Q.contactTags(q, ada), ['mentor'])
})

test('timeline is newest first and breaks same-day ties by id', () => {
  const { q, ada } = seed()
  log(q, ada, 'call', 'older', '2026-01-05')
  log(q, ada, 'note', 'same day, first', '2026-03-01')
  log(q, ada, 'note', 'same day, second', '2026-03-01')

  assert.deepEqual(
    Q.timeline(q, ada).map((i) => i.body),
    ['same day, second', 'same day, first', 'older'],
  )
})

test('deleting a contact takes its interactions with it', () => {
  const { q, ada } = seed()
  log(q, ada, 'note', 'gone soon', '2026-01-01')
  Q.deleteContact(q, ada)
  assert.deepEqual(Q.timeline(q, ada), [])
})

test('an interaction rejects unknown kinds and bad dates', () => {
  const { q, ada } = seed()
  assert.throws(() => Q.saveInteraction(q, { contact_id: ada, kind: 'telepathy' }), /kind/)
  assert.throws(
    () => Q.saveInteraction(q, { contact_id: ada, kind: 'note', happened_at: '01/02/2026' }),
    /YYYY-MM-DD/,
  )
})

test('due is last interaction plus cadence, inclusive of the due date', () => {
  const q = freshDb()
  tracked(q, 'Exactly due', 30, '2026-01-01') // due 2026-01-31
  tracked(q, 'Not yet', 30, '2026-01-20')
  tracked(q, 'Long overdue', 7, '2025-06-01')

  assert.deepEqual(dueNames(q, '2026-01-30'), ['Long overdue'])
  assert.deepEqual(dueNames(q, '2026-01-31'), ['Long overdue', 'Exactly due'])
  // Most overdue sorts first.
  assert.deepEqual(dueNames(q, '2026-03-01'), ['Long overdue', 'Exactly due', 'Not yet'])
})

test('contacts without a cadence never surface', () => {
  const { q } = seed()
  assert.deepEqual(Q.cadenced(q, '2030-01-01'), [])
})

test('someone never spoken to counts from when they were added', () => {
  const q = freshDb()
  tracked(q, 'Never called', 10, null) // created 2020-01-01

  assert.deepEqual(dueNames(q, '2020-01-05'), [])
  assert.deepEqual(dueNames(q, '2020-01-11'), ['Never called'])
  const row = Q.cadenced(q, '2020-01-11')[0]
  assert.equal(row.has_history, 0)
  assert.equal(row.days_since, 10)
})

test('snoozing hides a due contact until the snooze lapses', () => {
  const q = freshDb()
  const id = tracked(q, 'Snoozed', 30, '2026-01-01') // due 2026-01-31
  q.run("UPDATE contacts SET snoozed_until = '2026-02-07' WHERE id = ?", [id])

  assert.deepEqual(dueNames(q, '2026-02-01'), [])
  assert.equal(Q.splitDue(Q.cadenced(q, '2026-02-01')).upcoming[0].snoozed, 1)
  assert.deepEqual(dueNames(q, '2026-02-07'), ['Snoozed'])
})

test('a stale snooze cannot pull a contact forward', () => {
  const q = freshDb()
  const id = tracked(q, 'Old snooze', 30, '2026-01-01')
  q.run("UPDATE contacts SET snoozed_until = '2020-01-01' WHERE id = ?", [id])

  assert.deepEqual(dueNames(q, '2026-01-15'), [])
  assert.deepEqual(dueNames(q, '2026-01-31'), ['Old snooze'])
})

test('archived contacts drop off the due list', () => {
  const q = freshDb()
  const id = tracked(q, 'Gone', 1, '2020-01-01')
  assert.deepEqual(dueNames(q, '2026-01-01'), ['Gone'])
  Q.toggleArchived(q, id)
  assert.deepEqual(dueNames(q, '2026-01-01'), [])
})

test('snooze validates its range and zero un-snoozes', () => {
  const q = freshDb()
  const id = tracked(q, 'X', 30, '2026-01-01')
  assert.throws(() => Q.snooze(q, id, 999), /0-365/)
  Q.snooze(q, id, 7)
  assert.ok(Q.getContact(q, id).snoozed_until)
  Q.snooze(q, id, 0)
  assert.equal(Q.getContact(q, id).snoozed_until, null)
})

test('logging it records today and clears any snooze', () => {
  const q = freshDb()
  const id = tracked(q, 'X', 30, '2026-01-01')
  Q.snooze(q, id, 7)
  Q.touch(q, id)

  const latest = Q.timeline(q, id)[0]
  assert.equal(latest.kind, 'message')
  assert.equal(latest.happened_at, Q.today(q))
  assert.equal(Q.getContact(q, id).snoozed_until, null)
  // Clock reset: no longer due.
  assert.deepEqual(dueNames(q, Q.today(q)), [])
})
