// vcita platform fetcher
//
// Auth: directory token from tsi/mcp/vcita
//       + x-on-behalf-of: {vcita hex business UID}
// Calls api.vcita.biz directly — Lambda IPs not blocked.
//
// The vcitaId passed in IS the hex business UID — it comes from Falcon
// externalServiceIds where provider === 'vcita' (id: 'bmp').
// No mapping needed. To find the UID for a new client manually:
//   GET /platform/v1/businesses?email={clientAdminEmail}

import type { VcitaData, VcitaLeadSample } from '@/types/report';
import { getVcitaCredentials } from '../secrets';

const VCITA = 'https://api.vcita.biz';

interface VcitaClient { id: string; customer_status: string; first_name?: string; last_name?: string; email?: string; }
interface VcitaInvoice {
  id: string; status: string; title?: string; due_date?: string; created_at?: string;
  total_amount?: number; total?: number; amount?: number;
}
interface VcitaEstimate {
  id: string; status: string; title?: string; created_at?: string;
  total_amount?: number; total?: number; amount?: number;
  client_id?: string; client_name?: string;
}
interface VcitaPayment {
  id: string; created_at?: string; amount?: number; description?: string;
}
interface VcitaAppointment { id: string; start_time: string; status?: string; }
interface VcitaConversation { id: string; created_at?: string; }
interface VcitaFormEntry { id: string; created_at?: string; }

async function vcitaGet<T>(
  token: string,
  businessUid: string,
  url: string,
  resourceKey: string
): Promise<T[]> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'x-on-behalf-of': businessUid,
      'Content-Type': 'application/json',
    },
  });

  // 403 = this client doesn't have this product/feature enabled — treat as empty, not an error
  if (res.status === 403) return [];
  if (!res.ok) throw new Error(`vcita ${resourceKey}: HTTP ${res.status}`);

  const json = await res.json() as Record<string, unknown>;
  if (json['status'] === 'failure' || json['status'] === 'Error' || json['error']) {
    throw new Error(`vcita ${resourceKey}: ${JSON.stringify(json).slice(0, 200)}`);
  }

  const data = json['data'] as Record<string, T[]> | undefined;
  if (data && !Array.isArray(data) && Array.isArray(data[resourceKey])) return data[resourceKey];
  if (Array.isArray(data)) return data as T[];
  throw new Error(`vcita ${resourceKey} unexpected shape: ${JSON.stringify(json).slice(0, 200)}`);
}

export async function getVcitaData(
  businessUid: string,
  periodDays: number
): Promise<VcitaData> {
  const { token } = await getVcitaCredentials();

  const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];

  const [clients, invoices, estimates, payments, appointments, conversations] = await Promise.all([
    vcitaGet<VcitaClient>(token, businessUid,
      `${VCITA}/platform/v1/clients?search_by=updated_at&updated_at[gte]=${since}&per_page=100`,
      'clients'),
    vcitaGet<VcitaInvoice>(token, businessUid,
      `${VCITA}/platform/v1/invoices?per_page=100`,
      'invoices'),
    vcitaGet<VcitaEstimate>(token, businessUid,
      `${VCITA}/platform/v1/estimates?per_page=100`,
      'estimates').catch(() => [] as VcitaEstimate[]),
    vcitaGet<VcitaPayment>(token, businessUid,
      `${VCITA}/platform/v1/payments?per_page=100`,
      'payments').catch(() => [] as VcitaPayment[]),
    vcitaGet<VcitaAppointment>(token, businessUid,
      `${VCITA}/platform/v1/scheduling/appointments?per_page=50`,
      'appointments'),
    vcitaGet<VcitaConversation>(token, businessUid,
      `${VCITA}/platform/v1/conversations?per_page=100`,
      'conversations').catch(() => [] as VcitaConversation[]),
  ]);

  const cutoff = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
  const inPeriod = (dateStr?: string) => dateStr ? new Date(dateStr) >= cutoff : false;

  const leads = clients.filter((c) => c.customer_status === 'lead');

  // Build named lead samples — used in retention note for anecdotes instead of bare counts.
  // Email is included so the analyst can apply spam judgment (vendor solicitations often have
  // info@/marketing@/sales@ emails or company-sounding names without a real first/last name).
  const leadSamples: VcitaLeadSample[] = leads.slice(0, 8).map((c) => ({
    name: [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || 'Unnamed client',
    status: c.customer_status,
    email: c.email ?? undefined,
  }));
  const openInvoices = invoices.filter(
    (i) => i.status === 'draft' || i.status === 'sent' || i.status === 'overdue' || i.status === 'issued'
  );
  const paidInvoices = invoices.filter((i) => i.status === 'paid');
  const totalRevenue = paidInvoices.reduce(
    (sum, i) => sum + (i.total_amount ?? i.total ?? i.amount ?? 0), 0
  );

  const upcomingAppointments = appointments.filter(
    (a) => a.status !== 'cancelled' && a.status !== 'completed' && new Date(a.start_time) >= new Date()
  );

  // Invoice line items for the period
  const invoiceItems = invoices
    .filter((i) => inPeriod(i.created_at ?? i.due_date))
    .map((i) => ({
      date: (i.created_at ?? i.due_date ?? '').split('T')[0],
      label: i.title ?? `Invoice`,
      amount: i.total_amount ?? i.total ?? i.amount ?? 0,
      status: i.status,
    }));

  // Estimate line items for the period
  const estimateItems = estimates
    .filter((e) => inPeriod(e.created_at))
    .map((e) => ({
      date: (e.created_at ?? '').split('T')[0],
      label: e.title ?? 'Estimate',
      amount: e.total_amount ?? e.total ?? e.amount ?? 0,
      status: e.status,
      client: e.client_name ?? null,
    }));

  // Payment line items for the period
  const paymentItems = payments
    .filter((p) => inPeriod(p.created_at))
    .map((p) => ({
      date: (p.created_at ?? '').split('T')[0],
      label: p.description ?? 'Payment',
      amount: p.amount ?? 0,
    }));

  const conversationsThisPeriod = conversations.filter((c) => inPeriod(c.created_at)).length;

  // Active pipeline = sum of approved/invoiced estimates
  const activePipeline = estimates
    .filter((e) => e.status === 'approved' || e.status === 'invoiced')
    .reduce((sum, e) => sum + (e.total_amount ?? e.total ?? e.amount ?? 0), 0);

  return {
    totalLeads: clients.length,
    newLeads: leads.length,
    openInvoices: openInvoices.length,
    totalRevenue,
    activePipeline,
    upcomingBookings: upcomingAppointments.length,
    conversations: conversationsThisPeriod,
    invoiceItems,
    estimateItems,
    paymentItems,
    leadSamples,
  };
}
