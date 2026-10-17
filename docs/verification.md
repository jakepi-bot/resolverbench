# Verification

What was checked before this release, and how. "It built" is not evidence, so every claim below
is backed by a command that was actually run and an output that was actually read.

## 1. Engine correctness, locally (Linux x86_64, Node 26)

- `node --test test/` — **33 tests, 33 pass, 0 fail.** Four real defects were found by these
  tests rather than by review:
  1. `tCritical95(df)` indexed its lookup table with Welch's *fractional* degrees of freedom, so
     every confidence interval came back `null` — a number the conclusions page would have
     printed as a hole.
  2. Three concurrent queries per client overwrote the single in-flight slot, so two of every
     three samples were recorded as timeouts (60% "lost replies" against resolvers that were
     answering fine).
  3. The DoH pinned-address `lookup` callback ignored Node's `all: true` mode, which fails the
     request outright.
  4. The hijack probe used a name under `example.com`. Measured against Cloudflare, Google and
     Quad9: the reserved example zones answer **NOERROR/NODATA, not NXDOMAIN**, so the probe
     proved nothing. It now uses `<random>.com` and `<random>.invalid`, both confirmed NXDOMAIN.
- Tests that need the internet (Cloudflare, Google, Quad9 over UDP, DoT and DoH) run as part of
  the same suite; `RESOLVERBENCH_OFFLINE=1` skips them.

## 2. The engine against the real internet

- A 12-resolver run (plain, DoT and DoH): **12/12 answered, 100% reliability**, no errors.
- `scripts/check-results.js` asserts, from a results file: schema, an answered-resolver floor,
  per-metric sample counts, that every median is positive and plausible, reliability ≥ 50%, and
  that every encrypted endpoint reported a setup time *and* at least one connection. It is what
  CI runs after each headless benchmark on both platforms, so a green build cannot mean "the
  benchmark measured nothing".
- DoH connection reuse is asserted, not assumed: one connection served **33 requests** in a
  single run. If that regressed, DoH timings would silently become handshake timings.

## 3. DoH transport negotiation (after the delegated endpoint survey)

A subagent probed 70 plain-DNS addresses, 21 DoH endpoints and 23 DoT endpoints and returned
measured latencies. Two findings changed the app:

- **Quad9, Applied Privacy and CZ.NIC DoH require HTTP/2** (HTTP/1.1 → 505) and **Mullvad DoH**
  resets an HTTP/1.1 connection and wants GET. The DoH client now negotiates both, once, and
  remembers the working combination. Re-probed afterwards:

  | Endpoint | Result |
  | --- | --- |
  | `cloudflare-dns.com` | h1, 3/3, 16.7 ms median, 1 connection |
  | `dns.google` | h1, 3/3, 36.7 ms |
  | `dns.quad9.net` | **h2 (upgraded from h1 on 505)**, 3/3, 12.4 ms |
  | `doh.applied-privacy.net` | **h2 (upgraded)**, 3/3, 122.8 ms |
  | `dns.adguard-dns.com` | h1, 3/3, 61.9 ms |
  | `freedns.controld.com` | h1, 3/3, 16.2 ms |
  | `dns.mullvad.net` | h1 reset → h2 retry (see below) |

- **`dns0.eu` does not answer at all** (plain, DoT or DoH) and was removed from the catalog
  rather than shipped as three permanently-dead rows. Control D's DoT address was corrected to
  the verified `76.76.2.11`, and OpenDNS DoT plus Yandex DoT were added from the verified set.

## 4. The application itself (Electron, end to end)

Run under `xvfb` on Linux, which exercises the real main process, the real preload bridge, the
real renderer and the real engine — the same code paths as on macOS:

```
xvfb-run -a npx electron . --theme=dark --selftest-ui cloudflare,google,quad9,adguard,opendns,dnssb,cloudflare-dot,google-dot,cloudflare-doh --screenshot=/tmp/shots
```

Result: `ok: true`, 9/9 resolvers answered in 4.7 s, canvas ink went from 2,263 px (empty chart)
to 30,112 px (drawn bars), 9 table rows, 13 conclusions, **zero console errors**. The self-test
fails the build if `ok` is false, if the canvas gained no ink, if the table is empty, or if any
console error appeared.

Screenshots captured this way are the ones in the README. Their pixels were then measured
rather than eyeballed: bar lengths are proportional to the measured means (13.2 ms → 138 px at
10.47 px/ms; 49.7 ms → 520 px), bars stay out of the 200 px label gutter, and value labels are
drawn to the right of each bar.

A UI defect was found and fixed this way: the progress bar stopped at 83% after a completed run,
because the renderer re-derived the sample total from the round count (20 samples is 8+6+6, not
3×8).

## 5. What CI proves, and what it does not

`.github/workflows/build.yml` runs the unit tests, the live-network integration tests and a real
headless benchmark on Linux, then on an **Apple silicon runner**:

- regenerates and checks the icon;
- builds the arm64 app and the DMG/ZIP;
- fails unless `lipo -archs` says `arm64`, unless `codesign --verify --strict` passes, and
  unless the signature is ad-hoc;
- **runs the packaged binary headlessly** from the built bundle *and again from inside the
  mounted DMG*, validating the measurements each time;
- writes `SHA256SUMS.txt` and attaches the DMG, ZIP and checksums to the release.

**Not verified by any of this: a human opening the app on a real Mac.** No Apple hardware was
available to the machine that built this release, so the last tier — the window drawing, the
Gatekeeper right-click-to-open dance, and the DMG dragging to Applications — is the user's to
confirm. Everything up to that point is machine-checked.
