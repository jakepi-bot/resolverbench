# Reverse-engineering notes

How the reference tool was studied, and what came from evidence rather than memory. The
analysis used **REA** (Reverse Engineer Anything, `rea-agents@6.4.0`, MIT, via the Hermes REA
plugin) against the shipped artifact.

## The target

GRC's DNS Benchmark v1 is no longer distributed — GRC withdrew it when v2 became a paid product
("v1 is wrong. v2 is correct. So we decided to stop offering any freeware that was wrong"), and
`grc.com/dns/dns_bench.exe` now returns 404. The authentic v1 binary was recovered from the
Internet Archive:

```
web.archive.org/web/20190117150340if_/https://www.grc.com/files/dnsbench.exe
169,624 bytes
sha256 c03d23b734567a3deba88fc58cf721f5233e9c958f03268d72984a2bf9ac48a5
PE32 executable for MS Windows 4.00 (GUI), Intel i386, 3 sections
```

It is not redistributed in this repository.

## What REA established (observed)

| Operation | Result |
| --- | --- |
| `inspect-artifact` | Format `pe`, root SHA-256 as above, artifact inventory with one node, `evidence_id ev_5a55cc1f…` |
| `inspect-managed-artifact` | `machine 0x014c` (x86), `optional_header pe32`, `section_count 3`, `cli null`, `classification.status = "not-managed"` — a native binary, not a .NET assembly |
| `inspect-pe-resources` | **Refused.** `invalid_format: "PE section raw bytes overlap headers"` under its fail-closed integrity policy |
| `providers` | No native analysis engine configured (no Ghidra, Hopper or IDA) |

Two things worth recording:

1. **REA refused to read the PE resource tree**, and that refusal is itself a finding: GRC's
   hand-written assembly binary has a section layout that fails a strict header/overlap check.
   The tool's integrity policy is `fail`, so it declined rather than guessing — the correct
   behaviour, and a reminder that a rejected artifact is not the same as a broken tool.
2. **No pseudocode was produced.** Native decompilation needs Ghidra plus a JDK, REA never
   installs providers, and its own skill instructs the agent not to install them either. So
   nothing here is claimed from decompiled code. Static string extraction (performed with
   `strings`/Python, not REA) found the version resources — `"DNS Benchmark", freeware by Steve
   Gibson`, `Measure the performance of DNS resolvers.` — and a code-signing chain, consistent
   with a compressed/packed assembly-language executable.

Because the artifact could not be decompiled, the behavioural specification was taken from
**GRC's own published documentation**, fetched and read directly:

- `dns/features.htm` — the four measured parameters (cached, uncached, dotcom, reliability),
  rebinding-protection testing, optional DNSSEC verification, hierarchical sorting
  (cached → uncached → dotcom), the statistical significance claim ("95% confidence threshold"),
  CSV export and automatic logging.
- `dns/resources.htm` — the replaceable resolver list (70 public resolvers by default, up to 200
  per run) and the tested-domains list (the 2009 Alexa top 100, pruned to 50), plus the sampling
  rationale: *"fifty (50) domain lookups per resolver was found to provide the optimal mixture of
  statistical significance, results repeatability, and total benchmark running time."*
- `dns/operation.htm` — the colour language (green good; red dead/unreliable; **orange when a
  server does not return an error for a nonexistent domain**), bar-chart rescaling, the value
  inspector, "Remove dead nameservers", ordering advice, and the observation behind the whole
  cached/uncached split.

## What ResolverBench took from that, and what it changed

**Kept, because the reasoning holds and the documentation states why:**

- The cached / uncached / `.com` split, with the same colour convention (red / green / purple)
  and default sorting by cached performance, then uncached, then dotcom.
- Fifty lookups per resolver as the default plan, for the reason GRC's documentation gives.
- Reliability measured as replies not received, and a separate characterisation pass for typo
  hijacking (orange-equivalent) and DNS rebinding.
- An English "Conclusions" page instead of leaving the reader with a chart, and a
  statistically-grounded notion of "faster" (Welch's t-test here, 95% level).
- A replaceable domain corpus and importable nameserver lists — the import parser deliberately
  tolerates GRC's `dnsbench.ini` shape so an existing list can be pasted in unchanged.

**Added, because it is the point of this project:**

- **DNS-over-HTTPS (RFC 8484) and DNS-over-TLS (RFC 7858) as first-class transports**, measured
  the same way as UDP, with per-transport connection setup reported separately from in-session
  query latency, and automatic HTTP/2 negotiation for endpoints that refuse HTTP/1.1.
- A current 50-domain corpus instead of the 2009 one: benchmarking resolvers against Myspace and
  Friendster would measure a smaller and less representative slice of the Internet than the
  original did when it shipped.
- macOS-native packaging, and a headless CLI so a scheduled job can log results over time.

**Deliberately not copied:** the pure-assembly implementation, GRC's resolver list (built and
verified fresh, see `verification.md`), and any behaviour whose purpose could not be established
from documentation or the artifact. Where a metric is an approximation rather than a
reproduction — the `.com` referral leg, the rebinding probe's use of a public wildcard service —
the README says so instead of implying parity.

No GRC code is used or redistributed. ResolverBench is unaffiliated with GRC; the acknowledgement
is for methodology and for a documentation set detailed enough to reimplement from.
