# Bridge cache self-healing: what changed and why

Branch: `fix/bridge-cache-self-healing` (from `master`, v5.2.0 → v5.2.1)

## The problem

Sometimes every Hue node starts logging errors like this one, all at the same time:

```
[hue-light:IRIS Salon] The light is not yet available. Please wait until HueMagic has established a connection with the bridge or check whether the resource ID in the configuration is valid.
[hue-temperature:Parking] The sensor is not yet available. ...
```

Nothing recovers on its own. Only a Node-RED restart fixes it. In practice it happens after a **router restart**, when the bridge cannot be reached for a few minutes.

## Root cause

This message is not a connection error. It is only logged when `bridge.get()` returns `false`, and that only happens when:

- the resource is missing from the config node's cache (`scope.resources`), or
- its message class throws (for example, a device with no `light` service).

When the connection drops, the cache stays as it was. Nodes keep answering with the last known state. So the symptom means **the cache itself was emptied or damaged while the connection was working**. That is why the watchdog never noticed anything: it only checks that `GET /clip/v2/resource/bridge` answers, never what the cache contains.

The code has two ways to end up there:

**A. The cache is replaced by an empty or partial resource list, and never reloaded (main cause).**
- `scope.resources` is replaced in only two places: `start()` and `refetchResources()`. Both accepted the `GET /clip/v2/resource` result without checking it.
- `api.request` ignores the `errors` field of a `200` response, so `200 {errors:[…], data:[]}` silently emptied the cache.
- After a router restart, two full reloads start at about the same time: the event stream's `reconnect` triggers `refetchResources()`, and the watchdog's 3rd failure triggers `start()`. Whichever finishes last overwrites the cache, and a bridge that just got its network back can answer incompletely.
- After that, nothing reloads the cache again:
  - the watchdog is happy;
  - the event stream is connected;
  - events for devices the cache no longer knows are silently dropped (`if(!previousState) { continue; }`);
  - a failed `refetchResources()` was only logged, never retried.

**B. A `device` update with a `services` array breaks that device.** In the cache, `services` is a resolved map (`{type: {id: resource}}`). An event-stream update for a root resource can carry `services` as a list of `{rid, rtype}`. `merge.deep` replaces arrays wholesale, so the map became an array. After that, `services.light` was `undefined` and the node stayed "not available" until restart.

**C. Smaller event-stream client gaps.** These do not produce the "not available" error, but they can leave a dead stream:
- `end`/`error` handlers of an old request could tear down a freshly reopened stream;
- a response `close` without `end`/`error` went unnoticed;
- a `start()` that never settled would block every later start (`starting` stuck at `true`).

### Reproduction

A simulation script runs a fake HTTPS bridge that goes away for 70 s, then comes back answering an empty list, then a partial one, then the complete one.

| Moment | `master` | this branch |
|---|---|---|
| During the outage | OK | OK |
| After an empty answer | **NOT AVAILABLE** (all 3 lights) | OK (answer rejected, retried) |
| After a partial answer | **NOT AVAILABLE** | OK (missing devices kept, retry planned) |
| Bridge fully back | **NOT AVAILABLE**, for good | OK, cache complete again |

## What changed

### `huemagic/utils/api.js`
- **`request({ raw: true })`**: a new option that returns the whole CLIP v2 body (`{data, errors}`) instead of just `data`. Default behaviour is unchanged.
- **`subscribe()` hardening**:
  - every `request`/`response` handler first checks that it still belongs to the current request (`current()`);
  - `reconnect()` detaches the request *before* destroying it, so its late events are ignored;
  - a response `close` now also triggers a reconnect.
- `subscribe()` takes an optional 4th `trace` callback, used for temporary diagnostics (see below).
- **Connect timeout**: the 15 s handshake guard is now the `timeout` option of `https.request`, plus a `timeout` listener. `request.setTimeout()` only starts counting once the socket is connected, so an unreachable bridge (cable pulled, power off) used to hang for the OS connect timeout instead: 2 min 07 s, seen twice in production logs. The guard is still cleared with `request.setTimeout(0)` once the stream is up, so an idle stream is never cut (checked with a stream left silent for 20 s).

