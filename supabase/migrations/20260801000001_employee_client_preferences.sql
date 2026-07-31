-- Table: employee_client_preferences
-- Stores user-specific preferences (like custom greeting names) for each client.

CREATE TABLE public.employee_client_preferences (
    employee_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    greeting_name text,
    created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
    
    CONSTRAINT employee_client_preferences_pkey PRIMARY KEY (employee_id, client_id)
);

-- RLS Policies
ALTER TABLE public.employee_client_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Employees can view their own client preferences"
    ON public.employee_client_preferences
    FOR SELECT
    USING (auth.uid() = employee_id);

CREATE POLICY "Employees can update their own client preferences"
    ON public.employee_client_preferences
    FOR ALL
    USING (auth.uid() = employee_id)
    WITH CHECK (auth.uid() = employee_id);

-- Trigger to auto-update updated_at
CREATE TRIGGER set_employee_client_preferences_updated_at
    BEFORE UPDATE ON public.employee_client_preferences
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();
