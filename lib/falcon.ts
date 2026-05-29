// Falcon GraphQL client — maps Falcon client ID to all platform identifiers
// and fetches client activity (tickets + interactions) for the report period
// Endpoint: https://falcon.tsi.tools/api/graphql
// Auth: x-api-key header

import type { FalconClient, ActivityData, FalconBillingEvent, FalconCancellationEvent, ClientServicingInfo, ContentGenActivity } from '@/types/report';
import { getFalconCredentials } from './secrets';

// Fetch up to 100 most recent activities — filtered by date in-process since
// Falcon activities don't support a date range filter param
const CLIENT_QUERY = `
  query GetClient($id: ID!) {
    client(id: $id) {
      id
      name
      status
      tsiMarket
      gccDate
      business {
        vertical
      }
      externalServiceIds {
        id
        name
        provider
      }
      subscription {
        id
        information {
          id
          startDate
          endDate
          launchDate
          status
          cost
          serviceKeys
          commitmentTerms {
            contractLengthMonths
            contractStartDate
            contractEndDate
          }
          scheduledCancellation {
            pendingCancelDate
            cancellationDate
            requestDate
            cancelStatus
            reason
            notes
            competitor
            saveSolutions
            savedBy
            savedAt
            cancelCreatedDate
          }
        }
      }
      clientServicingInformation {
        information {
          lastAttemptedContact
          responded
          lastValueProvided
          teamDivision { code label }
          serviceTeam {
            members {
              name
              email
              role { code label }
            }
          }
        }
      }
      contentGenActivity {
        lastCompletedAt
        lastPageType
      }
      retention {
        latestSaveEvent {
          savedAt
        }
      }
      billing {
        paymentStatus
      }
      activities(limit: 100) {
        __typename
        ... on Ticket {
          id
          subject
          body
          ticketType: type
          ticketStatus: status
          createdAt
          updatedAt
        }
        ... on Interaction {
          interactionType: type
          interactionStatus: status
          direction
          interactionCreatedAt: createdAt
        }
        ... on BillingHistoryItem {
          event
          date
          amount
          status
          notes
        }
        ... on CancellationLifecycleItem {
          event
          date
          cancelStatus
          reason
          pendingCancelDate
          competitor
          saveSolutions
          savedBy
          savedAt
          lifecycleAction
        }
      }
    }
  }
`;

interface RawExternalService {
  id: string;
  name: string;
  provider: string | null;
}

interface RawTeamMember {
  name: string;
  email: string | null;
  role: { code: string; label: string } | null;
}

interface RawServicingInformation {
  lastAttemptedContact: string | null;
  responded: string | null;
  lastValueProvided: string | null;
  teamDivision: { code: string; label: string } | null;
  serviceTeam: { members: RawTeamMember[] } | null;
}

interface RawClientServicingInformation {
  information: RawServicingInformation | null;
}

interface RawTicket {
  __typename: 'Ticket';
  id: string;
  subject: string;
  body: string | null;
  ticketType: string | null;
  ticketStatus: string;
  createdAt: string;
  updatedAt: string;
}

interface RawInteraction {
  __typename: 'Interaction';
  interactionType: string;
  interactionStatus: string;
  direction: string;
  interactionCreatedAt: string;
}

interface RawBillingHistoryItem {
  __typename: 'BillingHistoryItem';
  event: string;
  date: string;
  amount: number | null;
  status: string | null;
  notes: string | null;
}

interface RawCancellationLifecycleItem {
  __typename: 'CancellationLifecycleItem';
  event: string;
  date: string;
  cancelStatus: string | null;
  reason: string | null;
  pendingCancelDate: string | null;
  competitor: string | null;
  saveSolutions: string | null;
  savedBy: string | null;
  savedAt: string | null;
  lifecycleAction: string | null;
}

type RawActivity = RawTicket | RawInteraction | RawBillingHistoryItem | RawCancellationLifecycleItem | { __typename: string };

