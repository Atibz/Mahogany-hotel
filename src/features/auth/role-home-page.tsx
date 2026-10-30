import { Navigate } from "react-router-dom";

import { PageLoading } from "@/components/shared/page-state";
import { DashboardPage } from "@/features/dashboard/dashboard-page";
import { AccessDeniedPage } from "@/features/auth/access-control";
import { getHomeDestination } from "@/features/auth/access-policy";
import { useAccess } from "@/features/auth/use-access";

export function RoleHomePage() {
  const { isLoading, canAccess, roleCodes } = useAccess();
  if (isLoading) return <PageLoading />;
  if (canAccess("dashboard")) return <DashboardPage />;

  const destination = getHomeDestination(roleCodes);
  return destination ? <Navigate to={destination} replace /> : <AccessDeniedPage />;
}
