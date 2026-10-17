# Guest arrival email setup

The Reservations list has a staff-initiated **Email arrival details** action. It sends only the selected pending/confirmed reservation, and only when the guest has an email address. It does not send automatically when a reservation is created. Provider acceptance is audited and cannot be sent a second time for the same arrival date through this action. Provider acceptance does not guarantee delivery to the guest's inbox; check delivery/bounce status with the provider during testing.

## Provider configuration

This integration uses Resend's email API. Before enabling delivery:

1. Create a Resend account and verify a sender domain controlled by the hotel or its owner.
2. Create an API key with permission to send email.
3. In the Supabase project, open **Edge Functions → Secrets** and add:
   - `RESEND_API_KEY`: the provider API key.
   - `ARRIVAL_EMAIL_FROM`: a sender such as `Mahogany Hotel <reservations@your-verified-domain.com>` using the verified domain.
4. Deploy the `send-arrival-email` Edge Function and apply the included database migration.
5. Use a controlled test reservation and an address owned by the hotel team first. Confirm receipt, sender display, links/formatting, and the audit event before enabling routine guest use.

Do not put the Resend API key in a browser environment file, source control, or this application’s `VITE_` variables. Do not paste it into chat. The Edge Function reads it from Supabase’s server-side secrets.

If the provider or sender is not configured, the action returns a clear setup error and does not create a delivery record or attempt to contact a guest. Provider responses are not exposed to the browser beyond a safe status message.

## Message contents

The email contains the hotel name, reservation reference, arrival/departure dates, room type, assigned room (if any), and configured hotel contact details. It does not contain payment details, cancellation-fee claims, ID information, or a payment link. All reservation data is looked up server-side; the browser cannot choose the recipient or alter the message content.
