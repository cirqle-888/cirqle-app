CREATE TABLE IF NOT EXISTS public.group_services (
  group_id UUID NOT NULL REFERENCES public.contribution_groups(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES public.services(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, service_id)
);

ALTER TABLE public.group_services ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Enable read access for all users" ON public.group_services;
CREATE POLICY "Enable read access for all users" 
ON public.group_services FOR SELECT 
USING (true);

DROP POLICY IF EXISTS "Enable all access for admin users" ON public.group_services;
CREATE POLICY "Enable all access for admin users" 
ON public.group_services FOR ALL 
USING (true) 
WITH CHECK (true);
