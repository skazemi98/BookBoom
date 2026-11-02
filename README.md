# BookBoom — web version (3.12.0)

This folder is the whole app. It runs entirely in the browser, on phones, tablets and computers. No Python, no account, nothing uploaded: your books, notes, highlights, bookmarks, handwriting, flashcards, looked-up words and recordings are stored in the browser on each device, and they keep working offline.

The only things that go over the internet are the ones you ask for: word definitions (dictionaryapi.dev) and translations (Google Translate, with MyMemory as a fallback). Answers are saved, so a word you looked up once also works offline. Pronunciation check uses your browser's speech recognition (Chrome, Edge, Safari).

## What you can do
- **Library:** covers, a Continue reading card, shelves, tags, favourites, ratings, status (unread / reading / finished) and a progress bar for each book.
- **Reader:** continuous scrolling, fit width / fit page / zoom, two-page view (D), focus mode (F), page colour (N; with the dark theme, pages turn dark too), contents, page thumbnails, a side page or answer key next to the one you read (A), and Text view (X): the page as plain text that fits the screen.
- **Study:** highlights in 5 colours, notes, bookmarks (B), handwriting on the page (I), find in book (Ctrl+F) and search everything (/), flashcards with spaced repetition (Again / Hard / Good / Easy), fill-in-the-blank cards, meaning & translation for any word, and a list of the words you looked up (with **Make cards for all**).
- **Listen mode** (R): reads the book aloud sentence by sentence and highlights each one, with a voice for every speaker in a dialogue. Space pauses, [ and ] move one sentence. Repeat each sentence, pauses, a sleep timer, **dictation** (T: hear it, type it) and **pronunciation check** (M: say the sentence and see which words were right).
- **Speaking practice** (V): role-play dialogues, repeat after me, and record yourself.
- **Progress:** daily goal, streak, reading time, pages, a 30-day chart, and your pronunciation and dictation results.
- **Cards in and out:** export flashcards for Anki, Quizlet or a spreadsheet; import CSV, TSV or Anki text files (duplicates are skipped). Export a book's notes and cards as Markdown.

Search understands Persian and Arabic spellings: ي/ی, ك/ک, ة/ه, harakat, tatweel, the zero-width non-joiner (می‌خواهم finds میخواهم) and Persian digits.

## Three ways to open it

### 1. Straight from this folder (quickest)
Double-click **index.html**. BookBoom opens in your browser and everything works: reading, notes, highlights, flashcards, search, backup and restore.
Browsers don't let a file from a folder be installed as an app, so use way 2 or 3 to install it.

### 2. Installed on this computer (works offline)
- **Windows:** double-click **Start BookBoom.bat** (nothing to install; it uses Windows PowerShell).
- **Mac:** double-click **Start BookBoom.command** (the first time: right-click → Open). It needs Python 3; if it's missing, install it from python.org.
- **Linux:** run `./start-bookboom.sh` (needs Python 3).

Your browser opens **http://localhost:5051**. Click **Install app** in the top bar (or the install icon at the right of Chrome/Edge's address bar). After that BookBoom has its own icon and window and opens even when the launcher isn't running, offline too.
Only this computer can reach that address.

### 3. Online, for phones and every device (free)
Phones only install apps from an **https** address, so upload this folder to a free static host.

**GitHub Pages**
1. Create a repository (for example `bookboom`) and upload everything in this folder, including `.nojekyll`.
2. Settings → Pages → Source: *Deploy from a branch*, choose `main` and `/ (root)`, then Save.
3. After about a minute your app is at `https://<your-name>.github.io/bookboom/` (it works in a sub-folder like this).

**Cloudflare Pages:** Workers & Pages → Create → Pages → *Upload assets*, then drop this folder in. You get `https://<name>.pages.dev`. Cloudflare also applies the security headers in `_headers`.

Then install it:
- **Android (Chrome):** open the address and tap **Install app** in the top bar (or ⋮ → Install app). Once installed, you can share a PDF from Files or Gmail to **BookBoom** to add it.
- **iPhone/iPad (Safari):** Share → **Add to Home Screen**.
- **Computer (Chrome/Edge):** click **Install app** in the top bar.

## Your books on each device
Each address keeps its own library: the folder, localhost and your https link are three separate libraries, and so is each phone and each browser.
- Add PDFs with **Add books**, by dragging them onto the page, by pasting a PDF, or by sharing a PDF to the installed app. The same PDF is never added twice.
- The first time a book is added, the browser reads it once (page count, title, cover and text for search). Password-protected or broken PDFs are refused.
- **Your library lives only in this browser.** BookBoom asks the browser to keep it safe from automatic clean-up and reminds you once a week to make a backup. Clearing the site's data in the browser deletes the library.
- If the device runs out of space, BookBoom says so and nothing half-saved is kept.

## Backup and restore
- Settings → **Backup** makes one zip with everything (or a smaller one without the PDFs). Settings → **Restore from backup** brings it back on any device and replaces the library there.
- Backups from the desktop BookBoom (1.7 and newer) restore here, and backups made here restore in the desktop BookBoom. Both use the same `data.json` inside the zip. Backups larger than 4 GB are written as ZIP64, which the desktop app reads too.
- A backup without PDFs keeps the PDFs that are already on the device; books whose PDF is missing are listed after the restore, so you can add those PDFs again.
- A restore checks the whole file first: a damaged or cut-off zip, or a file that isn't a BookBoom backup, is refused and your library stays as it was. Every record is checked, so a backup from someone else can't run code or break the app.
- Not in backups: the app's look (theme, language), speech settings, and the pronunciation and dictation results on the Progress page. These stay in the browser.

## Security
- A strict Content-Security-Policy is set in `index.html` (for every host) and in `_headers` (Cloudflare Pages, Netlify), which also stops other sites from framing the app.
- Other websites can't restore over your library or change your notes, cards or settings: the app only answers those requests from its own page.

## Updating
Upload the new folder over the old one. Every build has its own offline copy, so the update arrives complete the next time the app is opened (or the time after, if it was already open).
