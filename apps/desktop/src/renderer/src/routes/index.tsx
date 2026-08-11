import { createFileRoute } from "@tanstack/react-router";
import { Feed } from "../components/feed";

export const Route = createFileRoute("/")({
  component: Feed,
});
