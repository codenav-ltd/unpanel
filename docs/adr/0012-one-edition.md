# 0012 · One edition, with every feature free

- Status: Accepted
- Date: 2026-10-15
- Related: [ADR-0001](./0001-uniform-node-abstraction.md), [ADR-0011](./0011-agpl-license.md), [CLA.md](../../CLA.md), [design/00](../design/00-overview.md) §1

## Context

- Most server panels split into a free edition and paid Pro or Enterprise editions. Multi-server management is one of the features most often kept for the paid tier: 1Panel, aaPanel and BaoTa all charge for it. (By 18 October 2026 BaoTa and aaPanel had made it free; 1Panel still sells it per node.)
- Unpanel is built around multiple nodes ([ADR-0001](./0001-uniform-node-abstraction.md)). Charging for it would charge for the core of the product.
- Users choosing a panel for many servers need to know that what they set up today will not be locked later.
- The [CLA](../../CLA.md) lets CodeNav license contributions under other terms in addition to the AGPL, so the license alone does not rule out a paid edition.

## Decision

There is one edition of Unpanel, and it is free. CodeNav will not create a Pro, Enterprise or other edition that holds back features, and will not move a feature from the free edition behind payment.

1. **Every feature ships in the public AGPL release**, including multi-server management, team mode and RBAC, alerts, certificates and updates.
2. **No limits on servers, users or history** are added to sell an upgrade.
3. **Allowed:** paid support, a hosted service, sponsorship, and a commercial license for organisations that cannot use the AGPL. None of these may contain features the public release lacks.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| One free edition (chosen) | Clear promise; matches the multi-node design; a reason to choose Unpanel over panels that charge for nodes | Income has to come from support, hosting or licensing, not features |
| Open core (free edition plus paid features) | Common way to fund a panel | Users cannot trust that a free feature stays free; splits the code base |
| Free edition with a node limit | Simple to sell | Charges for the core of the product |

## Consequences

- The promise is published on the site and in the README. Any later funding plan must fit within it.
- No licence checks or feature flags tied to payment are added to the code.
- Released versions stay under the AGPL in any case, so anyone can keep using and forking every feature they already have ([ADR-0011](./0011-agpl-license.md)).
- This decision is not revisited by superseding it: withdrawing the promise would break it. A new ADR may only widen it.
