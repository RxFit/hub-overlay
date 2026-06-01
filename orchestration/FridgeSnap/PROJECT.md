# FridgeSnap — Project Brief

## What It Does

FridgeSnap is an AI-powered nutrition and food tracking application that eliminates the single biggest reason people quit calorie counting: **the friction of manual entry.** Users open the app, photograph their fridge or a meal, and the computer vision pipeline instantly identifies every food item, estimates quantities, calculates macros and calories, and logs the results — no typing required.

The app also surfaces meal and recipe suggestions based on what's actually in the fridge, integrating with the RxFit wellness ecosystem so that nutrition data flows into a client's training picture automatically.

**Core value proposition in one sentence:** *Snap a photo. Know your macros. Done.*

---

## Target Avatars

### PRIMARY AVATAR — "The Data-Driven Health Optimizer"
- **Age:** 25–45
- **Location:** Nationwide (all major US metros)
- **Profile:** Wearable user (Apple Watch, Whoop, Oura Ring), biometric tracker, experiments with diets (keto, carnivore, high-protein). Quantifies everything. Already tracks sleep, HRV, steps.
- **Pain point:** Nutrition is the hardest data domain to track consistently. They've started and abandoned MyFitnessPal 3+ times. Manual entry is tedious, inaccurate (guessing portion sizes), and unsustainable. They WANT accurate nutrition data — they just won't maintain a manual system to get it.
- **Buying trigger:** See the snap-to-log demo. The friction elimination is immediately obvious.
- **Platform behavior:** Apple Health integration, Reddit (r/nutrition, r/biohacking, r/intermittentfasting), YouTube fitness science channels (Thomas DeLauer, Renaissance Periodization), TikTok health content.

### SECONDARY AVATAR — "The RxFit Client"
- **Profile:** Already an RxFit-Concierge user. Trainer has recommended nutrition tracking as part of their program.
- **Integration opportunity:** FridgeSnap data surfaces on the RxFit wellness dashboard — creating a closed loop between training and nutrition.
- **Why they use FridgeSnap instead of alternatives:** Their RxFit trainer recommends it. It's built into their existing system. They don't have to manage yet another unconnected app.

---

## App Goals

1. **Achieve >90% food recognition accuracy** — Accuracy is the product. If the macro calculations are wrong, the app erodes trust permanently and users revert to manual tools.
2. **Drive frictionless daily active usage** — Log rate (% of days users snap at least one meal) is the signal for habit formation. Target: users logging 5+ days per week within 30 days of install.
3. **Convert RxFit-Concierge clients into FridgeSnap subscribers** — The cross-app integration creates a natural upgrade path. Every RxFit client is a warm lead for FridgeSnap.

---

## Brand Voice

**Smart. Modern. Effortless.**

- This is a tech product for people who love data — but hate busywork.
- Never clinical or diet-culture-y ("calories in, calories out," "stay on track"). These users know nutrition science; respect their intelligence.
- Show the contrast: "logging macros used to take 8 minutes per meal. FridgeSnap takes 3 seconds."
- Energy is high but precise — enthusiastic about the tech, not preachy about health.
- Example tone: *"You already track your sleep, your HRV, your steps. Now your nutrition data actually shows up."*

---

## Competitive Differentiation

| Competitor | Their Model | FridgeSnap Advantage |
|---|---|---|
| **MyFitnessPal** | Manual entry + barcode scan | Every meal still requires human input. FridgeSnap is zero-entry. |
| **Lose It!** | Manual entry + database search | Same friction model. Large database, terrible UX for power users. |
| **Cronometer** | Manual entry, micronutrient focus | Beloved by biohackers, but still manual. FridgeSnap integrates with that audience automatically. |
| **Noom** | Coaching + behavior change | Subscription coaching model, very manual. Different value prop entirely. |

**The real differentiator:** Every competitor requires the user to do the cognitive work of identifying and logging food. FridgeSnap eliminates that job completely. The user's only job is to hold up their phone.

---

## RxFit Ecosystem Integration

FridgeSnap nutrition data (daily macros, calorie totals, meal patterns) feeds into the RxFit wellness KPI dashboard in RxFit-Concierge. Trainers can view client nutrition consistency alongside training session data — creating a complete picture of client adherence, not just workout performance.

---

## Current Development Status

**Experimental / Early Stage.** FridgeSnap is in pre-product-market-fit phase. The core computer vision pipeline (snap → food identification → macro calculation) is the primary build focus. The technical team is iterating on recognition accuracy as the baseline metric before scaling growth. The RxFit integration is a near-term milestone once the core pipeline is stable.

- **Tech Stack:** Gemini 2.5 Pro (via Replit AI Integrations) — handles vision, food recognition, and nutrition extraction end-to-end in a single inference pipeline. Hosted on Replit. No separate Vision API, nutrition database, or cloud storage layer.
- **GitHub Repo:** `RxFit/Fridge-Food-Snap`
- **GCS Semantic Bucket:** `github-fridgesnap` in `Semantic-Brain-Desktop`
- **Marketing alias:** "FridgeSnap"
