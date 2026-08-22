// UI: a hash-routed view layer over the database worker.

import { call } from './rpc.js'

const app = document.getElementById('app')

// ---------------------------------------------------------------- rendering

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )

/**
 * Marks a string as already-safe HTML, so `html` will not escape it again.
 * `toString` is what lets the result be assigned straight to `innerHTML`.
 */
const raw = (s) => ({ raw: String(s), toString: () => String(s) })

/**
 * Escapes every interpolation, unless it is already-safe HTML produced by
 * `html`, `raw` or `list`. Returning a safe-HTML object rather than a string
 * is what lets templates nest without their markup being escaped.
 * `null`/`undefined`/`false` render as nothing, so `${cond && html`…`}` works.
 */
function html(strings, ...values) {
  let out = strings[0]
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    out += (v == null || v === false ? '' : v.raw !== undefined ? v.raw : esc(v)) + strings[i + 1]
  }
  return raw(out)
}

const list = (items, fn) => raw(items.map((x, i) => String(fn(x, i))).join(''))

// ---------------------------------------------------------------- labels

function dueLabel(r) {
  const d = r.days_overdue
  if (d === 0) return 'due today'
  if (d === 1) return '1 day overdue'
  if (d > 1) return `${d} days overdue`
  if (d === -1) return 'due tomorrow'
  return `due in ${-d} days`
}

const awayLabel = (d) => (d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`)

function sinceLabel(r) {
  const what = r.has_history ? 'spoke' : 'added'
  if (r.days_since === 0) return `${what} today`
  if (r.days_since === 1) return `${what} yesterday`
  return `${what} ${r.days_since} days ago`
}

const subtitle = (c) =>
  c.title && c.company ? `${c.title} at ${c.company}` : c.title || c.company || c.email || ''

// ---------------------------------------------------------------- views

async function viewToday() {
  const { due, upcoming, birthdays } = await call('home')
  const { contacts } = await call('counts')
  const tracked = due.length + upcoming.length

  const row = (c) => html`
    <li>
      <div class="who">
        <a class="name" href="#/contacts/${c.id}">${c.name}</a>
        <span class="sub">${sinceLabel(c)} &middot; every ${c.cadence_days} days</span>
      </div>
      <span class="when ${c.days_overdue >= 0 ? 'overdue' : 'later'}">${dueLabel(c)}</span>
      <div class="acts">
        <button data-touch="${c.id}" data-name="${c.name}">Logged it</button>
        <button class="quiet" data-snooze="${c.id}" data-days="${c.snoozed ? 0 : 7}">
          ${c.snoozed ? 'unsnooze' : 'snooze 7d'}
        </button>
      </div>
    </li>`

  const bday = (b) => html`
    <li>
      <div class="who">
        <a class="name" href="#/contacts/${b.id}">${b.name}</a>
        <span class="sub">${b.turning ? `turning ${b.turning}` : b.on_day}</span>
      </div>
      <span class="when ${b.days_away === 0 ? 'overdue' : 'later'}">${awayLabel(b.days_away)}</span>
    </li>`

  let empty = ''
  if (!due.length) {
    if (tracked) empty = html`<p class="muted empty">Nobody's due. Nice.</p>`
    else if (contacts)
      empty = html`<p class="muted empty">
        No keep-in-touch reminders yet &mdash; set a cadence on a
        <a href="#/contacts">contact</a> to start tracking them.
      </p>`
    else
      empty = html`<p class="muted empty">
        Nothing here yet. <a href="#/contacts/new">Add your first contact</a>.
      </p>`
  }

  app.innerHTML = html`
    <h1>Today</h1>
    ${due.length ? html`<ul class="due-list">${list(due, row)}</ul>` : raw(empty)}
    ${birthdays.length
      ? html`<h2>Birthdays</h2>
          <ul class="due-list">${list(birthdays, bday)}</ul>`
      : ''}
    ${upcoming.length
      ? html`<h2>Coming up</h2>
          <ul class="due-list">${list(upcoming, row)}</ul>`
      : ''}`
}

let searchTimer = null

