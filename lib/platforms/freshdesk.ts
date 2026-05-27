// Freshdesk platform helpers for the retention pipeline
//
// Primary data source for TSI client activity is Falcon (see lib/falcon.ts).
// This file handles Freshdesk-specific reads needed by the retention pipeline:
//   - Ticket conversation fetch: pulls the first N replies/notes on a cancel ticket
//     so the analyst has the actual human context, not just the auto-generated description.
//
// Auth: basic auth with "{api_key}:X" as the credential (Freshdesk API key convention)

import { getFreshdeskCredentials } from '../secrets';

interface FreshdeskConversation {
  id: number;
  body_text: string;
  incoming: boolean;      // true = from client, false = agent reply
  private: boolean;       // true = internal note, false = public reply
  from_email: string | null;
  created_at: string;
}

// Returns a plain-text summary of the first `limit` conversation entries on a ticket.
// Incoming client messages and internal agent notes are both included — labeled by source.
// Used to give the analyst context beyond the initial auto-generated ticket description.
export async function getTicketConversations(
  ticketId: number,
  limit = 5
): Promise<string | null> {
  let creds: { apiKey: string; domain: string };
  try {
    creds = await getFreshdeskCredentials();
  } catch {
    return null;
  }

  const encoded = Buffer.from(`${creds.apiKey}:X`).toString('base64');

  let res: Response;
  try {
    res = await fetch(
      `https://${creds.domain}/api/v2/tickets/${ticketId}/conversations`,
      {
        headers: {
          Authorization: `Basic ${encoded}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(8000), // fail fast — never stall the pipeline
      }
    );
  } catch {
    return null;
  }

  if (!res.ok) return null;

  let conversations: FreshdeskConversation[];
  try {
    conversations = await res.json() as FreshdeskConversation[];
  } catch {
    return null;
  }

  if (!Array.isArray(conversations) || conversations.length === 0) return null;

  // Take up to `limit` entries, oldest first
  const entries = conversations.slice(0, limit);

  const lines = entries.map((c) => {
    const source = c.incoming
      ? 'CLIENT'
      : c.private
        ? 'INTERNAL NOTE'
        : 'AGENT REPLY';
    const text = (c.body_text ?? '').trim().slice(0, 500); // cap length per entry
    return `[${source} — ${c.created_at.slice(0, 10)}]: ${text}`;
  });

  return lines.join('\n\n');
}
