# Couples are household nodes, not person-to-person edges

A couple and their children could be direct parent and spouse edges between people, or a household node (first called a union) that partners and children both attach to. We chose the household node: remarriage becomes a second household, half-siblings need no special case, a child belongs to a specific couple, and facts about the relationship have somewhere to live. It also maps directly onto GEDCOM family records.

## Consequences

Parents and siblings are derived, never stored, so every parent lookup is two hops, and a person with one known parent still needs a household.
