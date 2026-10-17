import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: cors });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function readableDate(value: string) {
  const date = new Date(`${value}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-NG", {
    dateStyle: "long",
    timeZone: "Africa/Lagos",
  }).format(date);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS")
    return new Response("ok", { headers: cors });
  if (request.method !== "POST")
    return json({ error: "Method not allowed" }, 405);

  const authorization = request.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer "))
    return json({ error: "Sign in before sending an arrival email" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey =
    Deno.env.get("SUPABASE_ANON_KEY") ??
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const sender = Deno.env.get("ARRIVAL_EMAIL_FROM");
  if (!supabaseUrl || !publishableKey)
    return json({ error: "Email service is not configured on the server" }, 503);

  const caller = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await caller.auth.getUser();
  if (authError || !authData.user)
    return json({ error: "Your session has expired. Sign in again." }, 401);

  if (!resendApiKey || !sender)
    return json(
      { error: "Guest email is not enabled yet. Configure the email provider first." },
      503,
    );

  let reservationId: unknown;
  try {
    ({ reservationId } = await request.json());
  } catch {
    return json({ error: "A valid reservation ID is required" }, 400);
  }
  if (
    typeof reservationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      reservationId,
    )
  )
    return json({ error: "A valid reservation ID is required" }, 400);

  const { data: bookingRows, error: claimError } = await caller.rpc(
    "claim_guest_arrival_email",
    { target_reservation_id: reservationId },
  );
  const booking = Array.isArray(bookingRows) ? bookingRows[0] : null;
  if (claimError || !booking) {
    return json(
      { error: claimError?.message ?? "Reservation email could not be prepared" },
      400,
    );
  }

  const guestName = escapeHtml(String(booking.guest_name));
  const hotelName = escapeHtml(String(booking.hotel_name));
  const reservationNumber = escapeHtml(String(booking.reservation_number));
  const roomTypeName = escapeHtml(String(booking.room_type_name));
  const roomNumber = booking.room_number
    ? escapeHtml(String(booking.room_number))
    : null;
  const checkIn = readableDate(String(booking.check_in_date));
  const checkOut = readableDate(String(booking.check_out_date));
  const checkInTime = booking.check_in_time
    ? ` from ${escapeHtml(String(booking.check_in_time).slice(0, 5))}`
    : "";
  const roomText = roomNumber
    ? `${roomTypeName} (Room ${roomNumber})`
    : roomTypeName;
  const contactLines = [booking.hotel_phone, booking.hotel_email]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => escapeHtml(String(value)));
  const contactHtml = contactLines.length
    ? `<p style="color:#57534e;font-size:14px">Questions? Contact ${contactLines.join(" · ")}.</p>`
    : "";
  const text = [
    `Hello ${booking.guest_name},`,
    "",
    `We look forward to welcoming you to ${booking.hotel_name}.`,
    `Reservation: ${booking.reservation_number}`,
    `Arrival: ${checkIn}${checkInTime}`,
    `Departure: ${checkOut}`,
    `Room: ${roomText}`,
    "",
    "Please contact the hotel if any of these details need to be corrected.",
    ...contactLines.map((line) => `Contact: ${line}`),
    "",
    `Thank you, ${booking.hotel_name}`,
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f4;font-family:Arial,sans-serif;color:#1c1917"><main style="max-width:600px;margin:32px auto;padding:32px;background:#fff;border:1px solid #e7e5e4;border-radius:16px"><p style="color:#92400e;font-weight:700">${hotelName}</p><h1 style="font-size:24px">We look forward to welcoming you, ${guestName}</h1><p>Your arrival details are below. Please contact the hotel if anything needs to be corrected.</p><table style="width:100%;border-collapse:collapse;margin:24px 0"><tr><td style="padding:10px;border-bottom:1px solid #e7e5e4;color:#57534e">Reservation</td><td style="padding:10px;border-bottom:1px solid #e7e5e4;font-weight:700">${reservationNumber}</td></tr><tr><td style="padding:10px;border-bottom:1px solid #e7e5e4;color:#57534e">Arrival</td><td style="padding:10px;border-bottom:1px solid #e7e5e4">${escapeHtml(checkIn)}${checkInTime}</td></tr><tr><td style="padding:10px;border-bottom:1px solid #e7e5e4;color:#57534e">Departure</td><td style="padding:10px;border-bottom:1px solid #e7e5e4">${escapeHtml(checkOut)}</td></tr><tr><td style="padding:10px;color:#57534e">Room</td><td style="padding:10px">${roomText}</td></tr></table>${contactHtml}<p style="margin-top:28px">Thank you,<br><strong>${hotelName}</strong></p></main></body></html>`;

  const idempotencyKey = `arrival-reminder/${reservationId}/${booking.check_in_date}`;
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        from: sender,
        to: [booking.guest_email],
        subject: `Your upcoming stay at ${booking.hotel_name}`,
        text,
        html,
      }),
    });
  } catch {
    await caller.rpc("fail_guest_arrival_email", {
      target_delivery_id: booking.delivery_id,
      provider_http_status_value: null,
    });
    return json({ error: "The email provider could not be reached. You can retry." }, 502);
  }

  if (!response.ok) {
    await caller.rpc("fail_guest_arrival_email", {
      target_delivery_id: booking.delivery_id,
      provider_http_status_value: response.status,
    });
    return json(
      {
        error: `The email provider rejected the message (HTTP ${response.status}). Check the sender setup and try again.`,
      },
      502,
    );
  }

  const providerResult = await response.json().catch(() => ({}));
  const providerMessageId =
    typeof providerResult.id === "string" ? providerResult.id : null;
  const { error: completionError } = await caller.rpc(
    "complete_guest_arrival_email",
    {
      target_delivery_id: booking.delivery_id,
      provider_message_id_value: providerMessageId,
    },
  );
  if (completionError)
    return json(
      { error: "The email was accepted by the provider, but its audit record could not be completed. Contact a manager before retrying." },
      500,
    );

  return json({ accepted: true, recipient: booking.guest_email });
});
