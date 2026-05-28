// Core types for the TSI Report API

export interface CommitmentTerms {
  contractLengthMonths: number | null;  // 1 = month-to-month, 3, or 6
  contractStartDate: string | null;
  contractEndDate: string | null;
}

export interface ScheduledCancellation {
  pendingCancelDate: string | null;  // Date the cancellation is scheduled to take effect
  cancellationDate: string | null;
  requestDate: string | null;
  cancelStatus: string | null;
  reason: string | null;
  notes: string | null;
  competitor: string | null;         // Competitor named at time of cancellation request
  saveSolutions: string | null;      // Comma-separated list of save solutions already offered
}

export interface FalconBillingEvent {
  event: string;   // e.g. "Launch", "Registration", "Discount", "Adjustment"
  date: string;    // MM/DD/YYYY format from Falcon
  amount: number | null;
  status: string | null;
  notes: string | null;
}

export interface FalconCancellationEvent {
  event: string;           // e.g. "Requested", "Saved", "Cancelled", "Reactivated"
  date: string;            // raw date string from Falcon
  cancelStatus: string | null;
  reason: string | null;
  pendingCancelDate: string | null;
  competitor: string | null;       // Named competitor at cancellation — "" when blank, null when field absent
  saveSolutions: string | null;    // Comma-separated save solutions offered: "SEO Expansion,New Content,..."
  savedBy: string | null;          // Rep name who saved the account
  savedAt: string | null;          // ISO date of save
  lifecycleAction: string | null;  // Falcon lifecycle action label
}

export interface TeamMember {
  name: string;
  email: string | null;
  role: { code: string; label: string } | null;
}

export interface ClientServicingInfo {
  lastAttemptedContact: string | null;  // LAC — ISO date of most recent call attempt (every dial)
  responded: string | null;             // LCR — ISO date client last actually talked to TSI
  lastValueProvided: string | null;     // ISO date of last value-add touchpoint
  teamDivision: { code: string; label: string } | null;
  serviceTeam: TeamMember[];            // CSL and other assigned reps
}

export interface ContentGenActivity {
  lastCompletedAt: string | null;  // ISO date of last Client Hub content generation
  lastPageType: string | null;     // "Geo" | "FAQ" | "Blog" — what was last generated
}

export interface FalconClient {
  id: string;
  name: string;
  status: string;
  tsiMarket: string;
  price: number | null;
  paymentStatus: string | null;    // CURRENT | PAST_DUE from billing.paymentStatus
  gpPaymentStatus: string | null;  // legacy field — kept for compatibility
  vertical: string | null;         // Business vertical slug from Falcon (e.g. "tree_service", "painting")
  gccDate: string | null;          // Go-Current-Client date — date of onboarding call (often null)
  gpid: string | null;         // finance external service ID
  freshdeskId: string | null;  // ticketing external service ID
  vcitaId: string | null;      // crm external service ID
  billingEvents: FalconBillingEvent[];          // BillingHistoryItem activities
  cancellationHistory: FalconCancellationEvent[];  // CancellationLifecycleItem activities
  servicing: ClientServicingInfo | null;        // LAC, LCR, teamDivision, CSL list
  contentGenActivity: ContentGenActivity | null; // last Client Hub automation (Geo/FAQ/Blog only)
  latestSaveEvent: { savedAt: string | null } | null; // most recent save from cancellation
  subscription: {
    id: string;
    startDate: string;
    endDate: string | null;    // "0000-00-00" for M2M; actual date for contract clients
    launchDate: string;
    status: string;
    cost: number | null;
    serviceKeys: string[];
    commitmentTerms: CommitmentTerms | null;
    scheduledCancellation: ScheduledCancellation | null;
  } | null;
}

export interface GbpInsights {
  businessImpressions: number;
  mapImpressions: number;
  searchImpressions: number;
  websiteClicks: number;
  callClicks: number;
  directionRequests: number;
  postsLive: number;
  periodStart: string;
  periodEnd: string;
  searchKeywords: Array<{ keyword: string; impressions: number }> | null;
}

export interface GbpReview {
  reviewId: string;
  rating: string;
  comment: string | null;
  reviewer: string;
  createTime: string;
  hasReply: boolean;
}

