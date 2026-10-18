# React + TypeScript + Vite + shadcn/ui

This is a template for a new Vite project with React, TypeScript, and shadcn/ui.

## Pairing data cleanup

The TypeScript Cloud Function in `cloud-functions/src/index.ts` deletes a user's
pairings and active invite when their Firebase Auth account is deleted,
including accounts deleted outside the app. Deploy Firestore rules and the
function with:

```bash
npx -y firebase-tools@latest deploy --only firestore,functions --project <project-id>
```

Cloud Functions deployment requires the Blaze plan and a billing account.

Pairing data is stored at `pairing/{ownerUid}_{partnerUid}`. Pending invite
codes are stored separately in `pairingInvites`.

## Adding components

To add components to your app, run the following command:

```bash
npx shadcn@latest add button
```

This will place the ui components in the `src/components` directory.

## Using components

To use the components in your app, import them as follows:

```tsx
import { Button } from "@/components/ui/button"
```
