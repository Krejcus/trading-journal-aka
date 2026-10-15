-- 14. 10. 2026: publishing the journal projection (510 positions in one
-- transaction) takes ~8.8 s, while API requests inherit the authenticator's
-- 8 s statement_timeout; every publish was cancelled and the journal showed
-- nothing after 7. 10. A function-level `set statement_timeout` does not
-- extend the timer of the calling statement (verified on production), so the
-- limit is raised for the server-only service_role. PostgREST applies the
-- impersonated role's settings per request. Stopgap until the live journal
-- writes only new positions; revert with `alter role service_role reset
-- statement_timeout`. Applied on production 14. 10. 2026 with Filip's consent.

alter role service_role set statement_timeout = '30s';
notify pgrst, 'reload config';