export interface DudaContentItem {
  type: 'Blog';
  title: string;
  url: string;
  display: string;
  date: string;
}

export interface DudaSiteUpdate {
  date: string;
  label: string;
  detail: string;
}

export interface DudaPage {
  title: string;
  path: string;
}

export interface DudaSiteStats {
  siteAlias: string | null;
  lastPublished: string | null;
  pageViews: number;
  uniqueVisitors: number;
  visits: number;
  periodStart: string;
  periodEnd: string;
  totalPages: number;
  pages: DudaPage[];            // full page inventory with title + path for analyst classification
  publishedPosts: DudaContentItem[];
  siteUpdates: DudaSiteUpdate[];
}

export interface YextActionBreakdown {
  tapToCall: number;
  drivingDirections: number;
  website: number;
}

export interface YextListingsData {
  locationId: string | null;
  syncedListings: number;
  totalListings: number;
  averageScore: number | null;
  impressions: number;
  actions: number;
  accuracy: number | null;
  actionBreakdown: YextActionBreakdown | null;
}

export interface VcitaInvoiceItem {
  date: string;
  label: string;
  amount: number;
  status: string;
}

export interface VcitaEstimateItem {
  date: string;
  label: string;
  amount: number;
  status: string;
  client: string | null;
}

export interface VcitaPaymentItem {
  date: string;
  label: string;
  amount: number;
}

export interface VcitaLeadSample {
  name: string;    // "First Last" or "Unnamed client"
  status: string;  // customer_status from vcita
  email?: string;  // passed through for spam detection — vendor solicitations often have info@/marketing@ emails
}

export interface VcitaData {
  totalLeads: number;
  newLeads: number;
  openInvoices: number;
  totalRevenue: number;
  activePipeline: number;
  upcomingBookings: number;
  conversations: number;
  invoiceItems: VcitaInvoiceItem[];
  estimateItems: VcitaEstimateItem[];
  paymentItems: VcitaPaymentItem[];
  leadSamples: VcitaLeadSample[];  // up to 8 recent leads with names
}

export interface ActivityTicket {
  id: string;
  subject: string;
  body: string | null;   // Full ticket body text — used by gap auditor for content-based gap decisions
  type: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityData {
  // Tickets sourced from Falcon (mirrors Freshdesk data in TSI's system)
  openTickets: number;
  resolvedThisPeriod: number;
  totalThisPeriod: number;
  recentTickets: ActivityTicket[];
  // Interactions (calls, SMS) logged by the TSI team for this client
  callsThisPeriod: number;
  smsThisPeriod: number;
}

export interface SociPost {
  id: number;
  network: string;
  message: string;
  scheduledTime: string;
  sent: string | null;
  approved: boolean;
}

export interface SociPageMetrics {
  reach28day: number;
  reachPrev28day: number;
  reachChange28day: number;
  reachChangePct28day: number;
  engagedUsers28day: number;
  engagedUsersPrev28day: number;
  pageLikes: number;
  pageLikesPrev: number;
  pageLikesChange: number;
}

export interface SociFbInsights {
  pageFansDay: number;
  pageFansWeek: number;
  pageFans28day: number;
  pageFansChange28day: number;
  pageFansChangePct28day: number;
  pageImpressionsWeek: number;
  pageImpressions28day: number;
  pageImpressionsChangePct28day: number;
  pageEngagedUsersWeek: number;
  pageEngagedUsers28day: number;
  pagePostEngagements28day: number;
  pagePostsImpressions28day: number;
  pagePostsImpressionsChangePct28day: number;
}

export interface SociTopPost {
  id: string;
  message: string;
  impressions: number;
  impressionsOrganic: number;
  impressionsViral: number;
  engagedUsers: number;
  postClicks: number;
  scheduledTime: string;
}

export interface SociSentiment {
  positive: number;
  neutral: number;
  negative: number;
  avgSentiment: number;
}

export interface SociPeakHour {
  hour: number;
  value: number;
}

export interface SociDemographics {
  women: { total: number; byAge: Record<string, number> };
  men:   { total: number; byAge: Record<