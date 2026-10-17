import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS")
    return new Response("ok", { headers: cors });
  const auth = request.headers.get("Authorization") ?? "";
  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
  });
  const {
    data: { user },
  } = await caller.auth.getUser();
  if (!user)
    return Response.json(
      { error: "Unauthorised" },
      { status: 401, headers: cors },
    );
  const { email, fullName, hotelId, roleId, redirectTo } = await request.json();
  const { data: allowed } = await caller.rpc("has_hotel_permission", {
    target_hotel_id: hotelId,
    required_code: "staff.manage",
  });
  if (!allowed)
    return Response.json(
      { error: "Not authorised to invite staff" },
      { status: 403, headers: cors },
    );
  const { data: role } = await admin
    .from("roles")
    .select("code")
    .eq("id", roleId)
    .eq("hotel_id", hotelId)
    .maybeSingle();
  if (
    !role ||
    (role.code === "owner" &&
      !(
        await caller.rpc("has_hotel_permission", {
          target_hotel_id: hotelId,
          required_code: "owner",
        })
      ).data)
  )
    return Response.json(
      { error: "Invalid role" },
      { status: 400, headers: cors },
    );
  if (typeof redirectTo !== "string" || !redirectTo.startsWith("http")) {
    return Response.json(
      { error: "A valid invitation redirect address is required" },
      { status: 400, headers: cors },
    );
  }
  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { full_name: fullName },
    redirectTo,
  });
  if (error || !data.user)
    return Response.json(
      { error: error?.message ?? "Invite failed" },
      { status: 400, headers: cors },
    );
  const { error: roleError } = await admin
    .from("user_roles")
    .insert({ profile_id: data.user.id, role_id: roleId, created_by: user.id });
  if (roleError) {
    await admin.auth.admin.deleteUser(data.user.id);
    return Response.json(
      { error: "The staff role could not be assigned" },
      { status: 500, headers: cors },
    );
  }
  const { error: auditError } = await admin.from("activity_logs").insert({
    hotel_id: hotelId,
    actor_id: user.id,
    action: "staff.invited",
    entity_type: "profile",
    entity_id: data.user.id,
    metadata: {
      email,
      full_name: fullName,
      role_id: roleId,
      role_code: role.code,
    },
  });
  if (auditError) {
    await admin
      .from("user_roles")
      .delete()
      .eq("profile_id", data.user.id)
      .eq("role_id", roleId);
    await admin.auth.admin.deleteUser(data.user.id);
    return Response.json(
      { error: "The invitation audit record could not be created" },
      { status: 500, headers: cors },
    );
  }
  return Response.json({ userId: data.user.id }, { headers: cors });
});
