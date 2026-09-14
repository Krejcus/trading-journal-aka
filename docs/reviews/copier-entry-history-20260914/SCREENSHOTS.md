# ENTRY/EXIT screenshot reliability — 2026-09-14

## Incident evidence

The morning worker emitted entry and exit events with a valid episode. The
recorded last capture attempt matches exit; no successful capture/upload was
recorded since worker start. Storage and metadata contain no images for that
episode. A later camera probe reported ready despite the missing capture.
Capture code swallowed all errors, so the precise historical failure cannot be
recovered. A timeout is a possibility, not a proven incident diagnosis.

## Local fix

- Capture has an independent maximum 8-second budget, within 15 seconds of the
  original event. Rendering receives 1500 ms; paint waits are bounded. Failures
  report target/normalize/capture phase, a sanitized code and elapsed time.
- The camera serializes captures. A superseding entry/exit invalidates an image
  still being produced, and expired requests are never recaptured later.
- A valid PNG is persisted privately on the Mac before upload. The spool uses
  fsync plus atomic rename, permissions 0600 and the existing connection/leader
  state directory. At most 32 images, each at most 2 MiB; a full/corrupt spool is
  reported and never silently overwritten or cleared.
- Upload retries reuse original episode/kind/time/PNG and the existing idempotent
  storage key. The original APNs deadline remains unchanged; it no longer stops
  storing a journal image. Pending images survive process restarts. Four jobs
  per pass, one upload at a time, failures rotate to avoid starvation.
- Capture/storage failures are persisted independently of camera readiness.
  Ready probes and newer successful captures cannot acknowledge a missing
  historical image. A retry clears only its own recovered upload failure.
- The existing LIVE status chip shows missing images or pending uploads with
  its current styling. No broker order, ARM, risk or reconciliation changes.

## Verification

- Full regression run: 394 files / 3580 tests passed before the final three
  timing tests and permanent-failure regression were added.
- Final targeted run: 4 files / 34 tests passed (timing, spool, relay, LIVE status).
- Includes slow 3200-ms rendering beyond the old cap; sanitized phase errors;
  offline/restart/late upload with identical bytes; concurrent enqueue while
  uploading; missing capture retained across probe/restart; queue bound,
  corruption, permissions, starvation, expired/superseded image rejection.
- TypeScript, production web build, scoped ESLint and worker bundle checks.

No production deployment or worker restart for this change. No real chart
capture/upload or broker action performed. The missing original morning images
cannot be reconstructed from fills. Production verification after approval must
check the new bundle hash, a dedicated chart capture while DISARMED, durable
upload/metadata, truthful status and independent flat/no-working copier state.
