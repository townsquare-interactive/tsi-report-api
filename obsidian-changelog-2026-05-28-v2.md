# Changelog — 2026-05-28 v2

**Project:** tsi-report-api (Retention Pipeline)  
**Author:** Brett Boston  
**Scope:** QA batch feedback implementation — data enrichment, prompt overhaul, output fixes

---

## Summary

Full implementation pass based on QA review of 6-client batch test. Major changes across the data layer, analyst prompt, gap auditor, formatter, and MongoDB store. No behavior changes to note-writer or dedup gate.

---

## Files Changed

### lib/falcon.ts
- Added `clientServicingInformation { information { lastAttemptedContact, responded, lastValueProvided, teamDivision, serviceTeam } }` to CLIENT_QUERY
- Added `contentGenActivity { lastCompletedAt, lastPageType }` — Client Hub automation signal
- Added `retention { latestSaveEvent { savedAt } }` — most recent save from prior cancel
- Added `billing { paymentStatus }` — CURRENT | PAST_DUE (null until Falcon dev fixes permissions)
- Added raw interfaces: `RawTeamMember`, `RawServicingInformation`, `RawClientServicingInformation`
- Added `clientServicingInformation`, `contentGenActivity`, `retention`, `billing` to `RawFalconClient`
- Populated `servicing`, `contentGenActivity`, `latestSaveEvent`, `paymentStatus` in returned `FalconClient`

### types/report.ts
- Added `TeamMember` interface: `{ name, email, role: { code, label } | null }`
- Added `ClientServicingInfo` interface: `{ lastAttemptedContact, responded, lastValueProvided, teamDivision, serviceTeam: TeamMember[] }`
- Added `ContentGenActivity` interface: `{ lastCompletedAt, lastPageType }`
- Added `DudaPage` interface: `{ title, path }`
- Added to `FalconClient`: `paymentStatus`, `servicing`, `contentGenActivity`, `latestSaveEvent`
- Added to `DudaSiteStats`: `pages: DudaPage[]`

### lib/platforms/duda.ts
- Changed return value to include `pages: DudaPage[]` (full page inventory with title + path)
- `pageInventory` mapped from raw `pages` array — already fetched, previously discarded
- `totalPages` still returned (count)

### lib/retention/gap-auditor.ts
- Added LAC/LCR derivation: `daysSinceLAC`, `daysSinceLCR` from `client.servicing`
- Replaced `daysSinceLastTouchpoint` (incorrect proxy from ticket updatedAt) with `daysSinceLastTicketUpdate` (secondary signal only)
- Added `lastAttemptedContact`, `daysSinceLAC`, `lastClientResponse`, `daysSinceLCR`, `teamDivision`, `serviceTeam` to service snapshot
- Added `contentGenActivity` to snapshot
- Added LAC/LCR framing rules to service benchmark section in prompt
- Added TICKET SUBJECT READING section — model must read ticket subject for gap assessment, not just type
- Updated service dimension actual fields to include `daysSinceLAC`, `daysSinceLCR` (removed `daysSinceLastTouchpoint`)
- Updated service dimension narrative instruction

### lib/retention/analyst.ts
- Added `servicing` block to snapshot with LAC, LCR, daysSinceLAC, daysSinceLCR, teamDivision, serviceTeam names
- Added `contentGenActivity` to snapshot (with note: Geo/FAQ/Blog automation only, Duda is source of truth)
- Added `paymentStatus` to snapshot
- Added `websitePageInventory: duda.pages.slice(0, 30)` to snapshot
- Added 12-point prompt overhaul:
  - GBP zero vs. unavailable distinction (fetch fail vs. real zeros)
  - LAC/LCR contact story framing rules
  - No mea culpa rule
  - Billing decline playbook (fix-payment-first)
  - Specific content type naming (service/geo/FAQ/blog)
  - Competitor intelligence when competitor named
  - Cancellation urgency flag (<7 days)
  - Second cancel tone change
  - Forward-looking opportunityActions rule
  - Confident topRetentionHook rule

### lib/retention/formatter.ts
- Added `pipelineAtRiskOverride` logic: if `pipelineAtRisk < 50`, use `monthlyPrice * 12`
- Added `pipelineAtRiskOverride` parameter to `buildFormatterPrompt`
- Added PIPELINE AT RISK DISPLAY RULE to prompt
- Added S2 SPEAKING CONSTRAINT to prompt (15 words/sentence max, no compound clauses)
- Added COMPETITORS FIELD extraction instructions to prompt
- Added `"competitors": []` to JSON output template
- Updated `${analyst.pipelineAtRisk}` references to `${pipelineAtRiskOverride}`

### lib/retention/types.ts
- Added `competitors?: string[]` to `RetentionBrief`

### lib/retention/store.ts
- Added `competitors?: string[]` to `RetentionEventDoc`

### app/api/retention/route.ts
- Added `competitors: retentionBrief?.competitors ?? []` to MongoDB write doc

### docs/components.md
- Added full 2026-05-28 v2 section documenting all above changes

---

## Open Items

- **paymentStatus null:** `billing.paymentStatus` returns null for all clients despite CURRENT/PAST_DUE being visible in CRM. Query is wired. Falcon dev investigating permissions issue. Wire-up complete — data will flow once permissions resolved.
- **Freshdesk webhook:** Still manual-only. Graduation checklist pending Brett + Jennifer Pegram.

---

## Obsidian Files to Update

- `Apps/tsi-report-api.md` — update "last updated" date; note new Falcon fields
- `Integrations/falcon.md` — add clientServicingInformation, contentGenActivity, retention, billing fields; note paymentStatus null issue
- `Architecture/deploy.md` — no changes needed