async function viewContacts(params) {
  const filter = {
    search: params.get('q') ?? '',
    tag: params.get('tag') ?? '',
    archived: params.get('archived') === '1',
  }
  const { rows, tags } = await call('listContacts', filter)

  app.innerHTML = html`
    <div class="page-head">
      <h1>${filter.archived ? 'Archived' : 'Contacts'}</h1>
      <a class="btn" href="#/contacts/new">Add contact</a>
    </div>
    <form class="filters" id="filters" onsubmit="return false">
      <input type="search" name="q" value="${filter.search}" autofocus
             placeholder="Search name, email, company&hellip;">
      <select name="tag">
        <option value="">All tags</option>
        ${list(
          tags,
          (t) => html`<option value="${t}" ${raw(t === filter.tag ? 'selected' : '')}>${t}</option>`,
        )}
      </select>
    </form>
    <div id="rows">${raw(contactRows(rows, filter.search))}</div>
    <p class="muted footnote">
      ${filter.archived
        ? raw(html`<a href="#/contacts">Back to active contacts</a>`)
        : raw(
            html`<a href="#/contacts?archived=1">View archived</a> &middot;
              <a href="#/import">Import contacts</a>`,
          )}
    </p>`

  const form = document.getElementById('filters')
  const rerun = async () => {
    const next = {
      search: form.q.value,
      tag: form.tag.value,
      archived: filter.archived,
    }
    const res = await call('listContacts', next)
    document.getElementById('rows').innerHTML = contactRows(res.rows, next.search)
  }
  form.q.addEventListener('input', () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(rerun, 200)
  })
  form.tag.addEventListener('change', rerun)
}

function contactRows(rows, search) {
  if (!rows.length) {
    return html`<p class="muted empty">
      ${search ? `Nothing matches “${search}”.` : 'No contacts yet.'}
    </p>`
  }
  return html`<ul class="contact-list">
    ${list(
      rows,
      (c) => html`
        <li>
          <a href="#/contacts/${c.id}">
            <span class="name">${c.name}</span>
            <span class="sub">${subtitle(c)}</span>
            ${c.tags ? raw(html`<span class="tags">${c.tags}</span>`) : ''}
          </a>
        </li>`,
    )}
  </ul>`
}

const KINDS = ['note', 'call', 'meet', 'email', 'message']

async function viewContact(id) {
  const data = await call('getContact', id)
  if (!data) return notFound()
  const { contact: c, tags, timeline, relations, others, today } = data

  const field = (label, value, href) =>
    value
      ? html`<dt>${label}</dt>
          <dd>${href ? raw(html`<a href="${href}${value}">${value}</a>`) : value}</dd>`
      : ''

  app.innerHTML = html`
    <p class="crumb"><a href="#/contacts">&larr; Contacts</a></p>
    <div class="page-head">
      <h1>${c.name} ${c.archived ? raw('<span class="pill">archived</span>') : ''}</h1>
      <a class="btn" href="#/contacts/${c.id}/edit">Edit</a>
    </div>

    ${tags.length
      ? html`<p class="tags">
          ${list(tags, (t) => html`<a class="pill" href="#/contacts?tag=${t}">${t}</a>`)}
        </p>`
      : ''}

    <dl class="fields">
      ${raw(field('Email', c.email, 'mailto:'))}
      ${raw(field('Phone', c.phone, 'tel:'))}
      ${raw(field('Company', c.company))}
      ${raw(field('Title', c.title))}
      ${raw(field('Birthday', c.birthday))}
      ${c.cadence_days
        ? html`<dt>Keep in touch</dt>
            <dd>every ${c.cadence_days} days
              ${c.snoozed_until
                ? raw(html`<span class="muted">&middot; snoozed until ${c.snoozed_until}</span>`)
                : ''}
            </dd>`
        : ''}
    </dl>

    ${c.notes ? html`<p class="notes">${c.notes}</p>` : ''}

    <h2>Connections</h2>
    ${relations.length
      ? html`<ul class="contact-list rel-list">
          ${list(
            relations,
            (r) => html`
              <li>
                <div class="row">
                  <a class="name" href="#/contacts/${r.id}">${r.name}</a>
                  <span class="sub">${[r.label, r.archived ? 'archived' : ''].filter(Boolean).join(' · ')}</span>
                  <button class="quiet" data-del-relation="${r.id}" data-from="${c.id}"
                          data-name="${r.name}">remove</button>
                </div>
              </li>`,
          )}
        </ul>`
      : ''}
    ${others.length
      ? html`<form class="log" id="rel-form">
          <div class="log-top">
            <select name="other" required>
              <option value="">Connect to&hellip;</option>
              ${list(others, (o) => html`<option value="${o.id}">${o.name}</option>`)}
            </select>
            <input name="label" placeholder="how? sister, ex-colleague&hellip;">
            <button type="submit">Link</button>
          </div>
        </form>`
      : html`<p class="muted empty">Add another contact to start linking people.</p>`}

    <h2>History</h2>
    <form class="log" id="log-form">
      <div class="log-top">
        <select name="kind">
          ${list(KINDS, (k) => html`<option value="${k}">${k}</option>`)}
        </select>
        <input type="date" name="happened_at" value="${today}">
        <button type="submit">Log it</button>
      </div>
      <textarea name="body" rows="2" placeholder="What happened?"></textarea>
    </form>

    ${timeline.length
      ? html`<ol class="timeline">
          ${list(
            timeline,
            (i) => html`
              <li>
                <div class="meta">
                  <time>${i.happened_at}</time>
                  <span class="pill">${i.kind}</span>
                  <a class="quiet" href="#/interactions/${i.id}/edit">edit</a>
                  <button class="quiet" data-del-interaction="${i.id}" data-kind="${i.kind}">
                    delete
                  </button>
                </div>
                ${i.body ? raw(html`<p class="body">${i.body}</p>`) : ''}
              </li>`,
          )}
        </ol>`
      : html`<p class="muted empty">No interactions logged yet.</p>`}

    <div class="danger">
      <button data-archive="${c.id}">${c.archived ? 'Unarchive' : 'Archive'}</button>
      <button data-delete-contact="${c.id}" data-name="${c.name}">Delete</button>
    </div>`

  document.getElementById('rel-form')?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const f = e.target
    await guard(() => call('saveRelation', id, Number(f.other.value), f.label.value))
    render()
  })

  document.getElementById('log-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const f = e.target
    await guard(() =>
      call('saveInteraction', {
        contact_id: id,
        kind: f.kind.value,
        body: f.body.value,
        happened_at: f.happened_at.value,
      }),
    )
    render()
  })
}

