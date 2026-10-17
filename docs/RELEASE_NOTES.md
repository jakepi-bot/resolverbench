# ResolverBench 1.0.0

The first release: a macOS (Apple silicon) DNS resolver benchmark that measures **plain DNS,
DNS-over-HTTPS and DNS-over-TLS** side by side, and tells you what the numbers mean.

## What it does

- Benchmarks any number of resolvers **in parallel and interleaved**, so no resolver gets the
  network to itself.
- Separates **cached**, **uncached** and **`.com` referral** latency — the three numbers that
  mean different things — instead of reporting one blended average.
- Treats the encrypted transports as first-class: the connection setup cost (TCP+TLS handshake
  for DoT, TCP+TLS+HTTP for DoH) is reported separately from in-session query latency, so
  "does encryption cost me latency?" has an answer instead of an opinion.
- Counts **reliability** as lost replies rather than discarding them, and characterises
  behaviour: typo hijacking / NXDOMAIN rewriting, DNS rebinding protection, and optionally
  DNSSEC validation.
- Ends on a **Conclusions** page — an ordered, plain-English report with a recommended
  resolver order, and every comparative claim backed by Welch's t-test at 95% confidence so
  differences inside the noise are called ties.
- Exports a full CSV, saves a text report, and runs headlessly from the command line for
  scheduled or unattended benchmarking.

## Notable engineering details

- **DoH negotiates HTTP/2 automatically.** Several services refuse HTTP/1.1 outright (Quad9,
  Applied Privacy and CZ.NIC answer 505 to an h1 request; Mullvad resets the connection), and
  Mullvad accepts only GET. The client detects both cases from the response, retries once,
  remembers the working combination, and reports which protocol each resolver was measured
  over. Verified against all four cases.
- Requests are strictly serialised per resolver: two questions in flight on one connection
  would each be inflated by the other's queueing delay.
- The 48-entry catalog was verified end to end before release: 70 plain-DNS addresses, 21 DoH
  endpoints and 23 DoT endpoints were probed, and only endpoints that actually answered with a
  real address were kept (`dns0.eu` was removed entirely; Control D's DoT address was
  corrected).

## Install

Download `ResolverBench-1.0.0-arm64.dmg`, open it, drag the app to Applications.

**The build is ad-hoc signed, not notarized** — there is no paid Apple Developer ID behind this
project, so macOS will block the first launch. To open it: **right-click (or Control-click) the
app → Open → Open**, once; or run
`xattr -dr com.apple.quarantine /Applications/ResolverBench.app`.

Check what you downloaded against `SHA256SUMS.txt`:

```bash
shasum -a 256 -c SHA256SUMS.txt
```

A `.zip` of the same app is attached for people who prefer it to the DMG.

## Requirements and limits

- macOS 11 or newer on **Apple silicon** (arm64 only).
- Nothing is installed, no daemon, no root, no installer.
- Latency to anycast resolvers depends on where you are, so these results — and the resolving
  behaviour they describe — are specific to the machine and network that ran them.
- The `.com` figure approximates the TLD-referral leg using fresh random `.com` labels, and the
  rebinding probe relies on a public wildcard service; both are documented in the README's
  "Honest limitations" section rather than presented as absolutes.

## Thanks

Methodology is modelled on GRC's DNS Benchmark by Steve Gibson — the cached / uncached /
`.com` split, the Conclusions page and the fifty-lookups-per-resolver sampling point all come
from its documentation. This is an independent reimplementation, unaffiliated with GRC, and it
contains no code from that program.

MIT licensed.
