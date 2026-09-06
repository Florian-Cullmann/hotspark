# Deployment recovery

PostgreSQL jobs use leases and transactional claiming. Enqueueing takes a project advisory transaction lock, backed by a partial unique index permitting only one queued/running job per project. Four worker loops allow different projects to progress concurrently. The agent also takes an OS `flock` on a persistent per-project inode; process exit releases the lock, and the inode is never replaced during normal operation. This protects the Docker execution boundary across agent restarts, not merely an in-memory queue.

Before each phase, the agent persists an operation journal and a bounded release event. Agent startup restores temporary secret files from authenticated encrypted vaults, examines pending operations, reconciles the active pointer and republishes routing. An expired worker lease queries the same operation ID rather than blindly rebuilding.

- Interrupted clone/build or uncommitted candidate: classify failed, clean candidate/workspace, restore previous healthy routing and maintenance policy. Submit a new deployment to retry.
- Route file written but active pointer not committed: restore the previous release deterministically.
- Active pointer committed: verify candidate health and finalize success; otherwise restore the predecessor and mark failure.
- Migration started without completion: record uncertain migration outcome; never replay automatically.
- Server reboot: Docker restart policies and secret reconstruction restore runtime availability; the periodic reconciler updates observed state and queues safe starts according to desired state.

Cancellation is best-effort during source/build phases. It terminates the command process group and cleans candidate resources. Migration and activation are deliberately not interruptible through the cancellation endpoint. Queued jobs may be cancelled using the job endpoint. An interrupted deployment is not permanently leased: worker expiry and agent recovery classify it.

Local JSON state uses atomic replacement and survives ordinary process crashes. It is not fsync-backed transactional storage for arbitrary power-loss guarantees. PostgreSQL and filesystem state form a recoverable protocol, not one distributed transaction. Back up platform PostgreSQL, `/var/lib/hotspark/projects`, configuration and the encryption key together. Losing the key makes encrypted secrets unusable.

The engine currently targets one Docker host. Remote-agent transport, registry distribution, distributed fencing and HA control planes remain future work. Docker isolation is not a VM security boundary; do not host hostile tenants without stronger isolation.

If the agent records success but its response is lost, the worker finalizes that durable success even on its final retry attempt; it does not misclassify an already active release as failed.