async function viewContactForm(id) {
  const data = id ? await call('getContact', id) : null
  if (id && !data) return notFound()
  const c = data?.contact ?? {}
  const tags = data ? data.tags.join(', ') : ''

  app.innerHTML = html`
    <h1>${id ? `Edit ${c.name}` : 'Add contact'}</h1>
    <p class="error" id="err" hidden></p>
    <form class="stack" id="contact-form">
      <label>Name<input name="name" value="${c.name ?? ''}" required autofocus></label>
      <label>Email<input type="email" name="email" value="${c.email ?? ''}"></label>
      <label>Phone<input type="tel" name="phone" value="${c.phone ?? ''}"></label>
      <label>Company<input name="company" value="${c.company ?? ''}"></label>
      <label>Title<input name="title" value="${c.title ?? ''}"></label>
      <label>Birthday<input type="date" name="birthday" value="${c.birthday ?? ''}"></label>
      <label>Keep in touch every
        <input type="number" name="cadence_days" min="1" list="cadences"
               value="${c.cadence_days ?? ''}" placeholder="days">
        <datalist id="cadences">
          <option value="30">monthly</option>
          <option value="90">quarterly</option>
          <option value="180">twice a year</option>
          <option value="365">yearly</option>
        </datalist>
        <small class="muted">Leave blank for no reminders.</small>
      </label>
      <label>Tags<input name="tags" value="${tags}" placeholder="work, climbing, mentor">
        <small class="muted">Comma separated. New tags are created as you use them.</small>
      </label>
      <label>Notes<textarea name="notes" rows="4">${c.notes ?? ''}</textarea></label>
      <div class="actions">
        <button type="submit">Save</button>
        <a href="${id ? `#/contacts/${id}` : '#/contacts'}">Cancel</a>
      </div>
    </form>`

  document.getElementById('contact-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const f = new FormData(e.target)
    const form = Object.fromEntries(f.entries())
    if (id) form.id = id
    const saved = await guard(() => call('saveContact', form))
    if (saved) go(`#/contacts/${saved}`)
  })
}

