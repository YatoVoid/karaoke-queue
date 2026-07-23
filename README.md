# karaoke-queue

A local-network song-request queue for restaurants and venues, built to
replace expensive per-song paid karaoke systems (the common model in
Azerbaijan: ~2 manat per song added to the bill) with a cheap or free,
centrally-run alternative. Guests at a table request songs from a tablet;
requests queue FIFO behind a continuous ambient background playlist; a
separate player page drives the venue's actual speakers.

## Running it

```
npm install
npm start
```

Two environment variables control where it runs:

- `PORT` — defaults to `8080`.
- `DB_PATH` — defaults to `./data/karaoke-queue.sqlite`. The database is
  a plain SQLite file with no migration system; delete it to start over.

On startup it prints every LAN-reachable address it found, e.g.:

```
karaoke-queue listening on port 8080
Database: ./data/karaoke-queue.sqlite

There is no venue-registration step — pick any consistent
string as your venue id (e.g. "main") the first time you
visit an admin URL with it. Open one of these on a device
connected to the same network to set up tables:

  http://192.168.1.42:8080/admin/venues/main
```

There is no venue "registration" step — a venue is just whatever id
string you consistently use in your URLs (`main`, `downstairs`, anything).
The whole system is meant to run on one device on the venue's own
network (a laptop, or a phone acting as a WiFi hotspot) with tablets and
the output device connecting to that same network — no internet
connection is required for the system to function.

## Setting up a venue

1. Start the server (above) and open the printed admin URL
   (`/admin/venues/<your-venue-id>`) from any device on the network.
2. **Create tables** — a label, `public` (pays a per-use price, shown on
   the table's own page for staff to add to the bill at checkout) or
   `private` (always free, e.g. a room already charging a deposit).
3. **Pair each table** — click "Pair" next to a table, get its
   `/t/:token` URL. Point that specific tablet's browser (ideally kiosk
   mode, or just its bookmarked homepage) at that URL permanently. The
   token is what makes the anti-cheat guarantee work: refreshing the
   page, clearing cookies, or opening a private window all still load
   the same URL, so a table can never gain extra free requests that way,
   and a table's identity can't be spoofed by guessing another table's
   ID (the token is a long random value, not a number).
4. **Add background playlist tracks** — paste YouTube links/video IDs in
   the "Background playlist" section. This plays on a continuous loop
   whenever no table has an active request.
5. **Create a player token** and open the resulting `/player/:token` URL
   on whatever device is connected to the venue's speakers (Bluetooth or
   wired — that connection is the OS's job, outside this software).
   That page is the only thing that actually plays audio; leave it
   open and full-screen on that device.

## What guests see

Opening a paired `/t/:token` URL shows what's currently playing, the
live queue (so a table can see how many requests are ahead of them), and
a form to paste a YouTube link or video ID. A table can have one active
request at a time; once it's played (or cancelled), they can request
again. Everything updates live via WebSocket — no refreshing needed, and
refreshing doesn't help a table cheat the one-active-request rule either
way, since that's enforced server-side, not by anything the browser
remembers.

## Known limitations (honest, not hidden)

- **No typed song search.** Finding a song means pasting its YouTube link
  or video ID, not typing a title and picking from search results. Real
  search needs the YouTube Data API, which requires a Google Cloud
  credential this project doesn't have and can't provision — a venue
  operator with their own API key could wire this in as a future
  enhancement.
- **No payment processing.** The price shown on a public table's page is
  for staff to notice and manually add to the bill at checkout — this
  software has no card/payment integration.
- **Public-performance licensing is not addressed.** Playing music (from
  any source, YouTube included) in a commercial venue typically requires
  a PRO license (ASCAP/BMI-style, or a regional equivalent) independent
  of how the audio is sourced. That's a real business/legal
  responsibility for the venue to handle — this software has no way to
  resolve it and doesn't attempt to.
- **Admin routes have no login.** They're presumed to be operated by
  whoever is setting up the system, not exposed to guests. There's no
  authentication in front of `/admin/*`.
- **Not every YouTube video allows embedding** — some videos have
  embedding disabled by their uploader. The player detects this and
  automatically moves on to the next item rather than getting stuck.
- **No floor-plan editor.** Tables are a flat list (label, kind, price),
  not a visual layout you drag around.
