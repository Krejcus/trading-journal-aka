alter table public.tradovate_copier_commands
  drop constraint if exists tradovate_copier_commands_command_type_check;

alter table public.tradovate_copier_commands
  add constraint tradovate_copier_commands_command_type_check
  check (command_type in (
    'copy-command',
    'arm-live',
    'activate-group',
    'shadow',
    'disarm',
    'kill-switch',
    'verify-account-eligibility',
    'snapshot-test',
    'lock-until-session-end',
    'unlock-day'
  ));

comment on constraint tradovate_copier_commands_command_type_check
  on public.tradovate_copier_commands is
  'Only explicitly supported short-lived copier relay commands; day lock commands can only reduce or clear the internal copier gate and never ARM it.';
