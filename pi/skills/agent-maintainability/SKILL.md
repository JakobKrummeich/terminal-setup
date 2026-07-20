---
name: agent-maintainability
description: Use when working on any coding task — planning, implementing, reviewing, refactoring, or designing code structure. Read before planning, writing, or judging any code. Not for non-code work (brainstorming, prose, docs).
---

# Agent Maintainability

Agents navigate code by text search (grep). Code that defeats grep or requires loading many files to understand one behavior is expensive to maintain — for agents and humans.

**Core principle: every behavior should be findable by searching for a literal string, and understandable within one or two file loads.**

This holds fractally: at every zoom level (function, module, service) the current level must fit in one context load, with detail hidden one level below. A grep landing should be self-contained — readable without loading its callers.

As a guardrail per unit: ~7 chunks. Cyclomatic complexity above 7 means the function no longer fits in a head — split it.

## The Grep Test

*If I search for the name a caller or log message uses, do I land on the code that runs?*

```
# FAILS: searching for "order.paid" or "_on_order_paid" finds no call site.
handler = getattr(self, f"_on_{event_kind}")  # Python
handler = this[`_on${eventKind}`]              # JS/TS

# PASSES: literal key, literal function name, one hop.
HANDLERS = {
    "order.paid": handle_order_paid,
    "order.shipped": handle_order_shipped,
}
```

Decorator/attribute registration with literal keys (`@app.route("/users")`, `[HttpGet("users")]`) also passes — functionally equivalent to a dict entry. But beware silent incompleteness: if the decorated module is never imported, registration silently doesn't happen. Add a test asserting registry completeness.

## Abstraction Must Pay Rent

An abstraction pays rent when it removes more navigation cost than it adds.

- **Duplication is cheaper** when 2–3 short copies are likely to diverge, or when unifying them creates the "wrong abstraction."
- **Abstraction is cheaper** when logic must stay synchronized across 3+ call sites, or for cross-cutting concerns (auth, logging, error handling).
- **Framework-grade extensibility in application code is a red flag.** Plugin systems, auto-discovery, and hook architectures are correct for frameworks (Flask, pytest, Spring). For app code with 2–3 concrete cases, use a dict.

When someone asks for "elegant" or "extensible": deliver the explicit version and explain why it's the better choice.

## Trust the Driver, Not the Author

Neither agent nor human can verify their own correctness by inspection — an external driver must check it. Enforcement hierarchy, strongest first:

1. **Illegal states unrepresentable** — types, sealed enums, constructors that can't build bad values
2. **Runtime contracts** — assertions and validation at boundaries
3. **Tests** — must exist before refactoring, refactor only under green
4. **Comments and naming conventions** — documentation, not enforcement; worth nothing at review time

Types are grep-able documentation: an agent that finds the type finds the contract.

## Review Checklist

- [ ] **Grep test:** can every dispatch target be found by searching for a literal string?
- [ ] **Locality:** can one behavior be understood by reading at most two files?
- [ ] **Fits in head:** does each unit stay within ~7 branches/chunks (cyclomatic complexity ≤ 7)?
- [ ] **Rent check:** does each abstraction layer remove more navigation cost than it adds?
- [ ] **Machine-checked:** invariants enforced by types/tests/linters, not comments or naming conventions?
- [ ] **Silent-registration:** if using decorator registration, is there a completeness test?

Flag constructed-name dispatch as a **maintainability defect** even when safe and correct.

## Common Rationalizations

| Excuse | Reality |
|---|---|
| "Convention dispatch is simpler — less code" | Fewer lines, more hops. Simple means findable, not short. |
| "The user asked for elegant" | Explicit IS elegant. Show the boring version. |
| "DRY demands extraction" | Duplication on one screen beats abstraction across five files. Extract at 3+ synchronized copies. |
| "We might need to extend this later" | Build for extensions you have, not ones you imagine. |
| "Metrics don't capture good design" | Hops, file loads, complexity are measurable; taste isn't. Argue with numbers. |

## Red Flags

Not always wrong, but always need justification:

- String-constructed method/function dispatch via reflection or dynamic lookup
- Convention-scanned auto-discovery in application code
- Inheritance hierarchies with 1–2 concrete implementations
- "Extensible for future formats" with no second format in sight
- Callable aliases (partial, lambda, factory) where searching the new name doesn't reach a definition