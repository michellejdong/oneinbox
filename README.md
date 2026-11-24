# OneInbox

One place for your email, chat and AI conversations, plus a reading list for papers, posts and forms. The same code runs as a desktop app and as a website.

## Open it on a Mac

1. Install Node.js (the LTS version, 22.13 or newer) from <https://nodejs.org>.
2. Double-click **OneInbox.command**. The first run takes about a minute to set up the desktop window.

The first time, macOS may say the file is from an unidentified developer: right-click it and choose **Open**.

While the app is running, the same inbox is also available in any browser on that computer at <http://localhost:4747>. It opens with sample conversations so you can look around before connecting anything; remove them under **Connections**.

## What each source can do

| Source | Reading | Replying | How it connects |
| --- | --- | --- | --- |
| Gmail | Live | Yes | Sign in with Google |
| Outlook | Live | Yes | Sign in with Microsoft |
| Teams | Live (chats, not channel posts) | Yes | Sign in with Microsoft; work accounts usually need IT approval |
| Slack | Live | Yes | A personal Slack app token; a workspace admin may need to approve it |
| Zoom | Live (Team Chat only) | Yes | Sign in with Zoom |
| Discord | Live, only in servers where you add your bot | As the bot | Bot token. Discord does not let any third-party app read personal DMs |
| WhatsApp | Imported chat exports | Business numbers only | "Export chat" from the phone, or Meta's Cloud API for a Business number |
| Claude, ChatGPT, Gemini | Imported from each service's export file | No | Import the export .zip |
| Muse, Llama, other assistants | Imported transcripts | No | Text or JSON file |

Step-by-step setup for each one is inside the app: **Connections** → click the source.

These limits come from the services themselves. Tools that get around them (for example by automating your personal WhatsApp or Discord login) break those services' terms and can get an account banned, so this app does not do that.

## Reading list

Open **Reading list** in the sidebar.

- **Save with one click:** drag the "Save to OneInbox" button to your browser's bookmarks bar, then click it on any page. Highlighted text is kept as the summary.
- **Or paste a link** into the box at the top of the list.
- Each item is filed automatically (Physics papers, AI / AI safety papers, AI / AI safety blog posts, Forms, and so on), given topic labels, and given an urgency. Forms are labelled with what they are for (registration, reimbursement, survey…).
- For each item you set **Not started / In progress / Done**, change the urgency (**Urgent / Soon / Whenever**), edit labels and the category, and keep notes.

arXiv links are looked up on arXiv for the title, authors, abstract and subject area. The filing rules are plain word lists in `server/classify.js`.

## Daily digest

**Daily digest** summarises what arrived and what probably needs a reply. Without any setup it uses a built-in summary. Under **Connections → Digest and general** you can add a Claude API key (message text is then sent to Anthropic to write the digest) or point it at a local Llama model through Ollama (nothing leaves the computer), and choose an hour for it to be written automatically.

## Using it as a website from other devices

By default the website is only reachable on the computer running the app. To reach it from a phone or another computer, run it on a server:

```
docker build -t oneinbox .
docker run -d -p 4747:4747 -v oneinbox-data:/data \
  -e BASE_URL=https://inbox.example.com \
  -e APP_PASSWORD='a long password' \
  -e APP_SECRET='a long random phrase' oneinbox
```

Put it behind HTTPS. The app refuses to start on a public address without `APP_PASSWORD`. The sign-in redirect addresses registered with Google, Microsoft and Zoom must use the hosted address. To make the desktop window show the hosted copy, set `ONEINBOX_URL` in `.env`.

Hosting means your messages and saved logins live on that server. For work accounts, check with your IT team first.

## Updating

Changes are made on a branch in GitHub and merged into `main`. To get the newest version, double-click **Update OneInbox.command** (or run `git pull`), then quit and reopen the app. Your messages and settings live in the `data` folder, which updates never touch.

## Privacy and safety

- Everything is stored in `data/oneinbox.db` on the computer running the app. Saved logins and API keys are encrypted with a key kept beside it (`data/secret.key`), or with `APP_SECRET` when hosted.
- The server only listens on this computer unless you host it, and it rejects requests that come from other websites.
- Opening a conversation marks it read here only; nothing changes in the original app until you send a reply.
- The `data` folder and `.env` are never uploaded to GitHub.

## What has been tested

Tested end to end: the interface, sample data, search, the digest, replying into sample conversations, the reading list and save button, password protection, the desktop window (on Linux), and importing export files built to match the Claude, ChatGPT, Gemini, Open WebUI and WhatsApp formats.

Not yet tested against real accounts: the live connections to Gmail, Outlook, Teams, Slack, Discord, Zoom and WhatsApp Business. They follow each service's published API, but expect some fixes the first time each one is connected. The Mac desktop build has not been run on a Mac yet.

## Where things are

```
server/index.js          web server and API
server/db.js             storage, search, encryption
server/sync.js           background fetching
server/digest.js         daily digest
server/library.js        reading list
server/classify.js       auto-filing rules for the reading list
server/importer.js       reading export files
server/connectors/       one file per source
web/                     the interface
desktop/main.js          desktop window
```

Requires Node.js 22.13 or newer. The server has no other dependencies; the desktop window uses Electron.
