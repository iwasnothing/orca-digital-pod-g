import { createFileRoute } from "@tanstack/react-router";
import { PodApp } from "@/components/orca/pod-app";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <PodApp />;
}
