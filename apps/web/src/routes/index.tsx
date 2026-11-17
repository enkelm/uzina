import { createFileRoute } from "@tanstack/react-router";
import { App } from "../main";

export type WorkSearch = { project?: string; work?: string };

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): WorkSearch => ({
    project:
      typeof search.project === "string" && search.project.length <= 128
        ? search.project
        : undefined,
    work:
      typeof search.work === "string" && search.work.length <= 128
        ? search.work
        : undefined,
  }),
  ssr: false,
  component: App,
});
