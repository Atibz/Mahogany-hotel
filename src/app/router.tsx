import { createBrowserRouter, Navigate } from "react-router-dom";

import { AppShell } from "@/components/layout/app-shell";
import { DashboardPage } from "@/features/dashboard/dashboard-page";
import { SignInPage } from "@/features/auth/sign-in-page";
import { SetPasswordPage } from "@/features/auth/set-password-page";
import { ProfilePage } from "@/features/auth/profile-page";
import { SetupPage } from "@/features/auth/setup-page";
import { RequireAuth } from "@/features/auth/require-auth";
import { RequireFeature } from "@/features/auth/access-control";
import { AccountUnavailablePage } from "@/features/auth/account-unavailable-page";
import { RouteErrorPage } from "@/app/route-error-page";
import { FoliosPage } from "@/features/reception/folios-page";
import { DeparturesPage } from "@/features/reception/departures-page";
import { FinancialHistoryPage } from "@/features/reception/financial-history-page";
import { GuestsPage } from "@/features/reception/guests-page";
import { ReservationsPage } from "@/features/reception/reservations-page";
import { RoomsPage } from "@/features/reception/rooms-page";
import { MaintenancePage } from "@/features/reception/maintenance-page";
import { StaysPage } from "@/features/reception/stays-page";
import { StaffPage } from "@/features/staff/staff-page";
import { AuditRegisterPage } from "@/features/audit/audit-register-page";
import { StayPolicyPage } from "@/features/settings/stay-policy-page";
import { ReservationCancellationPolicyPage } from "@/features/settings/reservation-cancellation-policy-page";
import { BusinessAccountsPage } from "@/features/settings/business-accounts-page";
import { PosCatalogPage } from "@/features/pos/pos-catalog-page";
import { RestaurantPosPage } from "@/features/pos/restaurant-pos-page";
import { OperatingExpensesPage } from "@/features/settings/operating-expenses-page";
import { InternalBalancingPage } from "@/features/settings/internal-balancing-page";
import { InventoryPage } from "@/features/inventory/inventory-page";

export const router = createBrowserRouter([
  { path: "/sign-in", element: <SignInPage /> },
  { path: "/set-password", element: <SetPasswordPage /> },
  { path: "/setup", element: <SetupPage /> },
  { path: "/account-unavailable", element: <AccountUnavailablePage /> },
  {
    element: <RequireAuth />,
    errorElement: <RouteErrorPage />,
    children: [
      {
        path: "/",
        element: <AppShell />,
        children: [
          {
            index: true,
            element: (
              <RequireFeature feature="dashboard">
                <DashboardPage />
              </RequireFeature>
            ),
          },
          {
            path: "rooms",
            element: (
              <RequireFeature feature="rooms">
                <RoomsPage />
              </RequireFeature>
            ),
          },
          {
            path: "maintenance",
            element: (
              <RequireFeature feature="maintenance">
                <MaintenancePage />
              </RequireFeature>
            ),
          },
          {
            path: "guests",
            element: (
              <RequireFeature feature="guests">
                <GuestsPage />
              </RequireFeature>
            ),
          },
          {
            path: "reservations",
            element: (
              <RequireFeature feature="reservations">
                <ReservationsPage />
              </RequireFeature>
            ),
          },
          {
            path: "stays",
            element: (
              <RequireFeature feature="stays">
                <StaysPage />
              </RequireFeature>
            ),
          },
          {
            path: "departures",
            element: (
              <RequireFeature feature="departures">
                <DeparturesPage />
              </RequireFeature>
            ),
          },
          {
            path: "folios",
            element: (
              <RequireFeature feature="folios">
                <FoliosPage />
              </RequireFeature>
            ),
          },
          {
            path: "payments",
            element: (
              <RequireFeature feature="payments">
                <FinancialHistoryPage />
              </RequireFeature>
            ),
          },
          {
            path: "staff",
            element: (
              <RequireFeature feature="staff">
                <StaffPage />
              </RequireFeature>
            ),
          },
          {
            path: "audit",
            element: (
              <RequireFeature feature="audit">
                <AuditRegisterPage />
              </RequireFeature>
            ),
          },
          {
            path: "business-accounts",
            element: (
              <RequireFeature feature="businessAccounts">
                <BusinessAccountsPage />
              </RequireFeature>
            ),
          },
          {
            path: "expenses",
            element: (
              <RequireFeature feature="expenses">
                <OperatingExpensesPage />
              </RequireFeature>
            ),
          },
          {
            path: "internal-balancing",
            element: (
              <RequireFeature feature="internalBalancing">
                <InternalBalancingPage />
              </RequireFeature>
            ),
          },
          {
            path: "inventory",
            element: (
              <RequireFeature feature="inventory">
                <InventoryPage />
              </RequireFeature>
            ),
          },
          {
            path: "pos-catalog",
            element: (
              <RequireFeature feature="posCatalog">
                <PosCatalogPage />
              </RequireFeature>
            ),
          },
          {
            path: "restaurant-pos",
            element: (
              <RequireFeature feature="posSales">
                <RestaurantPosPage />
              </RequireFeature>
            ),
          },
          {
            path: "bar-pos",
            element: (
              <RequireFeature feature="barSales">
                <RestaurantPosPage outletType="bar" />
              </RequireFeature>
            ),
          },
          {
            path: "settings/stay-policy",
            element: (
              <RequireFeature feature="settings">
                <StayPolicyPage />
              </RequireFeature>
            ),
          },
          {
            path: "settings/reservation-cancellation-policy",
            element: (
              <RequireFeature feature="settings">
                <ReservationCancellationPolicyPage />
              </RequireFeature>
            ),
          },
          { path: "profile", element: <ProfilePage /> },
        ],
      },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);
