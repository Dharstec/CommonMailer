-- Sending hours, per campaign: {"start":"10:00","end":"18:00","days":[1,2,3,4,5,6],"tz":"Asia/Kolkata"}.
-- NULL sends at any time, which is what every campaign before this did.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS send_window jsonb;
ALTER TABLE wa_campaigns ADD COLUMN IF NOT EXISTS send_window jsonb;
