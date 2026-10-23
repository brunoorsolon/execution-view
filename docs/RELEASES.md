# Release publication

Release publication turns Forge Desk from a planning-only dashboard into the single writer that pushes one approved annotated tag and creates one stable Gitea release. It is **opt-in**: a planning-only deployment keeps the behavior and image of earlier versions and needs no volume, release credentials or login.

This page is the operator guide: image capabilities, volume and secrets, forge permissions, one-writer behavior, recovery, backup and the legacy cutover. The configuration keys are in [CONFIGURATION.md](CONFIGURATION.md#releases); the engine's invariants are in [RELEASE_RECOVERY.md](RELEASE_RECOVERY.md).

Contents:

- [Image and runtime](#image-and-runtime)
- [Host setup](#host-setup)
- [Credentials and forge permissions](#credentials-and-forge-permissions)
- [SSH host trust](#ssh-host-trust)
- [One writer per state directory](#one-writer-per-state-directory)
- [Shutdown, restart and recovery](#shutdown-restart-and-recovery)
- [Backup and restore](#backup-and-restore)
- [Upgrading, state schema and rollback](#upgrading-state-schema-and-rollback)
- [Legacy cutover from the terminal publisher](#legacy-cutover-from-the-terminal-publisher)
- [Differences from the terminal publisher](#differences-from-the-terminal-publisher)
- [Unsupported versions and residual risk](#unsupported-versions-and-residual-risk)
- [Attribution](#attribution)

## Image and runtime

The published image is the same image for planning and release publication, built as a multi-stage `node:22-alpine` image. Its final stage runs as the non-root user `node` (uid/gid 1000) and contains:

- `git`, the real executable, used to fetch the verified candidate into a private bare cache under the state directory;
- OpenSSH `ssh`, used for the approved tag push over the configured `ssh://` origin (`ssh-keygen` ships in the same package and is available to inspect the mounted key);
- `flock` from util-linux, which backs the OS-level exclusive owner lock on the state directory (`owner.lock` and, while work runs, `work.lock`).

Those tools are proven in the final image by `scripts/smoke-test.sh`, which runs them as the runtime user, then starts two planning-only containers (demo config and env-only, neither with a volume) and a release-enabled container with a private state volume and read-only secret files. CI runs that script. The smoke test does not contact a forge; live publication evidence is separate (see [Unsupported versions and residual risk](#unsupported-versions-and-residual-risk)).

`/healthz` remains process liveness. Repository release readiness is reported separately at `GET /api/releases/repositories` with a sanitized `capability: available|blocked` and a stable blocker code, so a forge outage or a wrong credential blocks publication for that repository without pretending the process is dead.

## Host setup

Release state must live on a private local volume. The pattern below is implemented by [`docker-compose.release.yml`](../docker-compose.release.yml); adapt paths and image tags if you deploy another way.

1. Create a directory on a local filesystem (ext4, xfs, btrfs, zfs, f2fs, tmpfs or overlayfs are accepted; NFS, CIFS/SMB, Ceph, 9p and FUSE/virtiofs are refused) and give it to the image's runtime user:

   ```sh
   install -d -m 0700 -o 1000 -g 1000 release-state
   ```

   A named Docker volume mounted at `/var/lib/forge-desk` works too: the image pre-creates that directory owned by `node` with mode `0700`, and Docker copies that ownership into the new volume. A bind mount must be prepared with the command above; Forge Desk never changes mounted permissions.

2. Put `config.yaml` next to the compose file with a `releases:` block and `releases.stateDir: /var/lib/forge-desk` ([example](CONFIGURATION.md#releases)). It is mounted read-only.

3. Create the four mounted paths and keep them read-only in the container:

   ```text
   config.yaml                                  -> /app/config.yaml:ro
   secrets/release-api-token                    -> /run/secrets/forge_desk_release_token:ro
   secrets/release-ssh-key                      -> /run/secrets/forge_desk_release_key:ro
   secrets/known_hosts                          -> /run/secrets/forge_desk_known_hosts:ro
   ```

   The release token file must be readable by the runtime user and should be mode `0600`. The SSH private key must be mode `0600` and owned by uid 1000, and `known_hosts` must be mode `0600` or `0644` and not group- or world-writable. Startup refuses a private key, `known_hosts` or state-directory violation with a diagnostic naming the path, and never rewrites mounted permissions.

4. Start with the login enabled. Releases require `server.basicAuth` (or `EV_BASIC_AUTH`); the browser approval and the CLI both authenticate as that one operator identity.

   ```sh
   # EV_IMAGE must name a Forge Desk image release that ships the release runtime; the Compose
   # file refuses to start without it (or replace `image:` with `build: .` in the file).
   printf 'EV_IMAGE=ghcr.io/brunoorsolon/execution-view:%s\n' '<release>' >> .env
   docker compose -f docker-compose.release.yml run --rm execution-view check
   docker compose -f docker-compose.release.yml up -d
   ```

Never mount the operator's home directory, a desktop checkout, an SSH agent socket (`SSH_AUTH_SOCK`) or the Docker socket. The container needs none of them: the candidate is fetched into its own cache, the key and known-hosts file are explicit read-only mounts, and a second writer is refused by the state-directory lock rather than by bypassing it.

## Credentials and forge permissions

The initial publication target is **Gitea 1.26.1**. Use two separate credentials:

- **Planning token** (read-only, `read:issue` and `read:repository`): the normal source token used by the views, mounted as an environment variable.
- **Release account**: a dedicated account (or a dedicated token of an account) with write access to every release-enabled repository. The release API token needs `read:user` (verify the authenticated account), `read:repository` (read the repository, tags, releases and Actions runs) and `write:repository` (create the release). Do not reuse the planning token, and startup refuses it if it equals one.

The account must be able to:

- read the repository, its tags, releases, branches and Actions runs;
- push the approved tag over SSH. Use a deploy key with write access, or an account SSH key placed on an account that is a collaborator with **Write** permission; an organisation team with **Write** on the repository is equivalent. Read-only access fails the tag push and therefore publication.
- read the designated Actions workflow run. Gitea must have Actions enabled for the repository and the configured workflow must exist on the default branch.

Set `releases.repositories[].expectedApiUser` to the login of the release account. Startup and every job verify the authenticated API user against it, so a token for another account blocks instead of silently adopting it. The recommended grants are **Code: Read**, **Actions: Read** and **Releases: Read and Write** for the API account, plus a **write-capable deploy key** on that repository for the tag push; the API account itself needs no code write. Planning never needs write. Gitea 1.26.1 expresses the account's units as a custom organisation team with `repo.code` read, `repo.actions` read, `repo.releases` write and `repo.issues`, `repo.pulls`, `repo.wiki` and `repo.projects` none, or as the equivalent per-repository grant where your Gitea version offers one.

Verified on Gitea 1.26.1 with exactly that team, a write deploy key and a `read:user,read:repository,write:repository` token: the SSH tag push and the API release create both succeed, Actions runs stay readable, the contents API refuses a code write (`403`) and a second release for the same tag is rejected (`409`). The repository units are not a complete API ceiling: with `repo.issues: none`, an issue create still answered `201` when the token itself carried `write:issue`. Keep the API token at those three scopes rather than relying on the units alone.

The token is never logged, written to state or included in a receipt. Forge errors are redacted and the release client refuses to send it to any origin other than the configured `baseUrl`.

## SSH host trust

The tag push trusts exactly one SSH host key. Pin it; do not disable host-key checking.

1. Obtain Gitea's SSH host public key from a trusted channel (the server administrator, or the instance's data directory, for example `/data/ssh/ssh_host_ed25519_key.pub` inside the Gitea container). Compare its fingerprint out of band with the server's own records.
2. Write a `known_hosts` line for the origin host and the port used by the `ssh://` origin, for example with `[gitea.example.com]:2222 ssh-ed25519 AAAA...`.
3. Mount that file read-only at `releases.repositories[].ssh.knownHostsFile`. Do not mount `~/.ssh/known_hosts` or an agent.
4. Keep the dedicated private key out of the image and the repository. The configured `origin` must be `ssh://user@host[:port]/owner/repo[.git]` and its path must match `repo`; Forge Desk verifies the SSH origin against the authenticated repository identity before pushing.

A host-key mismatch, a wrong key, a read-only deploy key or an origin on another host blocks publication with a stable blocker. It never falls back to another host or an unverified key.

## One writer per state directory

Exactly one running process owns a release state directory at a time. Startup takes `LOCK_EX` on `owner.lock`; a second process pointed at the same directory exits with a diagnostic naming the directory and never starts release work. While release work runs, the owner also holds `work.lock`, so a replacement owner is refused until that work ends even if the ownership helper itself died. The image runs one container per state directory; do not scale replicas, share a volume between hosts, or point two containers at the same bind mount.

Planning-only containers take no lock and can run as many replicas as you like as long as they do not share a release state directory.

## Shutdown, restart and recovery

`SIGTERM` (a normal `docker compose stop` or `docker stop`) stops admitting release work, waits up to five seconds for accepted work, then releases the locks. Work that outlives that bound keeps both locks until it ends; the container's stop grace period must outlast that drain (the default 10 s does; a shorter `stop_grace_period` may force termination). A forced termination leaves the durable intent as the record the next start reconciles, and the logs report the work that was still running.

On restart:

1. Startup validates the state directory and credentials, claims the owner lock and queues read-only reconciliation of interrupted jobs. It never replays a tag or release write automatically.
2. `GET /api/releases/repositories` reports readiness; an interrupted job shows its blocker and the receipt/inspection state in the job detail.
3. Open the interrupted job in the browser or run `releases status <jobId>`. An exact tag and release reconcile to complete with a new immutable receipt; a missing effect needs a newly reviewed original-version recovery plan, not a retry; conflict or unknown state needs human inspection.

A restart during or after publication must not bump the version. The original candidate, version, notes, approval intent and remote observations are durable, so reconciliation either proves completion or blocks for a recovery plan. There is no unqualified "publish again" surface.

Cached checkouts under `<stateDir>/checkout/` are rebuildable and are not publication evidence. If they are lost, the next preparation fetches them again.

## Backup and restore

Back up the durable evidence, not the whole working directory blindly:

1. Stop the owner so nothing mutates during the copy: `docker compose -f docker-compose.release.yml stop`.
2. Copy the state directory with ownership and mode preserved. The record directories `plans/`, `jobs/`, `intents/`, `observations/` and `receipts/` are durable evidence; `checkout/` is rebuildable cache and may be excluded to save space. Include the lock files only if you copy everything; they are recreated on start.
3. Restore into a directory that is a real local directory (not a symlink), owned by uid/gid 1000 and mode `0700`, with the same numeric ownership as the backup. Do not restore into a running owner and do not merge two backups.
4. Start the owner and reconcile interrupted jobs before preparing or publishing anything new. A restored interrupted job is inspected read-only first; a completed exact job stays complete without a version bump.

```sh
# backup (with the container stopped); umask 077 keeps the archive private
( umask 077 && tar --numeric-owner -C release-state --exclude=./checkout -czf "forge-desk-state-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" . )
# restore
install -d -m 0700 -o 1000 -g 1000 release-state
tar --numeric-owner -xzf forge-desk-state-<stamp>.tar.gz -C release-state
```

The archive holds the private plans, approval identity, notes and receipts: it must stay private. Create it under `umask 077` as above (or `chmod 600` it afterwards) and keep it private in transit and at rest; a world-readable archive exposes release records to every local user.

Cached checkouts alone are not a backup of publication evidence, and a record directory copied while the owner was writing is not a trusted backup.

## Upgrading, state schema and rollback

The release state has an explicit state-schema version (currently 1) and a shared record contract version (currently 1). Unknown or newer schema versions fail closed without modifying records; there are no implicit migrations. Within the initial milestone, a schema change must ship with a documented, tested compatibility or migration/rollback path. The additive fields of schema 1 and their compatibility rules are in [RELEASE_RECOVERY.md](RELEASE_RECOVERY.md#state-compatibility-and-rollback).

Upgrading is replacing the image and restarting, as in [DEPLOYMENT.md](DEPLOYMENT.md#upgrading), but with the state volume kept. Stop the owner first; the replacement claims the same volume and reconciles.

There is **no destructive remote rollback**: Forge Desk never force-pushes, deletes a tag or deletes a release. A bad publication is corrected by a human decision on the forge and a new release, not by an automatic undo. Rolling back the application to older software is not supported once newer records exist: older code cannot continue the recovery chain and fails closed. Stop the newer owner, preserve the full state and return to a recovery-aware version rather than deleting records.

## Legacy cutover from the terminal publisher

The supplied terminal Release Publisher (0.3.0) used Tea bindings, a local committed checkout and its own private receipts. Its state and configuration are **not** imported. Cut over one repository at a time:

1. Finish or reconcile every old publisher attempt for that repository. Do not leave an uncertain tag or release attempt running or unexamined.
2. Confirm the remote state you intend Forge Desk to see: the current default-branch head, tags and releases. Forge Desk treats the remote as authoritative and will block on conflict or unknown state.
3. Configure the dedicated release token, SSH key and known-hosts file described above, and add the repository to `releases.repositories`.
4. Use `releases prepare <repositoryId>` to produce a plan, review it, then approve. If an old attempt is still uncertain, reconcile or finish it first; do not delete or copy old receipts to hide it.
5. Keep the old standalone publisher usable during development, but stop using it for the repository once Forge Desk publishes. Run only one publisher per repository: the one-writer rule protects Forge Desk's own volume, not a second tool.

The first Forge Desk plan may therefore start from a tag/release that the old tool created. That is expected: Forge Desk reconciles the exact remote state instead of importing old receipts, and may report an already-exact tag or release as a no-op.

## Differences from the terminal publisher

These are intentional, not parity gaps:

- Forge Desk publishes the **remote default-branch head**, never the local working-tree HEAD; the candidate is fetched into a container-owned cache.
- A **designated successful Gitea Actions push run** for the exact commit, branch, repository and configured workflow path is mandatory. There is no "any successful workflow" or manual-attestation fallback.
- Approval requires the **application login** and an explicit plan digest; the browser and CLI deliver the same reviewed plan to the same engine.
- Jobs are **durable server records**, not a terminal process, so reloading or closing the browser does not duplicate a job and a restart reconciles instead of replaying.
- The configured repository allowlist is the only input; browsers and the CLI cannot supply arbitrary URLs, paths or commits.
- Tag creation is one explicit non-force push of the prepared annotated object; release creation is one stable, asset-free request; neither is retried blindly.

## Unsupported versions and residual risk

- Only **Gitea 1.26.1** is a verified publication target. Gitea 1.25 and Forgejo 11 are exercised for planning only; other versions and Forgejo are unsupported for publication until their tag/release behavior is verified.
- GitHub release publication, release assets, drafts/prereleases, major/minor bumps, editable notes and multi-user attribution are out of scope.
- Shared/network filesystems and multiple writers are unsupported and refused.
- Publication, restart-during-publication, restart-after-publication and backup/restore were verified against a disposable Gitea 1.26.1 instance at the commit named in the pull request that introduced this page; repeating that evidence needs a host with Docker or an equivalent disposable runner. Offline tests do not prove account permissions.
- Remote state can change between Forge Desk's read and write. The engine detects divergence and fails closed, but it cannot promise permanent immutability or an automatic rollback.

## Attribution

The release engine is a behavioral port of the supplied **Release Publisher 0.3.0** snapshot (commit `bd134565629a1771d2111a3a06ec47c9643d2c1d`), which is MIT-licensed. Forge Desk keeps the MIT license; the attribution and the applicable MIT notice are in [NOTICE](../NOTICE) and [LICENSE](../LICENSE). No Tea bindings, publisher state or publisher receipts are imported.
