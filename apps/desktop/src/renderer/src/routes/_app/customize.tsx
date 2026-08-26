import { RiEqualizerLine } from "@remixicon/react";
import { createFileRoute } from "@tanstack/react-router";
import { CustomizePage } from "../../components/customize-page";

export const Route = createFileRoute("/_app/customize")({
  component: CustomizeRoute,
});

function CustomizeRoute() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-8 pt-6 pb-12">
      <div className="flex items-center gap-2">
        <RiEqualizerLine />
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Customize</h1>
      </div>
      <CustomizePage />
    </div>
  );
}