### `huemagic/utils/http.js`
- The same fix for every bridge request (watchdog, full loads, commands): `send()` passes its `timeout` as the `timeout` option of `http(s).request`. A request to an unreachable host now fails after the requested timeout. Before, `master` ignored a 1.5 s timeout and waited for the OS (5 s on Windows, ~127 s on Linux). This matters because:
  - the watchdog noticed the outage about 2 minutes late;
  - commands sent during an outage stayed stuck for 2 minutes;
  - the command queue only runs 10 commands at a time, so 10 stuck commands were enough to hold back every command behind them.

### `huemagic/hue-bridge-config.js`
- **Validated full loads**: `getAllResources()` uses `raw: true` and rejects an empty or missing `data` list. The bridge always lists at least itself, so an empty list means it is not ready yet. A `200` that carries `errors` is traced.
- **`beginLoad()` + `applyResources()`**, shared by `start()` and `refetchResources()`:
  - every full load gets a generation number, and a load that finishes after a newer one has been applied is ignored (this fixes the overlap of `start()` and `refetchResources()`);
  - a tracked root resource (`device`, `room`, `zone`, `bridge_home`, `scene`, `smart_scene`, `behavior_instance`, `rule`) missing from the new list is **kept**, together with its `_groupsOf` entries, unless the bridge sent a `delete` event for it (`deletedIds`);
  - a resource still missing after every retry is finally dropped (`missingCount`).
- **Retries**: `retryRefetch()` reloads again after 15 s / 30 s / 60 s / 60 s / 60 s, both after an incomplete load and after a failed one (which used to be logged and then forgotten). A retry never postpones a reload that is already due sooner.
- **Repair from the event stream**: `repair(key, reason)` asks for a full reload when an update cannot be placed in the cache (unknown root or owner), or when a root update announces a different set of services. To avoid a reload loop on an unusual but harmless event, it is limited to one reload per minute overall and 3 reloads per key; after that, the key is ignored.
- **`services` arrays** are removed from a root update before `merge.deep`, so the resolved map is never replaced. The rest of the update (name, product data, …) is still merged.
- **Watchdog**:
  - it asks for a full reload when the bridge answers but the cache holds no `device` (`hasDevices()`);
  - when `start()` is skipped, the watchdog keeps running instead of stopping.
- **`start()`**:
  - a 120 s guard (unref'd timer) prevents a start that never settles from blocking every later one;
  - each start has a number, so a start that was replaced is ignored when it finally settles.

### Temporary diagnostics
These are English-only `[reconnect-trace] …` log lines, deliberately without locale keys. They are meant to be removed, entirely or in part, once the router-restart case is confirmed fixed in production. They trace:
- what triggers each full load, with its number;
- what the bridge sent (counts per type), and the `errors` of a `200` response;
- devices kept or dropped;
- failed full loads and failed starts, with the actual error (the regular log only printed `[object Object]` for them);
- retries;
- watchdog failures;
- event-stream connects and reconnects;
- repair requests.

To find them: grep `reconnect-trace`, `scope.trace(` (config node) and `say(` (`api.js`).

### Tests
- New `test/resources.test.js` (9 cases), covering:
  - an empty answer is rejected;
  - a partial load keeps the missing devices;
  - a `delete` event lets a device leave the cache;
  - a device still missing after every retry is dropped;
  - an older load cannot overwrite a newer one;
  - `repair()` limits;
  - `services` arrays;
  - a failed load is retried until the bridge answers completely;
  - the watchdog reloads an empty cache.
- `test/eventstream.test.js`: one new case. After a lost stream, exactly one reconnect happens, and the old request does not tear down the new stream.
- `test/http.test.js`: one new case. A non-routable host gives up after the requested timeout, not after the OS one.
- Full suite: 99/99 passing.

### Docs
- `CHANGELOG.md`: new v5.2.1 entry, written from the user's point of view.
- `package.json`: version 5.2.1.

## Known limitations
- If the event stream dies without any TCP signal while the bridge keeps answering, this is still not detected. States freeze, but nodes stay available.
- Every full reload emits the initial states to all nodes again. That was already the case; it just happens a bit more often now because of the retries. It is only visible on nodes with "initevents" enabled.
