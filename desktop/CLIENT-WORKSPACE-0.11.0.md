# Client workspace — 0.11.0

Choose **Client workspace** in the desktop toolbar, open a client, then choose **Open client workspace**. The workspace opens client-filtered tasks, invoices and Flyers alongside the active WhatsApp account. Permission hints omit unavailable task/invoice pages; existing server permissions still enforce access.

The Client chat shortcut opens a contact only when an international phone number can be resolved. Otherwise it copies the displayed client name for manual WhatsApp search. It never sends a message.

Unsaved Flyer changes block workspace switching until the existing save/discard confirmation is resolved. Client identity and phone details are runtime-only and excluded from desktop settings persistence.

Deploy the accompanying Cirqle and Offer Studio source changes for direct client-card actions and client-filtered Flyers. The desktop injects an action into older client detail pages. On an older Flyer deployment, it hides the unfiltered offers and explains that an app update is required. Offer filtering uses the exact Cirqle client UUID mapped through clients.cirqle_id, including counts, search and new draft creation. Invalid or unmapped clients show no other clients' offers.

Validation: desktop IPC/pane/workflow checks; four Offer Studio exact-client query tests; both application source typechecks. Cirqle source check excludes the existing malformed generated .next/dev/types validator.
