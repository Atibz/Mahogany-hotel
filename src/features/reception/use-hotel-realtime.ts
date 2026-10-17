import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/lib/supabase/client";
import { subscribeToHotelOperationalChanges } from "@/features/reception/hotel-realtime-subscription";

/** Refresh cached hotel views when another authorised user changes hotel data. */
export function useHotelRealtime(hotelId?: string) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!supabase || !hotelId) return undefined;
    return subscribeToHotelOperationalChanges(supabase, queryClient, hotelId);
  }, [hotelId, queryClient]);
}
