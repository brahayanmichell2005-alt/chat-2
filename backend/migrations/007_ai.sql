-- Etapa 5: configuración de IA, registro de uso y avisos del sistema en mensajes.

CREATE TABLE ai_settings (
  id                     text PRIMARY KEY DEFAULT 'main',
  enabled                boolean NOT NULL DEFAULT false,
  base_url               text NOT NULL DEFAULT 'http://127.0.0.1:11434',
  model                  text NOT NULL DEFAULT 'gemma4:26b',
  temperature            numeric(3,2) NOT NULL DEFAULT 0.3 CHECK (temperature BETWEEN 0 AND 2),
  max_output_tokens      integer NOT NULL DEFAULT 400 CHECK (max_output_tokens BETWEEN 50 AND 4000),
  num_ctx                integer NOT NULL DEFAULT 4096 CHECK (num_ctx BETWEEN 1024 AND 65536),
  timeout_ms             integer NOT NULL DEFAULT 120000 CHECK (timeout_ms BETWEEN 5000 AND 600000),
  history_messages       integer NOT NULL DEFAULT 12 CHECK (history_messages BETWEEN 2 AND 50),
  debounce_ms            integer NOT NULL DEFAULT 4000 CHECK (debounce_ms BETWEEN 0 AND 30000),
  max_tool_steps         integer NOT NULL DEFAULT 3 CHECK (max_tool_steps BETWEEN 1 AND 6),
  greeting_pause_minutes integer NOT NULL DEFAULT 360 CHECK (greeting_pause_minutes BETWEEN 1 AND 10080),
  contingency_message    text NOT NULL DEFAULT 'Gracias por escribirnos. Una persona del equipo te atenderá en cuanto esté disponible.',
  extra_instructions     text NOT NULL DEFAULT '',
  updated_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at             timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ai_settings (id) VALUES ('main');

CREATE TABLE ai_usage_logs (
  id              bigserial PRIMARY KEY,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  message_id      uuid,
  model           text,
  prompt_version  text,
  outcome         text NOT NULL CHECK (outcome IN ('replied', 'handoff', 'contingency', 'skipped', 'dry_run')),
  detail          text,
  latency_ms      integer,
  tokens_in       integer,
  tokens_out      integer,
  tools           text[] NOT NULL DEFAULT '{}',
  intents         text[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_logs_created_idx ON ai_usage_logs (created_at DESC);

-- Mensajes de aviso del sistema (p. ej. "te paso con una persona") que se envían aunque la conversación pase a control humano.
ALTER TABLE messages ADD COLUMN is_notice boolean NOT NULL DEFAULT false;
