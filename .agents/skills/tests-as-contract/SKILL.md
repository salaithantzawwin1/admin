---
name: tests-as-contract
description: "Use a compact behavior contract to simplify both tests and production code"
metadata:
  freebuff-builtin: "tests-as-contract"
---

Use the tests as a compact executable contract for the requested behavior. Replace repetitive or implementation-coupled coverage with the smallest clear set of behavior and boundary cases, using tables where they improve readability. Let that contract guide simplification of the production code: remove branches and machinery no remaining behavior requires. Run the focused suite and type checks, and keep both implementation and tests concise without losing meaningful coverage.