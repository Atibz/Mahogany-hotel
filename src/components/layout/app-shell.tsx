import {
  BedDouble,
  Building2,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  CircleHelp,
  ClipboardList,
  ChartNoAxesCombined,
  LayoutDashboard,
  Package,
  LogOut,
  Menu,
  ReceiptText,
  ScrollText,
  Settings,
  Wrench,
  UserCircle,
  Users,
  WalletCards,
  Utensils,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

import { supabase } from "@/lib/supabase/client";
import type { Feature } from "@/features/auth/access-policy";
import { useAccess } from "@/features/auth/use-access";
import { NotificationCenter } from "@/components/layout/notification-center";
import { useActiveHotel } from "@/features/reception/use-reception";
import { useHotelRealtime } from "@/features/reception/use-hotel-realtime";
import { HelpCenter } from "@/components/layout/help-center";

const navigation = [
  {
    group: "Overview",
    label: "Dashboard",
    to: "/",
    icon: LayoutDashboard,
    feature: "dashboard",
  },
  {
    group: "Front desk",
    label: "Reservations",
    to: "/reservations",
    icon: CalendarDays,
    feature: "reservations",
  },
  {
    group: "Front desk",
    label: "Check-in",
    to: "/stays",
    icon: ClipboardList,
    feature: "stays",
  },
  {
    group: "Front desk",
    label: "Departures",
    to: "/departures",
    icon: CalendarCheck,
    feature: "departures",
  },
  {
    group: "Front desk",
    label: "Guests",
    to: "/guests",
    icon: Users,
    feature: "guests",
  },
  {
    group: "Operations",
    label: "Rooms",
    to: "/rooms",
    icon: BedDouble,
    feature: "rooms",
  },
  {
    group: "Operations",
    label: "Maintenance",
    to: "/maintenance",
    icon: Wrench,
    feature: "maintenance",
  },
  {
    group: "Operations",
    label: "Inventory",
    to: "/inventory",
    icon: Package,
    feature: "inventory",
  },
  {
    group: "Finance",
    label: "Folios & night audit",
    to: "/folios",
    icon: WalletCards,
    feature: "folios",
  },
  {
    group: "Finance",
    label: "Payments & receipts",
    to: "/payments",
    icon: WalletCards,
    feature: "payments",
  },
  {
    group: "Finance",
    label: "Business accounts",
    to: "/business-accounts",
    icon: Building2,
    feature: "businessAccounts",
  },
  {
    group: "Finance",
    label: "Operating expenses",
    to: "/expenses",
    icon: ReceiptText,
    feature: "expenses",
  },
  {
    group: "Finance",
    label: "Internal balancing",
    to: "/internal-balancing",
    icon: ChartNoAxesCombined,
    feature: "internalBalancing",
  },
  {
    group: "Food & beverage",
    label: "Restaurant POS",
    to: "/restaurant-pos",
    icon: Utensils,
    feature: "posSales",
  },
  {
    group: "Food & beverage",
    label: "Bar POS",
    to: "/bar-pos",
    icon: Utensils,
    feature: "barSales",
  },
  {
    group: "Food & beverage",
    label: "POS catalog",
    to: "/pos-catalog",
    icon: Utensils,
    feature: "posCatalog",
  },
  {
    group: "Administration",
    label: "Staff & access",
    to: "/staff",
    icon: Users,
    feature: "staff",
  },
  {
    group: "Administration",
    label: "Audit register",
    to: "/audit",
    icon: ScrollText,
    feature: "audit",
  },
  {
    group: "Administration",
    label: "Stay policy",
    to: "/settings/stay-policy",
    icon: Settings,
    feature: "settings",
  },
  {
    group: "Administration",
    label: "Cancellation policy",
    to: "/settings/reservation-cancellation-policy",
    icon: Settings,
    feature: "settings",
  },
] satisfies {
  group: string;
  label: string;
  to: string;
  icon: typeof LayoutDashboard;
  feature: Feature;
}[];

export function AppShell() {
  const location = useLocation();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const closeHelp = useCallback(() => setIsHelpOpen(false), []);
  const { canAccess, roleCodes } = useAccess();
  const hotel = useActiveHotel();
  useHotelRealtime(hotel.data?.id);
  const visibleNavigation = navigation.filter(({ feature }) =>
    canAccess(feature),
  );
  const navigationGroups = [
    ...new Set(visibleNavigation.map(({ group }) => group)),
  ];
  const primaryRole = roleCodes[0]?.replaceAll("_", " ") ?? "Staff";

  useEffect(() => {
    const pageName = location.pathname === "/profile"
      ? "My profile"
      : navigation.find(({ to }) => to === location.pathname)?.label ?? "Hotel operations";
    document.title = `${pageName} | Mahogany Hotel`;
  }, [location.pathname]);

  async function handleSignOut() {
    await supabase?.auth.signOut();
  }

  return (
    <div className="min-h-screen bg-[#f7f5f2] text-stone-900">
      <aside
        className={`fixed inset-y-0 left-0 z-30 flex w-72 flex-col border-r border-stone-200/80 bg-white px-4 py-5 shadow-sm transition-transform lg:translate-x-0 ${
          isMenuOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="rounded-2xl border border-stone-200 bg-white px-4 py-3 shadow-sm">
          <img
            src="/mahogany-logo.png"
            alt="Mahogany Hotel & Suites"
            className="h-17 w-full object-contain"
          />
          <p className="mt-1 text-center text-xs font-medium text-stone-500">Operations platform</p>
        </div>

        <nav
          className="mt-6 flex-1 space-y-5 overflow-y-auto px-1 pb-4"
          aria-label="Primary navigation"
        >
          {navigationGroups.map((group) => (
            <div key={group}>
              <p className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-[0.16em] text-stone-400">
                {group}
              </p>
              <div className="space-y-1">
                {visibleNavigation
                  .filter((item) => item.group === group)
                  .map(({ label, to, icon: Icon }) => (
                    <NavLink
                      key={to}
                      to={to}
                      onClick={() => setIsMenuOpen(false)}
                      className={({ isActive }) =>
                        `group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all ${
                          isActive
                            ? "bg-amber-50 text-amber-950 shadow-sm ring-1 ring-amber-100"
                            : "text-stone-600 hover:bg-stone-100 hover:text-stone-950"
                        }`
                      }
                    >
                      <Icon
                        className="size-4 transition-transform group-hover:scale-110"
                        aria-hidden="true"
                      />
                      {label}
                    </NavLink>
                  ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t border-stone-100 pt-3">
          <NavLink
            to="/profile"
            onClick={() => setIsMenuOpen(false)}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${isActive ? "bg-amber-50 text-amber-950" : "text-stone-600 hover:bg-stone-100 hover:text-stone-950"}`
            }
          >
            <UserCircle className="size-4" aria-hidden="true" />
            My profile
          </NavLink>

          <button
            type="button"
            onClick={handleSignOut}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-stone-600 hover:bg-red-50 hover:text-red-700"
          >
            <LogOut className="size-4" aria-hidden="true" />
            Sign out
          </button>
        </div>
      </aside>

      {isMenuOpen && (
        <button
          type="button"
          className="fixed inset-0 z-20 bg-stone-950/30 lg:hidden"
          aria-label="Close navigation"
          onClick={() => setIsMenuOpen(false)}
        />
      )}

      <div className="min-h-screen lg:pl-72">
        <header className="sticky top-0 z-10 flex h-[4.5rem] items-center gap-2 border-b border-stone-200/80 bg-[#f7f5f2]/90 px-5 backdrop-blur-xl lg:px-8">
          <button
            type="button"
            className="grid size-10 place-items-center rounded-lg text-stone-700 hover:bg-stone-200 lg:hidden"
            aria-label={isMenuOpen ? "Close navigation" : "Open navigation"}
            onClick={() => setIsMenuOpen((open) => !open)}
          >
            {isMenuOpen ? (
              <X className="size-5" />
            ) : (
              <Menu className="size-5" />
            )}
          </button>
          <div className="ml-2 lg:ml-0">
            <p className="text-sm font-semibold text-stone-800">
              {hotel.data?.trading_name ?? "Hotel operations"}
            </p>
            <p className="flex items-center gap-1.5 text-xs capitalize text-stone-500">
              <CalendarClock className="size-3.5" />
              {new Intl.DateTimeFormat("en-NG", {
                weekday: "short",
                day: "numeric",
                month: "short",
                year: "numeric",
              }).format(new Date())}
              <span className="text-stone-300">•</span>
              {primaryRole}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setIsHelpOpen(true)}
            aria-haspopup="dialog"
            className="ml-auto inline-flex items-center gap-2 rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm font-semibold text-stone-700 shadow-sm transition hover:border-amber-300 hover:bg-amber-50 hover:text-amber-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700 focus-visible:ring-offset-2"
          >
            <CircleHelp className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">Help</span>
          </button>
          <NotificationCenter />
        </header>
        <main className="mx-auto w-full max-w-[90rem] p-4 sm:p-6 lg:p-8">
          <Outlet />
        </main>
      </div>
      <HelpCenter open={isHelpOpen} onClose={closeHelp} />
    </div>
  );
}