async function viewInteractionForm(id) {
  const found = await findInteraction(id)
  if (!found) return notFound()
  const { interaction: i, contact } = found

  app.innerHTML = html`
    <p class="crumb"><a href="#/contacts/${contact.id}">&larr; ${contact.name}</a></p>
    <h1>Edit ${i.kind}</h1>
    <p class="error" id="err" hidden></p>
    <form class="stack" id="interaction-form">
      <label>Kind
        <select name="kind">
          ${list(
            KINDS,
            (k) => html`<option value="${k}" ${raw(k === i.kind ? 'selected' : '')}>${k}</option>`,
          )}
        </select>
      </label>
      <label>Date<input type="date" name="happened_at" value="${i.happened_at}" required></label>
      <label>Notes<textarea name="body" rows="6">${i.body ?? ''}</textarea></label>
      <div class="actions">
        <button type="submit">Save</button>
        <a href="#/contacts/${contact.id}">Cancel</a>
      </div>
    </form>`

  document.getElementById('interaction-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const f = new FormData(e.target)
    const ok = await guard(() =>
      call('saveInteraction', { id: i.id, contact_id: contact.id, ...Object.fromEntries(f) }),
    )
    if (ok) go(`#/contacts/${contact.id}`)
  })
}

/** Interactions are only ever reached from a contact, so look them up there. */
async function findInteraction(id) {
  const owner = await call('interactionOwner', id)
  if (!owner) return null
  const data = await call('getContact', owner)
  const interaction = data.timeline.find((i) => i.id === id)
  return interaction ? { interaction, contact: data.contact } : null
}

// ---------------------------------------------------------------- import

let importedRows = null

async function viewImport() {
  app.innerHTML = html`
    <p class="crumb"><a href="#/contacts">&larr; Contacts</a></p>
    <h1>Import contacts</h1>
    <p class="error" id="err" hidden></p>
    <ol class="steps muted">
      <li>Open <a href="https://contacts.google.com/" target="_blank" rel="noreferrer">Google
        Contacts</a>, or the address book on your phone. Choose
        <strong>Export</strong>, then the <strong>vCard</strong> format.</li>
      <li>Or, on <a href="https://www.linkedin.com/mypreferences/d/download-my-data"
        target="_blank" rel="noreferrer">LinkedIn</a>, choose <strong>Get a copy of your
        data</strong> &rarr; <strong>Connections</strong>, and unzip the email they send.</li>
      <li>Pick the downloaded <code>.vcf</code> or <code>Connections.csv</code> below.</li>
    </ol>
    <form class="stack" id="import-form">
      <label>vCard or LinkedIn CSV
        <input type="file" name="file"
               accept=".vcf,.vcard,.csv,text/vcard,text/x-vcard,text/csv" required>
      </label>
      <div class="actions"><button type="submit">Preview</button></div>
    </form>
    <p class="muted footnote">
      Nothing is saved until you confirm. People you already have are left alone,
      apart from blanks the file can fill in, so re-importing is harmless.
    </p>`

  document.getElementById('import-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const file = e.target.file.files[0]
    if (!file) return
    await guard(async () => {
      importedRows = await call('planImport', await file.text())
      go('#/import/preview')
    })
  })
}

async function viewImportPreview() {
  if (!importedRows) return go('#/import')
  const rows = importedRows
  const ready = rows.filter((r) => !r.skip)
  const fresh = ready.filter((r) => !r.merge).length
  const merging = ready.length - fresh

  app.innerHTML = html`
    <p class="crumb"><a href="#/import">&larr; Choose a different file</a></p>
    <h1>Ready to import</h1>
    <p class="tally">
      <strong>${fresh}</strong> to add
      ${merging ? raw(html`<span class="muted">&middot; ${merging} to fill in</span>`) : ''}
      ${rows.length - ready.length
        ? raw(html`<span class="muted">&middot; ${rows.length - ready.length} skipped</span>`)
        : ''}
    </p>
    ${!rows.length
      ? html`<p class="muted empty">This file has no contact rows in it.</p>`
      : !ready.length
        ? html`<p class="muted empty">
            Nothing new in this file &mdash; you already have everyone in it.
          </p>`
        : ''}
    <div class="scroll">
      <ul class="contact-list">
        ${list(
          rows,
          (r) => html`
            <li class="${r.skip ? 'skipped' : ''}">
              <div class="row">
                <span class="name">${r.name}</span>
                <span class="sub">${[r.email, r.company].filter(Boolean).join(' · ')}</span>
                <span class="tags">
                  ${r.skip ?? (r.merge ? `fills in ${r.fills.join(', ')}` : r.tags.join(', '))}
                </span>
              </div>
            </li>`,
        )}
      </ul>
    </div>
    <p class="actions">
      <button id="confirm-import" ${raw(ready.length ? '' : 'disabled')}>
        Import ${ready.length} contact${ready.length === 1 ? '' : 's'}
      </button>
      <a href="#/contacts">Cancel</a>
    </p>`

  document.getElementById('confirm-import').addEventListener('click', async () => {
    const n = await guard(() => call('runImport', rows))
    importedRows = null
    if (n !== undefined) {
      app.innerHTML = html`
        <h1>Imported</h1>
        <p class="tally">
          <strong>${n.added}</strong> contact${n.added === 1 ? '' : 's'} added
          ${n.updated ? raw(html`<span class="muted">&middot; ${n.updated} filled in</span>`) : ''}
        </p>
        <p class="muted">
          Imported contacts have no keep-in-touch cadence yet, so nothing will
          nag you until you set one.
        </p>
        <p class="actions"><a class="btn" href="#/contacts">See your contacts</a></p>`
    }
  })
}