interface RawFalconClient {
  id: string;
  name: string;
  status: string;
  tsiMarket: string;
  gccDate: string | null;
  business: { vertical: string | null } | null;
  externalServiceIds: RawExternalService[];
  activities: RawActivity[];
  clientServicingInformation: RawClientServicingInformation | null;
  contentGenActivity: { lastCompletedAt: string | null; lastPageType: string | null } | null;
  retention: { latestSaveEvent: { savedAt: string | null } | null } | null;
  billing: { paymentStatus: string | null } | null;
  subscription: {
    id: string;
    information: {
      id: string;
      startDate: string;
      endDate: string | null;
      launchDate: string;
      status: string;
      cost: number | null;
      serviceKeys: string[];
      commitmentTerms: {
        contractLengthMonths: number | null;
        contractStartDate: string | null;
        contractEndDate: string | null;
      } | null;
      scheduledCancellation: {
        pendingCancelDate: string | null;
        cancellationDate: string | null;
        requestDate: string | null;
        cancelStatus: string | null;
        reason: string | null;
        notes: string | null;
        competitor: string | null;
        saveSolutions: string | null;
        savedBy: string | null;
        savedAt: string | null;
        cancelCreatedDate: string | null;
      } | null;
    } | null;
  } | null;
}

// Identifies cancellation request tickets — pipeline events, not service issues.
// Excluded from openTickets count and recentTickets so the analyst never treats
// the current cancellation ticket as an open support item to "close."
function isCancelTicket(ticket: RawTicket): boolean {
  return /cancellation/i.test(ticket.ticketType ?? '');
}

// Identifies accounts receivable tickets — billing/collections events, not service health signals.
// Excluded from openTickets and recentTickets so AR disputes don't appear as open service issues.
function isARTicket(ticket: RawTicket): boolean {
  return /accounts?\s*receivable/i.test(ticket.ticketType ?? '');
}

// Identifies account resolution tickets — billing/payment workflow artifacts created automatically
// on billing declines. Not a client service event; excluded from all activity counts and gap scoring.
function isAccountResolutionTicket(ticket: RawTicket): boolean {
  return /account\s*resolution/i.test(ticket.ticketType ?? '');
}

function buildActivityData(activities: RawActivity[], periodDays: number): ActivityData {
  const cutoff = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

  const allTickets = activities.filter((a): a is RawTicket => a.__typename === 'Ticket');
  const interactions = activities.filter((a): a is RawInteraction => a.__typename === 'Interaction');

  // Strip workflow tickets before any counting — none are service health signals
  const tickets = allTickets.filter(
    (t) => !isCancelTicket(t) && !isARTicket(t) && !isAccountResolutionTicket(t)
  );

  const ticketsInPeriod = tickets.filter((t) => new Date(t.createdAt) >= cutoff);
  const interactionsInPeriod = interactions.filter(
    (i) => new Date(i.interactionCreatedAt) >= cutoff
  );

  const openTickets = ticketsInPeriod.filter(
    (t) => t.ticketStatus === 'OPEN' || t.ticketStatus === 'IN_PROGRESS' || t.ticketStatus === 'BLOCKED'
  ).length;

  const resolvedThisPeriod = ticketsInPeriod.filter(
    (t) => t.ticketStatus === 'RESOLVED' || t.ticketStatus === 'CLOSED'
  ).length;

  const callsThisPeriod = interactionsInPeriod.filter((i) => i.interactionType === 'VOICE').length;
  const smsThisPeriod = interactionsInPeriod.filter((i) => i.interactionType === 'SMS').length;

  const recentTickets = ticketsInPeriod.slice(0, 5).map((t) => ({
    id: t.id,
    subject: t.subject,
    body: t.body ?? null,
    type: t.ticketType,
    status: t.ticketStatus,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }));

  return {
    openTickets,
    resolvedThisPeriod,
    totalThisPeriod: ticketsInPeriod.length,
    recentTickets,
    callsThisPeriod,
    smsThisPeriod,
  };
}

