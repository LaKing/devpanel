# Operator alerts

devpanel can alert an operator's phone or desktop browser when work starts waiting on a person, with the
dashboard closed. It alerts on two things only:

- **a new owner question**: a run paused on a question for a person, a triage's questions to the owner before
  work starts, or a question from the top-level supervisor;
- **a run that newly needs recovery**.

Completion alerts, routine progress and native apps are not part of this. Manual pauses and full-verification
pauses are not questions and do not alert.

The delivery mechanism is standard **Web Push**: the browser's own push service (Google's FCM for Chrome and
Android, Mozilla's for Firefox, Apple's for Safari and iOS, Microsoft's for Edge on Windows). devpanel encrypts every
alert for the device (RFC 8291) and signs its requests with its own key (VAPID, RFC 8292). It needs no account
and installs nothing.

## Setting it up

There is nothing to install. These three things must hold on the installation:

1. **A trusted certificate.** Browsers allow push and service workers only on a secure origin they trust.
   The panel's own certificate is self-signed (gui/README.md "HTTPS"), and a browser that only accepted a warning
   for it will not register the service worker. Use one of these:
   - serve the panel behind a reverse proxy that has a publicly trusted certificate;
   - start the panel with a trusted certificate: `DEVPANEL_TLS_CERT` / `DEVPANEL_TLS_KEY`;
   - install the panel's certificate as trusted on each device that should receive alerts.
2. **Outbound HTTPS** from the panel's host to the push services: `fcm.googleapis.com`,
   `*.push.services.mozilla.com`, `web.push.apple.com` and `*.notify.windows.com`. A device on another push service
   is refused unless its host is listed in `DEVPANEL_PUSH_HOSTS` (comma-separated).
3. **iOS and iPadOS**: Safari delivers push only to a site added to the Home Screen. Open the panel, choose
   *Share → Add to Home Screen*, and open it from there to opt in.

Optional: `DEVPANEL_PUSH_SUBJECT` is the contact sent to push services in the VAPID claim (`mailto:…` or an
`https://` URL). It defaults to `mailto:devpanel@localhost`. Some services expect a real contact.

The panel creates its VAPID key pair on first start, in `issues/.notifications/vapid.json` (mode 0600). Deleting it
makes a new key, and every device must then opt in again. The Alerts line on such a device says *"The panel's
push key changed, so alerts no longer reach this device"* and offers **Turn on for this device**, which drops the
browser's subscription for the old key and subscribes again for the new one.

## Opting in

On the dashboard, the Needs attention card starts with **Alerts on this device**. Choose **Turn on for this
device**, and allow notifications when the browser asks. A device is registered to the person signed in (the proxy
login), or on a shared-token install to the name typed in the panel. A browser with neither is registered on its
own, never in a registry shared with other browsers. Each device has its own entry, so you can opt in on a phone
and a laptop.

The card finds *this* device by its own push subscription, whatever name it was registered under, so **Turn off
for this device** always reaches it, even after the name typed in the panel changes. Your other devices are listed
by name with their own **Turn off** buttons, and **Turn off all of mine** turns off every device registered to
your name or login. It is shown whenever you have at least one device turned on, a single one included.

Only this explicit step opts a device in. Opening the panel never re-subscribes a device that was turned off.

## Opting out, and what can still arrive

**Turn off ‹device›** stops alerts to that device; **Turn off all** stops them to all of your devices. The panel
stops alerts the moment you opt out:

- **Nothing new is sent after an opt-out.** The device is marked off before anything else happens. A send either
  started before that, or it never starts.
- **A message already handed to the push service before the opt-out may still appear within its TTL of 1 hour.**
  Every alert is sent with `TTL: 3600`. The push service holds it for up to an hour after it received it, and
  the panel cannot recall it.

The confirmation tells you what may still appear:

- *"N alert(s) were accepted by the push service and may still appear until HH:MM."* The push service confirmed
  these (HTTP 201/202). The time is when its answer arrived plus one hour, so it can only be later than the real
  end of the TTL.
- *"M send(s) got no answer, so it is uncertain whether the push service received them. If it did, each may appear
  up to one hour after the service received it, a time the panel cannot see."* A send that timed out, was still
  in flight when you opted out, or was cut off by a restart. The push service may have received it, even after
  the panel stopped waiting, so the panel gives no time for it.
- *"K older send(s), the oldest from …, also got no answer; the panel cannot rule out that they may still appear."*
  Unanswered sends from the last 2 hours are listed one by one; older ones are always counted, never left out.
  The 2-hour limit only keeps the list short; it is not a delivery guarantee.

Sends the push service refused (gone, or any other HTTP status), and sends that never connected, are not
mentioned: they cannot arrive.

What the reply covers depends on what was turned off:

