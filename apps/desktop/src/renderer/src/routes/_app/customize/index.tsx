import { RiEqualizerLine } from "@remixicon/react";
import { createFileRoute } from "@tanstack/react-router";
import { CustomizePage } from "../../../components/customize-page";

export const Route = createFileRoute("/_app/customize/")({
  component: CustomizeIndex,
});

function CustomizeIndex() {
  return (
    <>
      <div className="flex items-center gap-2">
        <RiEqualizerLine />
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Customize</h1>
      </div>
      <CustomizePage />
    </>
  );
}
