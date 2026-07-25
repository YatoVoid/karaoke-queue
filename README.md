# karaoke-queue

![Mockup of the system in a restaurant](screenshots/mockup.png)
*This image was AI generated, sadly, that guy's laptop is long af*

A local-network song-request queue for restaurants and venues, built to
replace expensive per-song paid karaoke systems (the common model in
Azerbaijan: ~2 manat per song added to the bill) with a cheap or free,
centrally-run alternative. Guests at a table request songs from a tablet;
requests queue FIFO behind a continuous ambient background playlist; a
separate player page drives the venue's actual speakers.

## Quick start

**Requires Node.js 22.5 or newer** (it uses the built-in `node:sqlite`
module — no database to install separately). Check with `node --version`.

```
npm install
npm start
```

That's it — no config file, no signup, no API keys. The terminal prints
a URL like this:

```
karaoke-queue listening on port 8080
Database: ./data/karaoke-queue.sqlite

There is no venue-registration step. Pick any consistent
string as your venue id (e.g. "main") the first time you
visit an admin URL with it. Open one of these on a device
connected to the same network to set up tables:

  http://192.168.1.42:8080/admin/venues/main
```

Open that URL (on the same device or any other device on the same
network) and follow the numbered sections on the page — see
"Setting up a venue" below for what each one does. There's no
venue "registration" step: a venue is just whatever id string you
consistently use in your URLs (`main`, `downstairs`, anything).

The whole system is meant to run on one device on the venue's own
network (a laptop, or a phone acting as a WiFi hotspot), with tablets
and the output device connecting to that same network. No internet
connection is required for the system to run, though a few features
(fetching real YouTube titles, embedding videos) do need the *venue's*
network to reach the internet, same as any other YouTube playback.

Two environment variables control where it runs, if you need them:

- `PORT`: defaults to `8080`.
- `DB_PATH`: defaults to `./data/karaoke-queue.sqlite`. The database is
  a plain SQLite file with no migration system; delete it to start over.

## Setting up a venue

![Admin page: currency, tables list with short pairing links, player link, background playlist](screenshots/admin.png)

Open the admin URL from the quick start above. The page itself walks
you through this in order:

1. **Set the currency** so prices show as an actual amount (e.g. `$2`)
   instead of a bare number.
2. **Add your tables.** Each one is either `public` (pays a per-use
   price) or `private` (always free — e.g. a room that's already
   charging a deposit). After adding a table, tap **Pair** to get its
   link (something short like `/t/K7X4MN`) and open that link on that
   table's device — a tablet in kiosk mode, or just its bookmarked
   homepage. Use the **Copy** button next to it if you're setting the
   link up from a different device than the one you're pairing.
   The admin table list also shows a running "Billed" count and total,
   so staff can read it directly at checkout instead of asking the
   guest what they played.
3. **Create a player link** and open it on whatever device is
   connected to the venue's speakers (Bluetooth or wired — that
   connection is the OS's job, outside this software). That page is
   the only thing that actually plays audio; leave it open and
   full-screen on that device. Like table links, it's a short code you
   can type into a TV browser by hand if you have to.
4. **Add background playlist tracks** (optional): paste YouTube links
   or video IDs. This plays on a loop whenever no table has an active
   request, instead of silence.

Both table and player links keep working even after a page reload —
pairing a table again or revisiting admin won't invalidate what's
already printed on a tablet or playing on the TV.

## What guests see

