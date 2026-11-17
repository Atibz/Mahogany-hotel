import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildOwnerDailyCloseEmail } from "./report.ts";

Deno.serve(async (request) => {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
  const token = Deno.env.get("OWNER_REPORT_CRON_SECRET");
  if (!token || token.length < 32 || request.headers.get("x-owner-report-token") !== token) {
    return Response.json({ error: "Unauthorised" }, { status: 401 });
  }
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const sender = Deno.env.get("OWNER_REPORT_EMAIL_FROM");
  if (!url || !serviceKey || !resendKey || !sender) {
    return Response.json({ error: "Private report sender is not configured" }, { status: 503 });
  }
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: jobs, error: claimError } = await admin.rpc("claim_owner_daily_close_email");
  if (claimError) return Response.json({ error: "Could not claim a report job" }, { status: 500 });
  const job = jobs?.[0];
  if (!job) {
    const { data: alerts, error: alertError } = await admin.rpc("claim_owner_missing_close_alert");
    if (alertError) return Response.json({ error: "Could not claim a missing-close alert" }, { status: 500 });
    const alert = alerts?.[0];
    if (!alert) return Response.json({ processed: 0 });

    const retryAlert = async (message: string) => {
      await admin.from("owner_missing_close_alert_jobs").update({
        status: "pending", locked_until: null, last_error: message,
        next_attempt_at: new Date(Date.now() + Math.min(24 * 60, 2 ** Math.min(alert.attempts, 10)) * 60_000).toISOString(),
      }).eq("id", alert.id).eq("status", "sending");
      return Response.json({ error: message }, { status: 502 });
    };

    try {
      // A manager may have closed the day while the alert was being claimed.
      const { data: lateClose, error: closeError } = await admin.from("business_day_closes")
        .select("id").eq("hotel_id", alert.hotel_id).eq("business_date", alert.business_date).maybeSingle();
      if (closeError) return await retryAlert("Could not verify missing-close status");
      if (lateClose) {
        await admin.from("owner_missing_close_alert_jobs").update({ status: "resolved", locked_until: null })
          .eq("id", alert.id).eq("status", "sending");
        return Response.json({ processed: 0, resolved: 1 });
      }
      const { data: hotel, error: hotelError } = await admin.from("hotels")
        .select("trading_name").eq("id", alert.hotel_id).single();
      if (hotelError || !hotel) return await retryAlert("Hotel details are unavailable");
      const { data: role, error: roleError } = await admin.from("roles")
        .select("id").eq("hotel_id", alert.hotel_id).eq("code", "owner").eq("active", true).single();
      if (roleError || !role) return await retryAlert("Exactly one active owner role is required");
      const { data: assignments, error: assignmentError } = await admin.from("user_roles")
        .select("profile_id, profiles!inner(active)").eq("role_id", role.id).eq("profiles.active", true);
      if (assignmentError || assignments?.length !== 1) return await retryAlert("Exactly one active owner account is required");
      const { data: owner, error: ownerError } = await admin.auth.admin.getUserById(assignments[0].profile_id);
      if (ownerError || !owner.user?.email) return await retryAlert("Owner email is unavailable");

      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json",
          "Idempotency-Key": `owner-missing-close/${alert.hotel_id}/${alert.business_date}` },
        body: JSON.stringify({
          from: sender, to: [owner.user.email],
          subject: `${hotel.trading_name}: business day ${alert.business_date} not closed`,
          text: `${hotel.trading_name}'s business day ${alert.business_date} has not been closed.\n\n` +
            "The private daily summary cannot be issued until a manager completes the day close. " +
            "Please ask the General Manager to review night audit, pending payments and cash handovers, then close the day. " +
            "This is a missing-close alert, not a financial report.\n",
        }),
      });
      if (!response.ok) return await retryAlert(`Email provider rejected missing-close alert (HTTP ${response.status})`);
      const provider = await response.json().catch(() => ({}));
      const { error: completedError } = await admin.from("owner_missing_close_alert_jobs").update({
        status: "sent", sent_at: new Date().toISOString(), locked_until: null,
        provider_message_id: typeof provider.id === "string" ? provider.id : null,
      }).eq("id", alert.id).eq("status", "sending");
      if (completedError) return Response.json({ error: "Provider accepted alert but delivery record was not completed" }, { status: 500 });
      return Response.json({ processed: 1, kind: "missing_close" });
    } catch {
      return await retryAlert("Private missing-close alert delivery failed; retry scheduled");
    }
  }

  const retry = async (message: string) => {
    await admin.from("owner_daily_close_email_jobs").update({
      status: "pending", locked_until: null, last_error: message,
      next_attempt_at: new Date(Date.now() + Math.min(24 * 60, 2 ** Math.min(job.attempts, 10)) * 60_000).toISOString(),
    }).eq("id", job.id).eq("status", "sending");
    return Response.json({ error: message }, { status: 502 });
  };

  try {
    const { data: close, error: closeError } = await admin.from("business_day_closes")
      .select("id, hotel_id, business_date, snapshot").eq("id", job.close_id).eq("hotel_id", job.hotel_id).single();
    if (closeError || !close) return await retry("Close snapshot unavailable");
    const { data: role, error: roleError } = await admin.from("roles")
      .select("id").eq("hotel_id", job.hotel_id).eq("code", "owner").eq("active", true).single();
    if (roleError || !role) return await retry("Exactly one active owner role is required");
    const { data: assignments, error: assignmentError } = await admin.from("user_roles")
      .select("profile_id, profiles!inner(active)").eq("role_id", role.id).eq("profiles.active", true);
    if (assignmentError || assignments?.length !== 1) return await retry("Exactly one active owner account is required");
    const { data: owner, error: ownerError } = await admin.auth.admin.getUserById(assignments[0].profile_id);
    if (ownerError || !owner.user?.email) return await retry("Owner email is unavailable");
    const { data: movements, error: movementsError } = await admin.rpc("get_owner_private_daily_movements", {
      target_hotel_id: job.hotel_id, target_date: close.business_date,
    });
    if (movementsError || !movements) return await retry("Private daily movements are unavailable");
    const { data: selfReviews, error: selfReviewsError } = await admin.rpc("get_owner_private_self_reviews", {
      target_hotel_id: job.hotel_id, target_date: close.business_date,
    });
    if (selfReviewsError || !selfReviews) return await retry("Private self-review summary is unavailable");
    const report = buildOwnerDailyCloseEmail(close.snapshot, { ...movements, self_reviews: selfReviews });
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json", "Idempotency-Key": `owner-day-close/${close.id}` },
      body: JSON.stringify({ from: sender, to: [owner.user.email], subject: report.subject, text: report.text }),
    });
    if (!response.ok) return await retry(`Email provider rejected report (HTTP ${response.status})`);
    const provider = await response.json().catch(() => ({}));
    const { error: completedError } = await admin.from("owner_daily_close_email_jobs").update({
      status: "sent", sent_at: new Date().toISOString(), locked_until: null,
      provider_message_id: typeof provider.id === "string" ? provider.id : null,
    }).eq("id", job.id).eq("status", "sending");
    if (completedError) return Response.json({ error: "Provider accepted report but delivery record was not completed" }, { status: 500 });
    return Response.json({ processed: 1 });
  } catch {
    return await retry("Private report delivery failed; retry scheduled");
  }
});
