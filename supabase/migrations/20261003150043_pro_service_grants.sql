grant execute on function public.is_pro(uuid) to service_role;
grant execute on function public.record_usage(uuid, int, int, int, int) to service_role;
grant select on public.usage to service_role;
