# RxHarden Overview - Casa Trejo Hub Chat Use Case Optimization

## 1a. Project Overview & Core Objective
The core objective is to optimize the AI Assistant chat experience by introducing context-based routing and model switching dependent on the user's specific `useCase`. Specifically:
1. Support different chat intents (`deep_dive` / `interview` / `recall` / `execute`).
2. Route standard queries and structured interviews to high-capability models (`gemini-3.1-pro`), while routing contextual inquiries injected from panels (`recall` or `execute` tasks) to faster models (`gemini-3.5-flash`).
3. Commit and verify these changes end-to-end, correcting any compile/type errors, running production builds, and deploying the stable package to Railway.

## 1b. Exhaustive Task List
1. **Task 1: Fix Type Definition & Destructuring**
   - Correct the TypeScript typing error in [route.ts](file:///C:/Users/danie/Documents/antigravity/vibrant-chandrasekhar/hub/app/api/chat/route.ts) where `body` is explicitly typed as `{ messages: ChatMessage[] }` and fails when destructuring `useCase`.
2. **Task 2: Empirical Build Verification**
   - Execute a local production build (`npm run build`) and static type checks (`npx tsc --noEmit`) to verify compiler correctness.
3. **Task 3: Git Commit & Railway Cloud Deployment**
   - Commit all pending modified files.
   - Run `railway up -d` to push the verified build to the live environment.

## 1c. Task Impact Analysis
- **Task 1:** Prevents runtime API errors and allows the Next.js compiler to generate the optimized production bundle.
- **Task 2:** Confirms type safety and bundle compatibility across the workspace.
- **Task 3:** Durably commits the verified state to the Git history and ships the features to the end-users.

## 1d. Necessity Justification
- Without Task 1, the build fails and the deployment cannot proceed.
- Without Task 2, we risk deploying broken routing pathways.
- Without Task 3, the changes remain uncommitted and undelivered on local storage.
