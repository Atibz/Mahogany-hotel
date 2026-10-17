import { useQuery } from '@tanstack/react-query'

import { canRoleAccess, type Feature, type RoleCode } from '@/features/auth/access-policy'
import { useAuth } from '@/features/auth/auth-provider'
import { useActiveHotel } from '@/features/reception/use-reception'
import { supabase } from '@/lib/supabase/client'

export function useAccess() {
  const { session } = useAuth(); const hotel = useActiveHotel()
  const roles = useQuery({ queryKey: ['my-hotel-roles', hotel.data?.id, session?.user.id], enabled: Boolean(supabase && hotel.data?.id && session?.user.id), queryFn: async () => {
    if (!supabase || !hotel.data || !session) return [] as RoleCode[]
    const { data: assignments, error: assignmentError } = await supabase.from('user_roles').select('role_id').eq('profile_id', session.user.id)
    if (assignmentError) throw assignmentError
    const ids = (assignments ?? []).map((assignment) => assignment.role_id); if (!ids.length) return [] as RoleCode[]
    const { data, error } = await supabase.from('roles').select('code').eq('hotel_id', hotel.data.id).in('id', ids).eq('active', true)
    if (error) throw error
    return (data ?? []).map((role) => role.code as RoleCode)
  } })
  const roleCodes = roles.data ?? []
  return { isLoading: hotel.isLoading || roles.isLoading, error: hotel.error ?? roles.error, roleCodes, canAccess: (feature: Feature) => canRoleAccess(roleCodes, feature) }
}
