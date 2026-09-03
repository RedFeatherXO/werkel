# Fleet dashboard

Every OpenCode worker as a card, on a machine that is always on — while the jobs
themselves keep running wherever your repositories are.

```
   your PC (jobs run here)                    mini server (this dashboard)
   ───────────────────────                    ────────────────────────────
   ocfleet report --to …   ──push snapshots──▶  cards, live via SSE
                           ──push the ledger─▶  which models are worth the money
                           ◀──queued commands─  cancel / clean up from the browser
```

The machine running the jobs **opens no port**. It pushes, and any command you
click in the browser rides back in the response to that push.

## Two tabs

**Jobs** is the card grid, grouped by day. **Modelle** is the ranking of every
model this fleet could route a job to — not only the ones it has used.

That distinction is the whole point. **Basis** comes from published benchmarks and
is there before a single job has run; **Erfahrung** is what this fleet has learned
and is exactly `±0.0` until the model has actually done something; **Gesamt** is
the sum, and the table is sorted by it. So the ranking is complete on the day you
open the dashboard, and a model climbs or falls the moment its first outcome is
recorded — a `+4.5` on a 77.3 model puts it above an untouched 77.8.

A `~` after the base score means no published benchmark exists for that model and
it was estimated from its name — deliberately below a measured mid-tier model, so
an unknown never outranks a proven one on a guess.

The experience column is a diverging bar around a zero line: blue to the right for
a model that earned its place, red to the left for one that has not. The number
carries its own sign, so the colour never carries the meaning alone. The note
explains it in words, which is usually the more useful half.

Several machines reporting into one dashboard are merged per model. The base score
is shared — it is the same catalogue everywhere — while experience is added up and
weighted by evidence, never averaged: a laptop with ten jobs does not get the same
say as a desktop with three hundred.

`ocfleet board` prints the same ranking in a terminal.

### One command, or two

On the machine where the jobs run, `ocfleet dashboard` is everything: it starts
the server **and** reports on this machine's jobs from inside the same process.
Do not also start `ocfleet report` against it — that command mints a private
ingest token for itself, so a second reporter gets a 401 for something it did not
need to do.

For a dashboard on a different machine, the push design is the point: that server
runs on its own and the reporters come to it. Should you ever want a standalone
`node dashboard/server.mjs` to report on its own machine as well, set
`REPORT_SELF_SEC=5`. It is off unless asked, because this server normally runs
where the jobs are not.

## Just want to look at your own machine?## Just want to look at your own machine?

No server, no token, no Docker:

```bash
ocfleet dashboard --open        # or: node bin/ocfleet.mjs dashboard --open
```

That starts the dashboard on http://127.0.0.1:7777 and feeds it from this
machine's jobs. It is the same server and the same reporter as the setup below,
both running in one process over the loopback interface — so there is no second
implementation that could drift. Ctrl+C stops it.

`--host 0.0.0.0` makes it reachable from your network (it will warn you: that
has no login), `--port` moves it, `--interval` changes the refresh rate.

Everything below is for the other case: a dashboard that stays up on a small
server while the jobs run elsewhere.

## Run it

```bash
cp .env.example .env
sed -i "s/change-me/$(openssl rand -hex 24)/" .env    # a real ingest token
docker compose up -d
```

Then on the machine where the jobs run:

```bash
FLEET_INGEST_TOKEN=<same token> \
  node bin/ocfleet.mjs report --to http://<server>:7777 --interval 5
```

Open `http://<server>:7777`. Until the first push arrives, the page tells you the
exact command to run.

To keep the reporter alive across reboots, adapt `ocfleet-report.service`
(user, paths, URL) and install it as a systemd unit.

## Configuration

| Variable | Meaning |
|---|---|
| `FLEET_INGEST_TOKEN` | Required in practice. Only pushes with this token are accepted; without it anyone on the network could inject jobs. |
| `DASHBOARD_USER` + `DASHBOARD_PASS` | Set **both** to put HTTP basic auth in front of the browser view. Leave empty for an open LAN dashboard. The ingest token is independent of this. |
| `PORT`, `HOST` | Defaults 7777 and 0.0.0.0. |
| `DATA_DIR` | Where `state.json` lives. In Docker this is the `/data` volume. |
| `RETENTION_JOBS` | How many jobs to keep, newest first (default 300). |

## What a card shows

State (colour and a pulsing dot while running), title, model, live duration,
cost, which tools the worker used, and the host it ran on. A job that survived a
provider outage shows `↻ attempt 2/3` with the model that failed.

Clicking opens the detail sheet: identifiers, previous attempts, the error, the
worker's report, the diffstat and changed files, and the original work order.
Two actions are available — **cancel** a running job and **clean up** a finished
job's worktree. Both are queued and executed by the reporter on its next cycle,
usually within seconds.

Merging is deliberately not here. What lands in your repository should go through
a review, not a button in a browser tab.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/ingest` | ingest token | the reporter pushes; the response carries queued commands |
| POST | `/api/commands/:id/result` | ingest token | the reporter acknowledges a command |
| GET | `/api/jobs`, `/api/jobs/:key` | basic auth (if set) | what the page reads |
| GET | `/api/models` | basic auth (if set) | the model ledger, merged across machines |
| POST | `/api/jobs/:key/cancel`\|`/cleanup`\|`/forget` | basic auth (if set) | queue a command |
| POST | `/api/forget` | basic auth (if set) | forget many jobs in one request |
| GET | `/api/events` | basic auth (if set) | server-sent events |
| GET | `/healthz` | none | container health check |

## Tests

```bash
node selftest.mjs        # server alone: auth, ingest, command round-trip, restart
node integration.mjs     # the real reporter against the real server
```

Both start and stop their own server and need no API key.
