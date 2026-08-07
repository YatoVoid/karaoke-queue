# Contributing

## Requirements

Node.js 22.5 or newer, it uses the built-in `node:sqlite` module.

## Running it

```bash
npm install
npm start
```

No config file, no signup, no API keys. Pick any consistent venue id string
and open `/admin/venues/<id>` on a device on the same network.

## Running the tests

```bash
npm test
```

Uses Node's built-in test runner (`node --test`).

## Before opening a PR

- The FIFO queue and anti-cheat logic are server-side on purpose, don't move
  trust decisions into the tablet or player pages.
- If you touch the admin flow, confirm a fresh venue id still works with
  zero setup, that's the entire pitch of this tool over the paid
  alternatives it's replacing.
- Keep it running off one machine with no external services. No accounts,
  no cloud database, no per-song billing hooks.

## Reporting a bug

What page you were on (guest tablet, player, or admin), what you did, what
you expected, and what happened. Node version and OS.