![Table page: now-playing panel, live queue with thumbnails, and this table's own request/skip state](screenshots/table.png)

Opening a paired table link shows what's currently playing, the live
queue (so a table can see how many requests are ahead of them), and a
field to paste a YouTube link or video ID — pasting one shows a live
thumbnail and the real title before you submit, so you can confirm
it's the right video. A table can have one active request at a time;
once it's played (or cancelled), they can request again. Everything
updates live via WebSocket, no refreshing needed, and refreshing
doesn't help a table cheat the one-active-request rule either way,
since that's enforced server-side, not by anything the browser
remembers.

![Player page: current video playing on the left, the "Up next" sidebar on the right](screenshots/player.png)

A request interrupts the background playlist immediately (within a
few seconds) rather than waiting for the current background track to
finish — and if the background track gets interrupted mid-play, it
picks back up where it left off instead of restarting from zero.

## Correcting an accidental play

A queued request that hasn't started playing yet can always be
cancelled for free, no questions asked. Once it starts playing, the
table's page offers "Skip this song" instead, for the case where the
wrong video started and the table wants it stopped immediately rather
than waiting it out:

- Skipping within the first 15 seconds of playback isn't billed. This
  covers the common accident: the wrong link got queued, it started
  playing, and the table wants a do-over before they've actually heard
  anything.
- Skipping after that still counts as a billable play, since the table
  got to actually hear the song.

Either way, the venue's player switches to the next item immediately;
the skipped video never plays out to the end.

<details>
<summary><strong>Real-world network setups</strong> (multiple devices, hotspots, client isolation)</summary>

"The server" above just means whichever single device runs `npm start`.
Everything else is a fixed shape: N table tablets + 1 player device + 1
admin device (which can double as any of the others), all joined to the
same network as the server. Some real combinations:

- **Testing on one device.** Run the server on a laptop and open
  `/admin/...`, `/t/...`, and `/player/...` in separate browser tabs on
  that same laptop. Nothing about the software cares that they're the
  same machine, it's just the fastest way to try it out.
- **Real deployment, laptop as host.** A laptop runs the server and
  stays on all night; each table's tablet has its browser pointed
  permanently at its own `/t/:token` URL; a separate device (could be
  the same laptop, or another one plugged into the venue's speakers)
  stays open on `/player/:token`.
- **Phone acting as the hotspot AND the server.** If your phone can both
  create a WiFi hotspot and run this project (e.g. via Termux or
  similar), it's both roles at once: tablets and the player device
  join the phone's hotspot and use whatever LAN address it reports on
  startup.
- **Phone acting as ONLY the hotspot.** Some setups instead have the
  phone just providing the WiFi, while a laptop that also joined that
  same hotspot runs `npm start`. Tablets and the player device still
  join the phone's hotspot, but the address they connect to is the
  laptop's IP on that hotspot, not the phone's.
- **The player device can be anything on the network.** `/player/:token`
  is just a URL, it doesn't have to run on the same device as the
  server. Point whatever is actually wired or Bluetooth-connected to the
  venue's speakers (a TV, a mini PC, another tablet) at that URL.

**One real failure mode worth knowing about:** some routers and phone
hotspots enable "client isolation" (sometimes called "AP isolation" or
"guest network" mode) by default, which lets every device reach the
internet but blocks them from reaching each other. If tablets can join
the network but can't load the admin/table/player URLs, this is almost
always why. Look for that setting and turn it off.

</details>

## Development

```
npm test
```

Runs the whole suite with Node's built-in test runner. Some tests make
real network calls (to YouTube's oEmbed endpoint), so it needs internet
access and takes a few seconds — that's expected, not a hang.

## Known limitations (honest, not hidden)

- **No typed song search.** Finding a song means pasting its YouTube link
  or video ID, not typing a title and picking from search results. Real
  search needs the YouTube Data API, which requires a Google Cloud
  credential this project doesn't have and can't provision. A venue
  operator with their own API key could wire this in as a future
  enhancement. (Once a link is pasted, though, the real video title and
  a thumbnail preview are fetched automatically via YouTube's official,
  keyless oEmbed endpoint, a different, credential-free API, so both
  guests and admin see the actual song title before it's requested,
  falling back to the pasted text only if that lookup fails.)
- **No payment processing.** Pricing and the billed-count tally in admin
  are informational only, for staff to read at checkout. This software
  has no card/payment integration and doesn't charge anyone directly.
- **Public-performance licensing is not addressed.** Playing music (from
  any source, YouTube included) in a commercial venue typically requires
  a PRO license (ASCAP/BMI-style, or a regional equivalent) independent
  of how the audio is sourced. That's a real business/legal
  responsibility for the venue to handle. This software has no way to
  resolve it and doesn't attempt to.
- **Admin routes have no login.** They're presumed to be operated by
  whoever is setting up the system, not exposed to guests. There's no
  authentication in front of `/admin/*`.
- **Not every YouTube video allows embedding.** Some videos have
  embedding disabled by their uploader. The player detects this and
  automatically moves on to the next item rather than getting stuck.
- **No floor-plan editor.** Tables are a flat list (label, kind, price),
  not a visual layout you drag around.
- **No QR codes yet.** Table and player links are short enough to type
  by hand now, but a printable QR code per table would still be faster
  for guests scanning with their own phone. Not implemented.
