---
status: accepted
---

# The graph is stored in SQLite, not a graph database

The data is a graph, but at the size of one family, used by one person on one machine, a graph database engine adds a server to run and nothing we need. We store generic node and edge tables in a single SQLite file, load the whole graph into memory, and do kinship and path-finding in application code.

## Considered Options

Neo4j (a server process, heavy for a personal dataset) and an embedded graph engine (smaller ecosystem, less certain future).

## Consequences

The same rows load directly into a graph database later. Revisit when several people edit at once, the graph no longer fits in memory, or ad-hoc graph queries become routine.