// ---------------------------------------------------------------- data

async function viewSettings() {
  const c = await call('counts')
  app.innerHTML = html`
    <h1>Your data</h1>
    <p class="error" id="err" hidden></p>
    <dl class="fields">
      <dt>Contacts</dt><dd>${c.contacts}</dd>
      <dt>Archived</dt><dd>${c.archived}</dd>
      <dt>Interactions</dt><dd>${c.interactions}</dd>
    </dl>
    <p class="muted">
      Everything lives in this browser on this device, and never leaves it.
      That also means clearing site data deletes it &mdash; export a backup
      somewhere safe now and then.
    </p>
    <p class="actions">
      <button id="export">Export backup</button>
      <button class="quiet" id="export-vcf">Export contacts (.vcf)</button>
    </p>
    <p class="muted footnote">
      The backup is the whole database, and is what <strong>Restore</strong>
      reads. The vCard file is just the contacts, for importing somewhere else.
    </p>

    <h2>Restore</h2>
    <p class="muted">
      Replaces everything currently stored with the contents of a backup file.
    </p>
    <form class="stack" id="restore-form">
      <label>Backup file<input type="file" name="file" accept=".sqlite3,.db" required></label>
      <div class="actions"><button type="submit">Restore</button></div>
    </form>`

  document.getElementById('export').addEventListener('click', async () => {
    const bytes = await call('exportDb')
    download(new Blob([bytes], { type: 'application/x-sqlite3' }), `prm-${await stamp()}.sqlite3`)
  })

  document.getElementById('export-vcf').addEventListener('click', async () => {
    const vcf = await call('exportVcf')
    if (!vcf) return alert('No contacts to export yet.')
    download(new Blob([vcf], { type: 'text/vcard' }), `prm-${await stamp()}.vcf`)
  })

  document.getElementById('restore-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const file = e.target.file.files[0]
    if (!file) return
    if (!confirm('Replace everything currently stored with this backup?')) return
    await guard(async () => {
      const bytes = new Uint8Array(await file.arrayBuffer())
      await call('importDb', bytes)
      render()
    })
  })
}

const stamp = async () => (await call('today')).replaceAll('-', '')

function download(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = Object.assign(document.createElement('a'), { href: url, download: filename })
  a.click()
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------- plumbing

const notFound = () => {
  app.innerHTML = html`<p class="muted empty">That page doesn't exist.
    <a href="#/">Back to Today</a>.</p>`
}

/** Runs an action, showing any thrown message instead of a blank screen. */
async function guard(fn) {
  const box = document.getElementById('err')
  try {
    const out = await fn()
    return out === undefined ? true : out
  } catch (e) {
    if (box) {
      box.textContent = e.message
      box.hidden = false
      box.scrollIntoView({ block: 'nearest' })
    } else {
      alert(e.message)
    }
    return undefined
  }
}

const go = (hash) => {
  if (location.hash === hash) render()
  else location.hash = hash
}

// ---------------------------------------------------------------- feedback

let toastTimer = null

/** Brief confirmation that an action landed, since most of them re-render the
 *  view and would otherwise give no sign anything happened. */
function toast(message) {
  const el = document.getElementById('toast')
  el.textContent = message
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200)
}

// ---------------------------------------------------------------- theme

