# RxFit Client Platform — Project Brief

## What It Does

RxFit Client Platform is the client-facing web and mobile application powering RxFit's premium advisory platform service. It is not a marketplace app or a generic booking tool — it is a white-glove advisory operations platform. The app connects vetted operating partners with high-value founder and executive clients, handles session scheduling and location logistics (on-site engagements at the client's office, partner workspaces), processes payments, and surfaces a business KPI dashboard so clients can track outcomes over time.

---

## Target Avatars

### CLIENT AVATAR — "The Austin Executive"
- **Age:** 30–50
- **Location:** Austin, TX metro (primary); remote/nationwide (secondary)
- **Income:** $150K–$500K+ household
- **Lifestyle:** Extremely time-constrained. Meetings back-to-back. Values delegation over DIY.
- **Business goal:** Operate at an elite level without spending mental energy managing their own operating cadence. They want accountability, not information.
- **Pain points:** Generic consultancies feel too chaotic. Standard talent marketplaces (Upwork, Toptal) feel like they're for everyone — and they don't want "everyone." They've had advisors cancel last-minute with no system to catch it.
- **Buying trigger:** A trusted referral or a piece of content that signals RxFit is the premium option, not the mass-market option.
- **What they need from the app:** One tap to book. No friction. Session confirmation with advisor bio. History and progress visible at a glance.

### ADVISOR AVATAR — "The Professional Operator"
- **Age:** 28–45
- **Profile:** Operator-credentialed advisor (ex-founder / ex-FAANG) managing 15–30 active clients. May have a small team or work solo.
- **Pain points:** Admin overhead kills their time. Scheduling conflicts, client no-shows, payment chasing.
- **What they need from the app:** Real-time client roster view, session calendar management, automated payment confirmation, client progress notes.

---

## App Goals

1. **Reduce client time-to-booking to under 60 seconds** — The entire onboarding and session booking flow must be frictionless enough that a busy executive can complete it between meetings.
2. **Drive measurable client retention through outcomes visibility** — Surface business KPIs (ARR growth, burn multiple, operating-cadence streaks) that make clients FEEL their progress, not just assume it.
3. **Eliminate advisor administrative overhead by 80%** — Automate scheduling, payments, and session confirmations so advisors spend their cognitive load on advising, not logistics.

---

## Brand Voice

**Premium. Human. Outcomes-focused.**

- Write like a high-end concierge service, not a startup.
- Never use generic growth-hacking clichés ("crush your goals," "level up").
- Speak to outcomes and time savings, not features and specs.
- Warmth and competence in equal measure — clients should feel they are being taken care of, not sold to.
- Example tone: *"Your advisor is confirmed for Thursday at 7am. We've got you."*

---

## Competitive Differentiation

| Competitor | Their Model | RxFit Client Platform Advantage |
|---|---|---|
| **Upwork** | Marketplace for any freelancer, any project | RxFit is curated and vetted — you're not choosing from 200 advisors, you're matched |
| **Toptal** | Talent network and staffing back office | Toptal is a staffing tool; RxFit Client Platform is a client experience product |
| **Generic booking apps** | Appointment scheduling only | No business KPI tracking, no advisor-client relationship continuity, no premium positioning |
| **Personal spreadsheets** | Manual coordination via DM/text | Zero accountability, zero progress visibility, zero professionalism |

**The real differentiator:** RxFit Client Platform is the only product that treats executive advisory as a managed service — not a transaction.

---

## Current Development Status

**Active Development.** This is the core product for the RxFit business. The application is in active development with session booking and advisor matching flows as the current build priority. Payments via Stripe and Google OAuth authentication are targeted for integration in the current sprint. The business KPI dashboard is a near-term milestone following booking stability.

- **Tech Stack:** Next.js frontend, Node.js/Express backend, PostgreSQL (Cloud SQL `antigravity_brain`), Stripe, Google OAuth, Google Cloud Run
- **GitHub Repo:** `RxFit/AppRxFitai`
- **GCS Semantic Bucket:** `github-appRxFitai` in `Semantic-Brain-Desktop`