export async function getClientById(
  clientId: string,
  periodDays = 30
): Promise<{ client: FalconClient; activities: ActivityData }> {
  const { apiKey, endpoint, headerName } = await getFalconCredentials();

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [headerName]: apiKey,
    },
    body: JSON.stringify({ query: CLIENT_QUERY, variables: { id: clientId } }),
  });

  if (!response.ok) {
    throw new Error(`Falcon API error: ${response.status} ${response.statusText}`);
  }

  const json = await response.json() as {
    data?: { client?: RawFalconClient };
    errors?: { message: string }[]
  };

  if (json.errors?.length) {
    throw new Error(`Falcon GraphQL error: ${json.errors[0].message}`);
  }

  const raw = json.data?.client;
  if (!raw) {
    throw new Error(`Client ${clientId} not found in Falcon`);
  }

  const extMap = new Map(raw.externalServiceIds.map((e) => [e.id, e.name]));
  // Use provider-based lookup for vcita — bmp/vcita value is the hex UID used for x-on-behalf-of
  const vcitaEntry = raw.externalServiceIds.find((e) => e.provider === 'vcita');

  // Extract billing events from activities — keep all (not period-filtered) for 12-month lookback
  const billingEvents: FalconBillingEvent[] = (raw.activities ?? [])
    .filter((a): a is RawBillingHistoryItem => a.__typename === 'BillingHistoryItem')
    .map((b) => ({
      event: b.event,
      date: b.date,
      amount: b.amount,
      status: b.status,
      notes: b.notes,
    }));

  // Extract cancellation lifecycle history — all events, not period-filtered
  const cancellationHistory: FalconCancellationEvent[] = (raw.activities ?? [])
    .filter((a): a is RawCancellationLifecycleItem => a.__typename === 'CancellationLifecycleItem')
    .map((c) => ({
      event: c.event,
      date: c.date,
      cancelStatus: c.cancelStatus,
      reason: c.reason,
      pendingCancelDate: c.pendingCancelDate,
      competitor: c.competitor || null,
      saveSolutions: c.saveSolutions || null,
      savedBy: c.savedBy || null,
      savedAt: c.savedAt || null,
      lifecycleAction: c.lifecycleAction || null,
    }));

  // Extract servicing info — LAC (lastAttemptedContact) and LCR (responded)
  const servicingInfo = raw.clientServicingInformation?.information ?? null;
  const servicing: ClientServicingInfo | null = servicingInfo ? {
    lastAttemptedContact: servicingInfo.lastAttemptedContact ?? null,
    responded: servicingInfo.responded ?? null,
    lastValueProvided: servicingInfo.lastValueProvided ?? null,
    teamDivision: servicingInfo.teamDivision ?? null,
    serviceTeam: (servicingInfo.serviceTeam?.members ?? []).map((m) => ({
      name: m.name,
      email: m.email ?? null,
      role: m.role ? { code: m.role.code, label: m.role.label } : null,
    })),
  } : null;

  const contentGenActivity: ContentGenActivity | null = raw.contentGenActivity ? {
    lastCompletedAt: raw.contentGenActivity.lastCompletedAt ?? null,
    lastPageType: raw.contentGenActivity.lastPageType ?? null,
  } : null;

  // Enrich scheduledCancellation with competitor + saveSolutions fields
  const rawSchedCancel = raw.subscription?.information?.scheduledCancellation ?? null;
  const scheduledCancellation = rawSchedCancel ? {
    pendingCancelDate: rawSchedCancel.pendingCancelDate,
    cancellationDate: rawSchedCancel.cancellationDate,
    requestDate: rawSchedCancel.requestDate,
    cancelStatus: rawSchedCancel.cancelStatus,
    reason: rawSchedCancel.reason,
    notes: rawSchedCancel.notes,
    competitor: rawSchedCancel.competitor || null,
    saveSolutions: rawSchedCancel.saveSolutions || null,
  } : null;

  const client: FalconClient = {
    id: raw.id,
    name: raw.name,
    status: raw.status,
    tsiMarket: raw.tsiMarket,
    price: raw.subscription?.information?.cost ?? null,
    gpPaymentStatus: null,
    paymentStatus: raw.billing?.paymentStatus ?? null,
    vertical: raw.business?.vertical ?? null,
    gccDate: raw.gccDate ?? null,
    gpid: extMap.get('finance') ?? null,
    freshdeskId: extMap.get('ticketing') ?? null,
    vcitaId: vcitaEntry?.name ?? null,
    billingEvents,
    cancellationHistory,
    servicing,
    contentGenActivity,
    latestSaveEvent: raw.retention?.latestSaveEvent ?? null,
    subscription: raw.subscription?.information
      ? {
          id: raw.subscription.id,
          startDate: raw.subscription.information.startDate,
          endDate: raw.subscription.information.endDate ?? null,
          launchDate: raw.subscription.information.launchDate,
          status: raw.subscription.information.status,
          cost: raw.subscription.information.cost,
          serviceKeys: raw.subscription.information.serviceKeys ?? [],
          commitmentTerms: raw.subscription.information.commitmentTerms ?? null,
          scheduledCancellation,
        }
      : null,
  };

  const activities = buildActivityData(raw.activities ?? [], periodDays);

  return { client, activities };
}
