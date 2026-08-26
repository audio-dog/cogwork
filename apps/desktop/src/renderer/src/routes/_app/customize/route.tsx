import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/customize")({
  component: CustomizeLayout,
});

function CustomizeLayout() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-8 pt-6 pb-12">
      <Outlet />
    </div>
  );
}
