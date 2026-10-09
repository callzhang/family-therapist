# Protocol module boundary

The history module defines cursor behavior for an already authorized, ordered scope.
It does not authenticate requests or validate UUID syntax. Production adapters validate
UUIDs using the selected schema library, filter by membership and scope before cursor
resolution, and query durable storage with a server sequence and fixed snapshot bound.
Space and thread cursors are independent. No production endpoint should load all history
into memory to invoke the array reference implementation.

The discussion module is a deterministic contract for two authenticated members.
Proposal text and action are immutable under a proposal id. A new text version has a new
proposal id and no inherited approvals. Proposing is not approving. Consensus is not
thread closure. Reopening returns a settled thread to pending and retains its history.

Production transactions must enforce a unique message UUID, immutable payload receipt,
single active thread, version-checked approvals, and atomic append of events and jobs.
The pure model revision must be mapped to relevant discussion resources; unrelated
skill-release messages do not invalidate a proposal. Actor identity comes from verified
credentials, never a client body field. Model output cannot invoke approval as a member.

The tests do not prove durable recovery, identity security, task execution, consultation
quality, deployment, local scheduling, or skill upgrades. Those require their own phase
acceptance evidence. Local-only synthetic fixtures are not clinical or production data.