const THEMES = ['auto', 'light', 'dark']

/** `auto` follows the OS; the other two override it. Stored so the choice
 *  survives a reload, and re-applied in index.html before first paint. */
function setTheme(mode) {
  if (mode === 'auto') {
    delete document.documentElement.dataset.theme
    localStorage.removeItem('prm-theme')
  } else {
    document.documentElement.dataset.theme = mode
    localStorage.setItem('prm-theme', mode)
  }
  const btn = document.getElementById('theme-toggle')
  btn.title = `Theme: ${mode}`
  btn.setAttribute('aria-label', `Theme: ${mode}. Activate to change.`)
}

document.getElementById('theme-toggle').addEventListener('click', () => {
  const current = document.documentElement.dataset.theme ?? 'auto'
  const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]
  setTheme(next)
  toast(`${next[0].toUpperCase()}${next.slice(1)} theme`)
})

setTheme(document.documentElement.dataset.theme ?? 'auto')

/** The sticky search bar has to sit exactly below the sticky header, and the
 *  header's height depends on the font and viewport, so measure it. */
function measureHeader() {
  const h = document.querySelector('header').offsetHeight
  document.documentElement.style.setProperty('--header-h', `${h}px`)
}

addEventListener('resize', measureHeader)
measureHeader()

// Row actions, delegated once rather than bound per row.
app.addEventListener('click', async (e) => {
  const b = e.target.closest('button')
  if (!b) return

  if (b.dataset.touch) {
    await call('touch', Number(b.dataset.touch))
    toast(`Logged \u2014 ${b.dataset.name}`)
    return render()
  }
  if (b.dataset.snooze) {
    const days = Number(b.dataset.days)
    await call('snooze', Number(b.dataset.snooze), days)
    toast(days ? `Snoozed for ${days} days` : 'Snooze cleared')
    return render()
  }
  if (b.dataset.archive) {
    await call('toggleArchived', Number(b.dataset.archive))
    toast('Archive updated')
    return render()
  }
  if (b.dataset.delRelation) {
    if (!confirm(`Remove the connection to ${b.dataset.name}?`)) return
    await call('deleteRelation', Number(b.dataset.from), Number(b.dataset.delRelation))
    toast('Connection removed')
    return render()
  }
  if (b.dataset.delInteraction) {
    if (!confirm(`Delete this ${b.dataset.kind}?`)) return
    await call('deleteInteraction', Number(b.dataset.delInteraction))
    toast('Entry deleted')
    return render()
  }
  if (b.dataset.deleteContact) {
    if (!confirm(`Delete ${b.dataset.name} and their whole history? This cannot be undone.`)) return
    await call('deleteContact', Number(b.dataset.deleteContact))
    toast(`${b.dataset.name} deleted`)
    return go('#/contacts')
  }
})

/** Light up the tab for the section being viewed. */
function markTab(section) {
  for (const a of document.querySelectorAll('.tabs a')) {
    if (a.dataset.route === section) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  }
}

let lastPath = null

async function render() {
  const [path, query] = (location.hash.slice(1) || '/').split('?')
  const params = new URLSearchParams(query)
  const parts = path.split('/').filter(Boolean)

  // Importing lives under the Contacts tab.
  markTab(parts[0] === 'import' ? 'contacts' : (parts[0] ?? ''))

  // Landing mid-page after following a link is disorienting on a phone.
  if (path !== lastPath) {
    lastPath = path
    scrollTo({ top: 0 })
  }

  try {
    if (!parts.length) return await viewToday()
    if (parts[0] === 'contacts') {
      if (!parts[1]) return await viewContacts(params)
      if (parts[1] === 'new') return await viewContactForm(null)
      const id = Number(parts[1])
      if (!Number.isInteger(id)) return notFound()
      if (parts[2] === 'edit') return await viewContactForm(id)
      return await viewContact(id)
    }
    if (parts[0] === 'interactions' && parts[2] === 'edit') {
      return await viewInteractionForm(Number(parts[1]))
    }
    if (parts[0] === 'import') {
      return parts[1] === 'preview' ? await viewImportPreview() : await viewImport()
    }
    if (parts[0] === 'settings') return await viewSettings()
    notFound()
  } catch (e) {
    app.innerHTML = html`<p class="error">${e.message}</p>`
  }
}

addEventListener('hashchange', render)
render()

if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('./sw.js'))
}
