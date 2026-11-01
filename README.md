# BookBoom — web version (2.1.0)

This folder is the whole app. It runs entirely in the browser, on phones, tablets and computers. No Python, no account, nothing uploaded: your books, notes, highlights, flashcards and recordings are stored on each device, and they keep working offline.

## New in 2.0 and 2.1
- **Listen mode** (R, or ⋯ → Listen): reads the book aloud sentence by sentence, highlights each sentence, gives every speaker in a dialogue a voice. Space pauses, [ and ] move one sentence, tap a sentence to jump there.
- **Pronunciation check** (the mic in the Listen bar, or M): read the sentence aloud and see which words were right. Works in Chrome, Edge and Safari.
- **Make cards for all** looked-up words in Study with one tap.
- Night reading: with the dark theme, pages turn dark too (N changes the page colour).
- Your pronunciation scores over the last two weeks on the Progress page.
- A weekly reminder to back up, since your library lives only in this browser.
- Security: a strict Content-Security-Policy (in `_headers`, used by Cloudflare Pages), and backups are checked so a file from someone else can't run code.

There are three ways to open it.

## 1. Straight from this folder (quickest)
Double-click **index.html**. BookBoom opens in your browser and everything works: reading, notes, highlights, flashcards, search, backup and restore.
Browsers don't let a file from a folder be installed as an app, so use way 2 or 3 to install it.

## 2. Installed on this computer (PWA, works offline)
- **Windows:** double-click **Start BookBoom.bat** (nothing to install; it uses Windows PowerShell).
- **Mac:** double-click **Start BookBoom.command** (the first time: right-click → Open). Uses the Python 3 that comes with macOS developer tools; if it's missing, install it from python.org.
- **Linux:** run `./start-bookboom.sh`.

Your browser opens **http://localhost:5051**. Click **Install app** in the top bar (or the install icon at the right of Chrome/Edge's address bar). After that BookBoom has its own icon and window and opens even when the launcher isn't running, offline too.
Only this computer can reach that address.

## 3. Online, for phones and every device (free)
Phones only install apps from an **https** address, so upload this folder to a free static host.

**GitHub Pages**
1. Create a repository (for example `bookboom`) and upload everything in this folder, including `.nojekyll`.
2. Settings → Pages → Source: *Deploy from a branch*, choose `main` and `/ (root)`, then Save.
3. After about a minute your app is at `https://<your-name>.github.io/bookboom/`.

**Cloudflare Pages:** Workers & Pages → Create → Pages → *Upload assets*, then drop this folder in. You get `https://<name>.pages.dev`.

Then install it:
- **Android (Chrome):** open the address and tap **Install app** in the top bar (or ⋮ → Install app).
- **iPhone/iPad (Safari):** Share → **Add to Home Screen**.
- **Computer (Chrome/Edge):** click **Install app** in the top bar.

## Your books on each device
Each address keeps its own library (the folder, localhost and your https link are three separate libraries, and so is each phone):
- Add PDFs with **Add books**, drag them onto the page, or share a PDF to the installed BookBoom from your phone's Files app.
- To bring your whole library in at once: Settings → **Restore from backup**, and choose your backup zip (for example *Ketabyar-My-Library.zip* or any BookBoom backup). It takes a few seconds.
- To move everything to another device: Settings → **Backup** on one, **Restore** on the other.
- Backups from the Python/desktop BookBoom 1.7+ restore here too, and the other way round.

## What changed in 1.7.1
- The app no longer depends on the service worker to work: it answers everything inside the page, so it works on the very first visit, after a hard refresh, in private windows, and when opened straight from the folder (it used to show "Start BookBoom first" or an empty, broken page).
- Added the launchers above so it can be installed on a computer without hosting it anywhere.
- Updates to the app now reach you on the next open (the old version kept serving a stale page).
