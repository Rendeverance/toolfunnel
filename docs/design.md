# Design decisions

Short notes on the decisions that shape ToolFunnel, so you can judge the reasoning without
reading the source. Each one is also documented at the place in the code where it bites.

## 1. Zero runtime dependencies

ToolFunnel sits in a privileged position: it executes tools and enforces policy. Every
transitive dependency in that position is something you have to trust or audit. So the gateway
uses Node built-ins only; "dependencies" in package.json is empty and stays empty. The one
exception is deliberate and opt-in: OAuth token validation uses jose, installed only when you
run `toolfunnel install-oauth`, version-pinned, because hand-rolled JWT crypto is how security
holes are born. Dev tooling for the test suite (jose, the MCP SDK for interop tests) never
ships.

## 2. No SDK

The gateway hand-rolls JSON-RPC over stdio and HTTP rather than building on the official MCP
SDK. Two reasons. First, the zero-dependency stance above. Second, ToolFunnel has to speak two
protocol eras at once, on both sides, which the SDK does not do; owning the wire layer is what
makes the dual-era serving and the wrap possible at all.

## 3. The gate fails closed

Every server-side execution path goes through one function, gatedRun, and that function treats
every failure as a deny: a hook that blocks, a hook engine that crashes, a malformed engine
result, all of them mean the tool does not run. Denies carry a flag distinguishing operator
policy ("your hook said no") from wiring failure ("the gate itself broke"), so a broken gate
can never be mistaken for an approving one. The invariant has its own test.

## 4. The isolation boundary

Upstream server definitions can name any executable but their path-shaped arguments must stay
inside the config home. The command is the interpreter you chose; the args are what it can
reach, so the args are what the guard checks. Wrapping suspends the guard for the wrapped
server only, because a wrap is an explicit statement that this one server is your entire
surface, and it warns you when that happens.

## 5. Two eras, served per request

The 2026-07-28 revision removes the handshake that defines the older protocol, so "which era"
is a property of each request, and that is how the gateway treats it: era detection per
request, no mode switch, no configuration. Legacy answers stay byte-identical to what a
pre-0.6.0 client saw; the gateway's own modern decoration only ever appears on modern
requests. (A wrapped modern upstream's results are relayed verbatim, whatever era the
caller speaks - stripping a server's own fields would be data loss and a wrapper tell.)

## 6. Config lives in one folder

Everything mutable (tools, upstreams, hooks, identity, logs) lives in the config home,
relocatable with `--config-dir` or `TOOLFUNNEL_HOME`, seeded once, never overwritten by
updates. One folder to back up, one folder to package, one folder to hand a colleague. The
gateway prints the resolved home at every start so there is never any doubt about where state
lives.

## 7. Single operator by design

Each ToolFunnel instance serves one operator. That is a decision, not an oversight: one
instance per user gives process isolation, crash containment, per-user wrap state, and a
security boundary you can reason about in one sentence. Multi-user deployment composes *in
front of* the gateway rather than inside it - an authenticating proxy at the OAuth boundary
(ToolFunnel is already an OAuth 2.1 resource server) routing each authenticated user to their
own instance, with the per-request `_meta` lane carrying user context through to upstreams
that want it. Nothing in the core couples the operator to a token subject, so that door stays
open without the core ever growing user-shaped complexity.

A Team edition built on this pattern - per-user identity, audit trails, quotas, per-user
policy - is on the roadmap if there is interest. If your team wants that sooner, or you need a
bespoke gateway built on ToolFunnel for your own requirements, open an issue on this
repository titled `enquiry` - tailored builds are available.
