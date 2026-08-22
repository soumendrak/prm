<p align="center">
  <img src="icons/logo.svg" alt="" width="96" height="96">
</p>

<h1 align="center">PRM</h1>

<p align="center">
  <em>Who should I reach out to today?</em>
</p>

<p align="center">
  <a href="https://github.com/soumendrak/prm/actions/workflows/pages.yml">
    <img alt="Build status"
         src="https://github.com/soumendrak/prm/actions/workflows/pages.yml/badge.svg"></a>
  <img alt="No dependencies"
       src="https://img.shields.io/badge/dependencies-0-3fa46a">
  <img alt="Works offline"
       src="https://img.shields.io/badge/works-offline-4b7bec?logo=googlechrome&logoColor=fff">
</p>

<p align="center">
  <img alt="JavaScript"
       src="https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=000">
  <img alt="SQLite"
       src="https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=fff">
  <img alt="WebAssembly"
       src="https://img.shields.io/badge/WebAssembly-654FF0?logo=webassembly&logoColor=fff">
  <img alt="Progressive Web App"
       src="https://img.shields.io/badge/PWA-5A0FC8?logo=pwa&logoColor=fff">
  <img alt="GitHub Pages"
       src="https://img.shields.io/badge/GitHub%20Pages-222?logo=githubpages&logoColor=fff">
</p>

---

A single-user personal relationship manager. Log who you talk to, set a
keep-in-touch cadence per person, and open **Today** to see who's due.

It is a plain web page. There is no server and no account: SQLite runs inside
your browser and stores its database in [OPFS][opfs] on your device. Load it
once and it works offline forever, including on a plane. Your contacts never
leave your phone.

[opfs]: https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system

## Installing it on your Android phone

1. Publish it (see below) or open the hosted URL in **Chrome**.
2. Chrome menu → **Install app**.

You get a real icon on your home screen and a standalone window with no browser
chrome. After that first load, it never needs the network again.

Nothing to install from F-Droid or Obtainium, because there is no APK — the
whole app is the web page. iOS works too, via Safari's **Add to Home Screen**.

## Publishing your own copy

Push this repository to GitHub and turn on Pages (**Settings → Pages → Source:
GitHub Actions**). The included workflow runs the tests and publishes on every
push to `main`. Your app appears at `https://<you>.github.io/<repo>/`.

Pages serves over HTTPS, which matters: browsers only allow service workers and
app installation in a secure context. Any static host works — Netlify, a file
server, anything — as long as it is HTTPS or `localhost`.

Only the page itself is ever fetched from GitHub. Your data is created on the
device and stays there.

## Working on it

```sh
npm test        # 30 tests, no dependencies
npm run serve   # http://localhost:8080
```

`localhost` counts as a secure context, so the service worker and OPFS both
work in local development.

There is no build step and no dependencies to install. The one vendored library
is the official SQLite WebAssembly build in `vendor/`.

Two things worth knowing if you change the code:

- **SQLite runs in a Web Worker, not the main thread.** OPFS synchronous access
  handles — the only way to persist SQLite without `COOP`/`COEP` response
  headers a static host cannot set — exist solely inside workers. `js/rpc.js`
  is the main thread's client for it.
- **The service worker caches the app shell**, so a stale copy can survive a
  refresh during development. Bump `VERSION` in `sw.js`, or clear site data.

## Backups

Your database lives in this browser on this device. That means **clearing site
data deletes it**, and reinstalling your phone loses it.

**Data → Export backup** downloads a real `.sqlite3` file. Keep it somewhere
else. **Restore** reads one back, replacing everything currently stored.

The exported file is an ordinary SQLite database, so you can also open it with
any SQLite tool:

```sh
sqlite3 prm-20260822.sqlite3 'SELECT name, cadence_days FROM contacts'
```

## Importing your contacts

Google Contacts → **Export** → **Google CSV**, then **Contacts → Import from
Google**. You get a preview before anything is written, and re-importing the
same file is a no-op — people are matched by email, then by exact name. Both
the current and pre-2022 Google export formats are handled, and Google labels
become tags.

Imported contacts have no cadence, so nothing nags you until you set one.

## Layout

```
index.html          shell and navigation
js/app.js           views and hash routing
js/rpc.js           main-thread client for the worker
js/worker.js        the worker that owns the database
js/queries.js       every SQL statement, and the due-date logic
js/csv.js           Google CSV parser
test/               node --test, run against node's built-in SQLite
vendor/             official SQLite WASM build
sw.js               offline app-shell cache
```

The tests run `js/queries.js` against node's built-in SQLite, so the exact SQL
the browser executes is what gets verified — no browser or mocks required.
