# React + Next.js Example

This example is a small React app built with Next.js and Convex.

It does not use a plain `index.html` entrypoint. The app lives in the Next.js
`app/` directory and uses the App Router.

## Stack

- React
- Next.js App Router
- Convex React client
- local Convex backend in [`convex`](./convex)

## Run

From the repository root:

```bash
pnpm install
pnpm dev
```

That starts:

- the React + Next.js frontend at [http://127.0.0.1:3000](http://127.0.0.1:3000)
- the local Convex backend

## Files

- [`app/page.tsx`](./app/page.tsx): server entry for the page
- [`app/ui/example-client.tsx`](./app/ui/example-client.tsx): main client-side React UI
- [`app/globals.css`](./app/globals.css): styling
- [`convex/smoke.ts`](./convex/smoke.ts): example Convex actions using the component
