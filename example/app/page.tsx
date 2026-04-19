import ExampleClient from "./ui/example-client";

const convexUrl =
  process.env.NEXT_PUBLIC_CONVEX_URL ?? process.env.VITE_CONVEX_URL ?? "";

export default function Page() {
  return <ExampleClient convexUrl={convexUrl} />;
}
