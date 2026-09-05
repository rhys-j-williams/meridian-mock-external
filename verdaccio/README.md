# verdaccio (local registry)

Stand in for Artifactory `npm-virtual`. Port 4873.

- anonymous read for everything
- one publisher, `meridian-publisher`, password `CHANGEME-verdaccio-publisher` (htpasswd is SHA1, it is a mock)
- `@meridian/*` is never proxied; everything else falls through to registry.npmjs.org and is cached under `storage/`

Start it: `scripts/verdaccio-up.sh` (compose if Docker is up, otherwise `npx verdaccio@5.29.2` under Node 18).
Publish the internal packages: `scripts/publish-internal.sh`. It logs in with the publisher account,
then publishes whichever of these are present in the checkout, in this order:

| package | path | note |
| --- | --- | --- |
| @meridian/domain-fixtures | platform-services/libs/ts/domain-fixtures | everything depends on it |
| @meridian/semaphore-client | mock-external/lib/semaphore-client | offline flag evaluation, same algorithm as the mock |
| @meridian/lantern-sdk | lantern-sdk | built under Node 14, View Engine (LNTN, T39) |
| @meridian/canopy-ui 3.5.0 | canopy-ui (tag canopy-ui-3.5.0) | via canopy-ui/scripts/publish.sh if it exists |
| @meridian/canopy-ui 3.7.2 | canopy-ui (develop) | same |

Missing directories are skipped with a warning; the other sessions land them on their own branches.
Re-publishing the same version is a 409 from Verdaccio; the script treats that as "already there".

If `npm install` in an app resolves `@meridian/*` from public npm you have the wrong `.npmrc`.
Every workspace has one pointing here.
