# RxFit Wellness App — Project Brief

## What It Does

RxFit Wellness App is the client-facing web and mobile application powering RxFit's premium wellness platform service. It is not a gym app or a generic booking tool — it is a white-glove fitness operations platform. The app connects vetted personal trainers with high-value clients, handles session scheduling and location logistics (home visits, satellite gym locations), processes payments, and surfaces a wellness KPI dashboard so clients can track outcomes over time.

---

## Target Avatars

### CLIENT AVATAR — "The Austin Executive"
- **Age:** 30–50
- **Location:** Austin, TX metro (primary); remote/nationwide (secondary)
- **Income:** $150K–$500K+ household
- **Lifestyle:** Extremely time-constrained. Meetings back-to-back. Values delegation over DIY.
- **Fitness goal:** Look and feel elite without spending mental energy managing their own program. They want accountability, not information.
- **Pain points:** Generic gyms feel too chaotic. Standard booking apps (Mindbody, Vagaro) feel like they're for everyone — and they don't want "everyone." They've had trainers cancel last-minute with no system to catch it.
- **Buying trigger:** A trusted referral or a piece of content that signals RxFit is the premium option, not the mass-market option.
- **What they need from the app:** One tap to book. No friction. Session confirmation with trainer bio. History and progress visible at a glance.

### TRAINER AVATAR — "The Professional Coach"
- **Age:** 28–45
- **Profile:** Certified personal trainer managing 15–30 active clients. May have a small team or work solo.
- **Pain points:** Admin overhead kills their time. Scheduling conflicts, client no-shows, payment chasing.
- **What they need from the app:** Real-time client roster view, session calendar management, automated payment confirmation, client progress notes.

---

## App Goals

1. **Reduce client time-to-booking to under 60 seconds** — The entire onboarding and session booking flow must be frictionless enough that a busy executive can complete it between meetings.
2. **Drive measurable client retention through outcomes visibility** — Surface wellness KPIs (strength benchmarks, weight, consistency streaks) that make clients FEEL their progress, not just assume it.
3. **Eliminate trainer administrative overhead by 80%** — Automate scheduling, payments, and session confirmations so trainers spend their cognitive load on coaching, not logistics.

---

## Brand Voice

**Premium. Human. Outcomes-focused.**

- Write like a high-end concierge service, not a startup.
- Never use generic fitness clichés ("crush your goals," "level up").
- Speak to outcomes and time savings, not features and specs.
- Warmth and competence in equal measure — clients should feel they are being taken care of, not sold to.
- Example tone: *"Your trainer is confirmed for Thursday at 7am. We've got you."*

---

## Competitive Differentiation

| Competitor | Their Model | RxFit Wellness App Advantage |
|---|---|---|
| **Mindbody** | Marketplace for any fitness studio, any trainer | RxFit is curated and vetted — you're not choosing from 200 trainers, you're matched |
| **Vagaro** | Business management tool for studios | Vagaro is a back-office tool; RxFit Wellness App is a client experience product |
| **Generic booking apps** | Appointment scheduling only | No wellness tracking, no trainer-client relationship continuity, no premium positioning |
| **Personal spreadsheets** | Manual coordination via DM/text | Zero accountability, zero progress visibility, zero professionalism |

**The real differentiator:** RxFit Wellness App is the only product that treats personal training as a managed service — not a transaction.

---

## Current Development Status

**Active Development.** This is the core product for the RxFit business. The application is in active development with session booking and trainer matching flows as the current build priority. Payments via Stripe and Google OAuth authentication are targeted for integration in the current sprint. The wellness KPI dashboard is a near-term milestone following booking stability.

- **Tech Stack:** Next.js frontend, Node.js/Express backend, PostgreSQL (Cloud SQL `antigravity_brain`), Stripe, Google OAuth, Google Cloud Run
- **GitHub Repo:** `RxFit/AppRxFitai`
- **GCS Semantic Bucket:** `github-appRxFitai` in `Semantic-Brain-Desktop`