- **Turn off for this device** covers the subscriptions this device's current endpoint has had, including one
  turned off earlier and turned on again with the same endpoint, so a repeated opt-out answers in full. A browser
  that subscribed again under a new endpoint (after the panel's push key changed, or after the browser dropped
  its subscription) is a different endpoint: sends to its earlier endpoint are not in this reply.
- **Turn off all of mine** covers every endpoint registered to your name, earlier ones included. Use it when you
  want the full account of what may still arrive on any of your devices.

When the
panel cannot read its whole record of earlier sends (the delivery log is unreadable or damaged, or went missing
after sends were recorded in it), the confirmation says so. A lost log stays lost: `state.json` keeps when it was
noticed (`historyLostAt`), and a log recreated since by later sends or by the start's repair does not hold the
lines that went with it, so every later opt-out says so too: *"The panel could not read its whole record of earlier sends (…), so it cannot say which sends from
before this may still appear within their hour."*

## What an alert holds, and where it opens

An alert carries only counts ("2 questions, 1 run to recover"), an id and the link `/alerts/<id>`. It carries
no issue name, question text, project, run detail or credential. The push service sees only ciphertext.

Simultaneous items, those that start waiting within about 10 seconds of each other, are grouped into one alert. A
group waits for a complete reading that began once its window had closed: every project listed, every issue's
newer run records read (an issue's runs directory that cannot be listed counts as unread), the supervisor answered. An item that started waiting inside the window is then in it.
That wait is bounded: 60 seconds after the window closes, the group is sent with the items read so far, so one
unreadable project or run record never holds back alerts for the rest. An item found only after that goes in an
alert of its own. That split is part of the at-least-once residual risk below. A reading that is not complete is
also never taken as proof that a resent alert's items were handled.
The alert page lists every item it grouped, each with a link to its exact action:

- a run's question: the issue page at that run and pause (`?run=…&pause=…`);
- a triage's question: `?run=…&wait=owner-input`;
- a recovery: `?run=…&recovery=<when it began>`;
- a supervisor question: the supervisor page (`?question=…`).

Each page is behind the panel's sign-in like any other. When the item still waits, the page says so, scrolls to
that action and marks it: the answer form, the triage's questions, or for a recovery the action the panel offers
for it (*Recover run* after a lost owner, *Inspect changes* for an integrity quarantine, *Abandon run* for a run
that stopped, *Stop run* for one still active whose journal needs recovery), or on the supervisor page the named
question, listed first. A section this browser has hidden on the issue page (Status, or the run picker bar) is shown
for that visit when it holds the action; the remembered choice is not changed. When someone already handled it, the
page shows the run card and its Status the same way, even if this browser hid them, so the note and the run's current
state are visible. It says that, and by whom where it
is recorded, and shows the run or question as it is now. A question on a run that has since needed recovery is
shown as needing recovery, without an answer form the panel would refuse. A single item that still waits opens its
action directly.

The alert page reads each item from its own record when the inbox no longer lists it: the exact run, or the
supervisor's question. It is *handled* only when that record says so, *still waiting* when the record still holds
it open, and *not known right now* when its record could not be read. An item of an issue archived since is read
from the archive and shown with its run and how that run ended; the link opens the archived issue's page with that
run's entry opened and marked. A journal recovery that was abandoned shows as handled.

Operators are told apart by name only. A name such as `constructor` or `__proto__` is an operator like any other,
never mistaken for an opt-out.

## Delivery is at least once

The panel never repeats an alert because of a poll, a reconnect, a retry or a restart. Each waiting event has
a key: the pause id, the run, the recovery's first detection, or the supervisor question's id. The key is
remembered permanently once seen. Waits that began before alerts were installed, and waits whose start no record
holds, are the baseline and never alert.

A send is retried only when no connection to the push service was made (refused, DNS, unreachable): up to three
times, with a growing wait. Every HTTP status is final: a 429 or a 5xx is recorded, not resent. A redirect is
never followed. A timeout is final too.

When the service stops or crashes while a send is under way, the next start sends it again, however many times
that happens. It stops resending only if the device opted out or every item of the alert is no longer waiting.
That can deliver one alert twice. The owner accepted this: alerts are **at least once**, and a duplicate after a
restart, a concurrent first read or an engine reload is a known residual risk.

Other known residual risks:

- A delivery log **emptied in place** (truncated to nothing, rather than removed) after sends were recorded is not
  detected. The panel reads it as an empty history, so an opt-out made after that names no uncertain earlier sends
  and gives no warning. A removed log, or one removed and then recreated, is detected and named (see above).
- Turning off one device by its endpoint does not account for sends to that browser's earlier endpoints; turning
  off all of your devices does.

## Files and growth

Everything is under `issues/.notifications/` (git-ignored host data, like the rest of `issues/`):

| File | Holds | Grows |
|---|---|---|
| `subscriptions.json` | devices, who they belong to, opt-outs | per device |
| `state.json` | when alerts were installed, every key seen, the open group, sends not yet finished | one key per waiting event |
| `alerts.jsonl` | every alert and its items, so a link keeps working | one line per alert |
| `deliveries.jsonl` | one line per send attempt and its outcome | one line per attempt |
| `vapid.json` | the panel's push key pair (0600) | fixed |

At every start the panel reconciles these files:

- A send attempt that finished but whose `deliveries.jsonl` line is missing gets its line, at most once.
- A last line left half-written is dropped and rewritten from `state.json`. Unlike the spending ledger, this
  happens even when that last line would parse: every such line can be rebuilt from state.
- A line that does not parse anywhere before the last is reported. It is never cut away, and sends stop until a
  person repairs the file.
- A file that exists but cannot be read stops the notifier at start, with a line in the log, before anything is
  written: a read error never replaces the devices, the seen keys or the pending sends. The panel runs on without
  alerts until the file is readable again.

## Time to response

For each item, devpanel records when it started waiting and when it was handled, reusing the timestamps runs
already keep:

- **Questions**: the pause's `at` and the answer's decision step (who and when). A question nobody answered ends
  when the run was abandoned (`abandonment.at`, by whom) or when the run ended (`endedAt`).
- **Triage questions**: `ownerInput.at` and the answer.
- **Supervisor questions**: the question's `at` and its answer, from the supervisor's state and every archived
  session (`issues/.supervisor/state.*.json`); one left unanswered when its session was archived is handled at that
  archive's time.
- **Recoveries**: a journal-only recovery an operator retired ends at the retirement. Archiving keeps the journal
  finding and its retirement on the packed run record (`journalTiming`), so the interval is still measured after an
  issue is packed. For issues packed before this was added, the two journal files are read from the bundle
  itself (only those files, or a retired run's small directory, are extracted; cached per bundle). `run.recoveries[]`, with one entry per recovery, its first detection, its end, how and by whom.
  Older runs are read from `ownerRecoveries`, older integrity dispositions (entered when their excused wait began,
  or for an operator amendment when its quarantine was recorded, `integrity.latest.at`) and abandonments. Runs are
  read with their journal finding overlaid, as the inbox reads them, so a journal-only recovery is measured too.

A wait still open counts as pending. A time that no record holds counts as `notRecorded` and is never guessed.
Older integrity dispositions that recorded no excused interval read as not recorded: their journals and packed
bundles are not searched. A run record that exists but cannot be read or parsed is listed once in the report's
`unreadableRuns` (project, issue, run, reason); the issue's other runs keep their rows.

Two read-only outputs:

```sh
npm run --silent attention-times -- [--from <utc>] [--to <utc>] [--project <id>]
```

- `GET /api/notifications/events?from=&to=` returns the same report, plus the current supervisor session's
  questions.

Both give every row, medians before and after alerts were installed, and medians for alerted against not-alerted
waits. A wait counts as alerted when the push service accepted an alert naming it. Pending and `notRecorded`
counts are reported apart.

## API

All routes are behind the panel's token or proxy login.

- `GET /api/notifications?endpoint=`: the panel's public key, your devices, whether you opted out, and
  `thisDevice` (the subscription with that endpoint).
- `POST /api/notifications/subscriptions` with `{ subscription, label }`: opt this device in.
- `POST /api/notifications/device/off` with `{ endpoint }`: opt out this browser's own subscription, whatever name
  it was registered under.
- `DELETE /api/notifications/subscriptions/:id`: opt out one of your devices.
- `DELETE /api/notifications/subscriptions`: opt out all your devices.

  All three reply `{ completedAt, revoked, accepted, uncertain, uncertainOlder, historyUnavailable }`. Repeating
  one answers again in full.
- `GET /api/notifications/alerts/:id`: one alert's items, each `waiting`, `handled {at, by, how}`, `retired`
  (a supervisor question its session no longer holds) or `unknown`, with `current` (the run's status, whether it
  needs recovery, whether its issue is archived).
- `GET /api/notifications/events`: the time-to-response report.

## Checking it end to end

Fake-delivery tests (`node test/run.mjs notifications`, `webpush`, `waits`, `attention`) cover:

- opting in and out;
- both transitions;
- grouping;
- retries;
- restarts and crash repair;
- the confirmation's wording;
- links to handled items.

What only a real device proves: a real push delivered with the dashboard closed, opening the right page at
phone width. Check it once after setup: opt in on a phone, close the panel, cause a question (pause a run on a
policy question or ask one through the supervisor), and follow the notification.
