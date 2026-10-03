# Issue Management Contract

Project configuration and overrides for the `issue-management` skill. The shared
skill keeps the workflow and unchanged defaults.

## Tracker

- Provider: github

## Claim policy

- Stale claim window: 24 hours

## Managed label mappings

### Lifecycle

- Review: agent:review
- Ready: agent:ready
- Claimed: agent:claimed
- Blocked: agent:blocked

### Wayfinder

- Map: wayfinder:map
- Research: wayfinder:research
- Prototype: wayfinder:prototype
- Grilling: wayfinder:grilling
- Task: wayfinder:task

### Delivery

- Mechanical: delivery:mechanical
- Bounded: delivery:bounded
- Cross-cutting: delivery:cross-cutting
- Critical: delivery:critical
- Unclassified: delivery:unclassified

### Decomposition

- Decomposed: spec:decomposed
