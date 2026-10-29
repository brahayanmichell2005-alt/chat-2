-- Etapa 4: sesión de WhatsApp, cola de salida sobre messages, transferencias a personas y notificaciones.

CREATE TABLE whatsapp_sessions (
  id                text PRIMARY KEY DEFAULT 'main',
  status            text NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected', 'connecting', 'qr', 'connected', 'error')),
  last_connected_at timestamptz,
  last_error        text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
INSERT INTO whatsapp_sessions (id) VALUES ('main');

ALTER TABLE messages
  ADD COLUMN attempts        integer NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN last_error      text,
  ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX messages_idem_uq ON messages (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX messages_outbox_idx ON messages (created_at) WHERE direction = 'out' AND status IN ('queued', 'sending');
ALTER TABLE messages ADD CONSTRAINT messages_status_chk
  CHECK (status IN ('received', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'uncertain', 'blocked', 'cancelled'));

CREATE TABLE human_handoffs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id      uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  reason               text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  requested_by         text NOT NULL CHECK (requested_by IN ('ai', 'user', 'customer', 'system')),
  requested_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  assigned_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at           timestamptz NOT NULL DEFAULT now(),
  ended_at             timestamptz,
  ended_by             uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX human_handoffs_one_open ON human_handoffs (conversation_id) WHERE ended_at IS NULL;
CREATE INDEX human_handoffs_conv_idx ON human_handoffs (conversation_id, started_at DESC);

CREATE TABLE notification_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_events_user_idx ON notification_events (user_id, read_at, created_at DESC);
