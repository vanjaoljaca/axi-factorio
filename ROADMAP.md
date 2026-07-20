# Roadmap

## Parked: pipeline merger

Multiple source blobs may eventually finish one pipeline and enter a deliberate,
single integration operation. A named integration workspace would reconcile
them once and emit one composite blob into a second pipeline.

The composite receipt must retain exact source blob IDs and accepted identities,
the merge operation and evidence, conflicts and their disposition, and the
resulting head. The likely first use is feature blobs becoming one app-release
blob for Dev, Beta, and Production.

This is parked pending a later design pass. rc.9 does not implement merger,
composite-blob, integration-workspace, or multi-pipeline behavior.
