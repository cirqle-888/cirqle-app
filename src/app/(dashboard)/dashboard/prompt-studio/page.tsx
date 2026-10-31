import { redirect } from "next/navigation";
import { createAdminClient, fetchAll } from "@/lib/supabase/server";
import { loadCurrentUser, hasPermission } from "@/lib/permissions/check";
import {
  LIBRARY_PAGE,
  type CustomTemplate,
  type SavedCard,
  type StudioClient,
  type LibraryItem,
} from "@/lib/prompt-studio/types";
import {
  STYLE_TEMPLATE_KEY,
  styleFromAnswer,
  type SavedStyle,
} from "@/lib/prompt-studio/style";
import PromptStudioClient from "./prompt-studio-client";

export const dynamic = "force-dynamic";

export default async function PromptStudioPage() {
  const me = await loadCurrentUser();
  if (!hasPermission(me, "prompt_studio.view")) redirect("/dashboard");
  const db = createAdminClient();
  // Probe directly: fetchAll caches missing tables and intentionally suppresses PGRST205.
  const probes = await Promise.all(
    ["prompt_client_cards", "prompt_templates", "prompt_library", "prompt_quick_looks"].map((table) =>
      db.from(table).select("id").limit(1),
    ),
  );
  const missing = probes.some(
    (r) =>
      r.error &&
      /PGRST205|does not exist|schema cache/i.test(
        `${r.error.code} ${r.error.message}`,
      ),
  );
  const unexpected = probes.find(
    (r) =>
      r.error &&
      !/PGRST205|does not exist|schema cache/i.test(
        `${r.error.code} ${r.error.message}`,
      ),
  );
  if (unexpected?.error)
    throw new Error("Could not load Prompt Studio. Please try again.");
  const [clients, cards, templates, library] = await Promise.all([
    fetchAll(
      db
        .from("clients")
        .select("id, name, phone, address")
        .eq("is_active", true)
        .order("name"),
    ),
    missing
      ? { data: [], error: null }
      : fetchAll(
          db.from("prompt_client_cards").select("client_id, card, updated_at"),
        ),
    missing
      ? { data: [], error: null }
      : fetchAll(
          db
            .from("prompt_templates")
            .select("*")
            .is("deleted_at", null)
            .order("name"),
        ),
    missing
      ? { data: [], error: null }
      : db
          .from("prompt_library")
          .select("*")
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(LIBRARY_PAGE),
  ]);
  // Saved styles ("Style from a picture" answers) for the "Mix in a saved style" picker.
  const styles = missing
    ? { data: [], error: null }
    : await db
        .from("prompt_library")
        .select("id, title, ai_result")
        .eq("template_key", STYLE_TEMPLATE_KEY)
        .is("deleted_at", null)
        .not("ai_result", "is", null)
        .order("created_at", { ascending: false })
        .limit(100);
  if ([clients, cards, templates, library, styles].some((r) => r.error))
    throw new Error("Could not load Prompt Studio data. Please try again.");
  const looks = missing ? { data: [], error: null } : await db.from("prompt_quick_looks")
    .select("id, name, template_key, client_id, values, style_id, language")
    .is("deleted_at", null).order("name");
  if (looks.error) throw new Error("Could not load Quick looks. Please try again.");
  const custom: CustomTemplate[] = templates.data.map((t) => ({
    id: t.id,
    key: t.key,
    name: t.name,
    category: t.category,
    purpose: t.purpose || "",
    useIn: t.use_in || "",
    usesClientCard: t.uses_client_card,
    fields: t.fields,
    body: t.body,
    based_on: t.based_on,
  }));
  return (
    <PromptStudioClient
      initialQuickLooks={looks.data || []}
      clients={clients.data as StudioClient[]}
      initialCards={cards.data as SavedCard[]}
      initialTemplates={custom}
      initialLibrary={(library.data || []) as LibraryItem[]}
      installed={!missing}
      canManage={hasPermission(me, "prompt_studio.manage") && !me?.isViewAs}
      myId={me?.employeeId ?? null}
      initialStyles={((styles.data || []) as { id: string; title: string | null; ai_result: string }[]).map(
        (r): SavedStyle => ({
          id: r.id,
          title: r.title || styleFromAnswer(r.ai_result).name,
          recipe: styleFromAnswer(r.ai_result).recipe,
        }),
      )}
      aiEnabled={!!process.env.GROQ_API_KEY}
    />
  );
}
